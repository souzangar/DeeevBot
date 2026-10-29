// @critical-path
// /attach (critical invariants 1, 2, 4 and 5; the MVP plan, section 4, "The
// post"; doc/product/report-lifecycle.md, "Ambiguous and unambiguous
// failures"): after an ambiguous send, a human who found the post in the
// channel records its message id, so that the report's closure and
// retraction edit that post. `/attach <id> <message id, or the post's
// t.me/c/<channel>/<message id> link>`, from an admin in the venue or a
// keyholder in their own chat; under lockdown from a keyholder only (the
// gates of src/telegram/registry.ts; an admin's attach also re-reads the
// switch before its probe and binds it in its write).
// The message is verified before anything is written, by facts Telegram
// returns about it, never by its keyboard: a keyboard is what this very
// probe changes, and a probe whose answer was lost after Telegram applied it
// can leave its keyboard behind.
// 1. The report is posting, without a message id, under a live approval.
// 2. No other report holds that message (`post_message_id` is UNIQUE): such
//    a message is refused before any call, so no recorded post is touched.
// 3. The probe: editMessageReplyMarkup on that message of BROADCAST_CHAT_ID
//    with a probe keyboard, whose button carries no press data
//    (PROBE_KEYBOARDS: the presses parser's exact form refuses it, so a
//    press of it counts nothing), in one of two variants. Telegram answers
//    "message is not modified" only when the message carries that variant
//    already (a probe's leftover), and then the other variant is sent: that
//    answer decides nothing, and the probe always gets the message back.
// 4. The returned Message is this report's post only when all of these
//    hold: its text is the plain text of `reports.broadcast_text`
//    (samePlainText(), src/review/render-post.ts); it was sent in this
//    report's send window, from ATTACH_EARLY_MS before `posting_started_at`
//    to ATTACH_LATE_MS after it (`posting_started_at` precedes the claim's
//    round trip, and a send may be answered near the client's 20-second
//    bound); and no other report was claimed in that window (a run posts
//    one report at most, runs a minute apart). The two refusals are told
//    apart, to the operator and in the log: a text that is not this
//    report's post (`text_mismatch`), and a date outside the window or
//    another claim in it (`window_mismatch`), so a systematic text
//    mismatch against the real API shows as such and never reads as a
//    wrong message id. The deployed probe checks the text comparison
//    against Telegram itself once (ADR 0004, "The deployed probe").
// 5. Verified: the post's own keyboard (postKeyboard()) is put back, which
//    also heals a post whose button a catalog revision relabelled or a human
//    removed; then ONE batch writes `post_message_id`, `posted_at` and status
//    `posted` and clears the attention flags, while the report is still
//    posting without an id under a live approval (and, for an admin, not
//    locked down), and deletes the post job once that landed. A post whose
//    keyboard cannot be put back is not recorded: "try again", and the next
//    probe finds its probe keyboard and sends the other variant.
//    Anything else: the probe's keyboard is removed again, which gives back
//    exactly what it had to every message the bot can reach that has none
//    (a human's post, a closed or retracted post); so is it after a probe
//    Telegram answered ambiguously. The removal is tried twice, as the
//    venue's deletions are, and one that still fails is logged by class.
//    A message the bot cannot edit is refused; a 429 or an ambiguous answer
//    is refused as "try again".
// 6. The keyholders' remembered notices are edited to "posted" and, unless
//    locked down, the status card and the review card are updated as after a
//    post (src/broadcast/post.ts).
// The residuals, stated in ADR 0004: a removal that is cut off can leave a
// probe keyboard on a wrong message until the next /attach of it, which
// removes it; and a mistyped id that is ANOTHER report's post, also posting
// without an id, loses its button to the removal, which that report's own
// /attach then puts back.
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { isLockedDown, NOT_LOCKED_DOWN } from '../auth/lockdown';
import { isId } from '../db/ids';
import { concatSql, sql, type SqlValue } from '../db/sql';
import { samePlainText } from '../review/render-post';
import { classifyTelegramError } from '../telegram/errors';
import { postKeyboard, showPosted, venueFacts, type PostDeps } from './post';
import { isStorageFailure } from './state';

/** How long before `posting_started_at` a post's own message may be dated (clocks, Telegram's whole seconds). */
export const ATTACH_EARLY_MS = 10_000;
/** How long after it: the claim's round trip, and a send answered near the run's 20-second bound. */
export const ATTACH_LATE_MS = 60_000;

/** The press data of the probe's button, in two variants: no press reads either (pinned by a test). */
export const PROBE_DATA = Object.freeze(['probe:1', 'probe:2'] as const);

/** The probe's keyboards (see the header, step 3). */
export const PROBE_KEYBOARDS: readonly InlineKeyboardMarkup[] = Object.freeze(
  PROBE_DATA.map((data) => ({ inline_keyboard: [[{ text: '…', callback_data: data }]] })),
);

const READ = sql`SELECT r.status, r.post_message_id, r.posting_started_at, r.broadcast_text, r.platform, r.category, r.reporter_ref, r.card_message_id, r.status_message_id, a.approval_id, a.starts_at FROM reports AS r LEFT JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.id = ?`;
const HELD_BY_OTHER = sql`SELECT id FROM reports WHERE post_message_id = ? AND id <> ?`;
const OTHER_CLAIM = sql`SELECT id FROM reports WHERE id <> ? AND posting_started_at BETWEEN ? AND ? LIMIT 1`;
const ATTACH = sql`UPDATE reports SET status = 'posted', post_message_id = ?, posted_at = max(?, posting_started_at), needs_attention = 0, alert_sent_at = NULL WHERE id = ? AND status = 'posting' AND post_message_id IS NULL AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL)`;
const ATTACH_BY_ADMIN = concatSql(ATTACH, sql` AND `, NOT_LOCKED_DOWN);
const DROP_POST_JOB = sql`DELETE FROM jobs WHERE kind = 'post' AND report_id = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'posted' AND post_message_id = ?)`;

/** Who attaches: an admin, in the venue, or a keyholder, in their own chat. */
export type Attacher = 'admin' | 'keyholder';

/** An /attach command's argument, read. */
export type AttachRequest =
  | { readonly ok: true; readonly reportId: string; readonly messageId: number }
  | { readonly ok: false; readonly reason: 'usage' | 'other_channel' };

/** What an /attach did. */
export type AttachOutcome =
  | 'recorded'
  | 'not_found'
  | 'not_posting'
  | 'taken'
  /** The bot cannot edit the message: none in the channel, or one it may not edit. */
  | 'not_verified'
  /** The message's text is not this report's post. */
  | 'text_mismatch'
  /** The message was sent outside this report's send window, or another report was claimed in it. */
  | 'window_mismatch'
  | 'unavailable'
  | 'locked';

const MESSAGE_ID = /^[1-9][0-9]{0,15}$/;
const CHANNEL_LINK = /^(?:https:\/\/)?(?:t\.me|telegram\.me)\/c\/([0-9]{1,20})\/([0-9]{1,16})(?:[?#].*)?$/i;
const USAGE: AttachRequest = Object.freeze({ ok: false, reason: 'usage' });

/** The id a channel's t.me/c/ links carry: its chat id without the -100 in front; null for no such chat id. */
export function channelLinkId(chatId: number): string | null {
  const digits = String(-chatId);
  return chatId < 0 && digits.startsWith('100') && digits.length > 3 ? digits.slice(3) : null;
}

const messageIdOf = (text: string): number | null => {
  if (!MESSAGE_ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
};

/** Reads `/attach <id> <message>`'s argument: the message as its id, or as a t.me/c/ link of the broadcast channel. */
export function parseAttach(argument: string, broadcastChatId: number): AttachRequest {
  const parts = argument.trim().split(/\s+/);
  const [rawId, target] = parts;
  if (parts.length !== 2 || rawId === undefined || target === undefined) return USAGE;
  const reportId = rawId.toLowerCase();
  if (!isId(reportId)) return USAGE;
  const direct = messageIdOf(target);
  if (direct !== null) return { ok: true, reportId, messageId: direct };
  const link = CHANNEL_LINK.exec(target);
  if (link === null) return USAGE;
  if (link[1] !== channelLinkId(broadcastChatId)) return { ok: false, reason: 'other_channel' };
  const linked = messageIdOf(link[2] ?? '');
  return linked === null ? USAGE : { ok: true, reportId, messageId: linked };
}

interface AttachRow {
  readonly status: SqlValue;
  readonly post_message_id: SqlValue;
  readonly posting_started_at: SqlValue;
  readonly broadcast_text: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
  readonly approval_id: SqlValue;
  readonly starts_at: SqlValue;
}

/**
 * Puts `markup` on message `messageId` of the channel (none: the keyboard
 * removed), trying twice; "message is not modified" means it is there
 * already. The failure when both tries fail, else null. Never throws.
 */
async function setKeyboard(deps: PostDeps, messageId: number, markup?: InlineKeyboardMarkup): Promise<unknown> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.api.editMessageReplyMarkup(deps.config.broadcastChatId, messageId, markup === undefined ? {} : { reply_markup: markup });
      return null;
    } catch (error) {
      const { kind } = classifyTelegramError(error);
      if (kind === 'message_not_modified' || (markup === undefined && kind === 'message_not_found')) return null;
      failure = error;
    }
  }
  return failure;
}

/** Removes the probe's keyboard (see the header, step 5). Never throws. */
async function undoProbe(deps: PostDeps, reportId: string, messageId: number): Promise<void> {
  const failure = await setKeyboard(deps, messageId);
  if (failure !== null) deps.logger.logError('attach.revert_failed', failure, { reportId });
}

/** The probe of step 3: the message as Telegram returns it, or why there is none. */
async function probe(deps: PostDeps, reportId: string, messageId: number): Promise<Message | 'not_verified' | 'unavailable'> {
  for (const keyboard of PROBE_KEYBOARDS) {
    let edited: Message | true;
    try {
      edited = await deps.api.editMessageReplyMarkup(deps.config.broadcastChatId, messageId, { reply_markup: keyboard });
    } catch (error) {
      const { kind } = classifyTelegramError(error);
      // It carries this variant already, a probe's leftover: the other one.
      if (kind === 'message_not_modified') continue;
      if (kind === 'rate_limited') return 'unavailable';
      if (kind === 'transient' || kind === 'not_telegram') {
        // Telegram may have applied it: removed, so nothing of the probe stays.
        await undoProbe(deps, reportId, messageId);
        return 'unavailable';
      }
      deps.logger.logError('attach.refused', error, { reportId });
      return 'not_verified';
    }
    if (edited === true) {
      await undoProbe(deps, reportId, messageId);
      return 'not_verified';
    }
    return edited;
  }
  return 'unavailable';
}

/** Whether the probe's message is this report's post (step 4): 'post', or which test refused it. */
async function verdictOn(deps: PostDeps, reportId: string, message: Message, postingStartedAt: number, post: string): Promise<'post' | 'text' | 'window'> {
  if (message.text === undefined || !samePlainText(message.text, post)) return 'text';
  const sentAt = message.date * 1000;
  if (sentAt < postingStartedAt - ATTACH_EARLY_MS || sentAt > postingStartedAt + ATTACH_LATE_MS) return 'window';
  return (await deps.db.first(OTHER_CLAIM, [reportId, sentAt - ATTACH_LATE_MS, sentAt + ATTACH_EARLY_MS])) === null ? 'post' : 'window';
}

/** Whether the venue must be left alone: locked down, or the switch unreadable (never a guess). Never throws. */
async function lockedOrUnknown(deps: PostDeps): Promise<boolean> {
  try {
    return await isLockedDown(deps.config, deps.db);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error);
    return true;
  }
}

/**
 * Records message `messageId` of the channel as report `reportId`'s post,
 * after verifying it (see the header). Throws only a storage failure.
 */
export async function attachPost(deps: PostDeps, attacher: Attacher, reportId: string, messageId: number): Promise<AttachOutcome> {
  const row = await deps.db.first<AttachRow>(READ, [reportId]);
  if (row === null) return 'not_found';
  const { approval_id: approvalId, starts_at: startsAt, posting_started_at: postingStartedAt, broadcast_text: post } = row;
  if (
    row.status !== 'posting' ||
    row.post_message_id !== null ||
    typeof postingStartedAt !== 'number' ||
    !isId(approvalId) ||
    typeof startsAt !== 'number' ||
    typeof post !== 'string'
  ) {
    return 'not_posting';
  }
  if ((await deps.db.first(HELD_BY_OTHER, [messageId, reportId])) !== null) return 'taken';
  if (attacher === 'admin' && (await isLockedDown(deps.config, deps.db))) return 'locked';
  const probed = await probe(deps, reportId, messageId);
  if (probed === 'not_verified' || probed === 'unavailable') return probed;
  let verdict: 'post' | 'text' | 'window';
  try {
    verdict = await verdictOn(deps, reportId, probed, postingStartedAt, post);
  } catch (error) {
    await undoProbe(deps, reportId, messageId);
    throw error;
  }
  if (verdict !== 'post') {
    await undoProbe(deps, reportId, messageId);
    deps.logger.log(verdict === 'text' ? 'attach.text_mismatch' : 'attach.window_mismatch', { reportId });
    return verdict === 'text' ? 'text_mismatch' : 'window_mismatch';
  }
  const restoreFailure = await setKeyboard(deps, messageId, postKeyboard(reportId));
  if (restoreFailure !== null) {
    deps.logger.logError('attach.restore_failed', restoreFailure, { reportId });
    return 'unavailable';
  }
  let changed: number | undefined;
  try {
    const results = await deps.db.batch([
      { sql: attacher === 'admin' ? ATTACH_BY_ADMIN : ATTACH, params: [messageId, deps.clock.now(), reportId] },
      { sql: DROP_POST_JOB, params: [reportId, reportId, messageId] },
    ]);
    changed = results[0]?.changes;
  } catch (error) {
    // The UNIQUE index refused it: another report took the message meanwhile.
    if (isStorageFailure(error) && (await deps.db.first(HELD_BY_OTHER, [messageId, reportId])) !== null) return 'taken';
    throw error;
  }
  if (changed !== 1) return attacher === 'admin' && (await isLockedDown(deps.config, deps.db)) ? 'locked' : 'not_posting';
  deps.logger.log('attach.recorded', { reportId });
  await showPosted(deps, { reportId, approvalId, startsAt, venue: venueFacts(row) }, await lockedOrUnknown(deps));
  return 'recorded';
}
