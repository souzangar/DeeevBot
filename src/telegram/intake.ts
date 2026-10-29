// @critical-path
// The intake conversation's handlers (critical invariants 3, 4, 5 and 8;
// doc/product/report-lifecycle.md, "Intake" and "What the reporter is
// told"; the MVP plan, section 4). The intake entry (src/telegram/intake-entry.ts)
// hands them every private message and every intake button press, behind
// the lockdown gate; the logic they apply is src/review/intake.ts, the
// store src/review/drafts.ts.
//
// - The draft is keyed by the reporter reference of the chat id
//   (src/privacy/reporter-ref.ts): no Telegram id is ever stored. The
//   locale is the draft's (the reporter's resolved one, or their
//   /language choice), else the resolved one of the update.
// - Every message the intake takes is deleted on receipt, whatever it is
//   (src/telegram/delete-message.ts, the blanket rule outside lockdown):
//   AFTER the draft write that recorded its content committed and BEFORE
//   the step's reply is sent; refused messages (media, forwards,
//   non-links) and misplaced ones, which record nothing, at once. The
//   delete is awaited and retried once; a message already gone counts as
//   deleted; if it still fails, the reply asks the reporter to delete it
//   themselves and the failure is logged by class. If anything fails
//   before the message was deleted (a read, the membership check, the
//   write), it is deleted all the same before the error goes on to the
//   error boundary: no URL is left in the reporter's chat. A command the
//   intake does not know is deleted like every other message, and nothing
//   about it is read or written: it gets the fallback answer.
// - The replies never echo the reported URL or anything the reporter
//   wrote, and carry no link but the catalog's own, which every send and
//   edit checks again here against the link policy (src/platforms/link-policy.ts,
//   no target host allowed): a text that fails is not sent.
// - A button press is answered with answerCallbackQuery, and the pressed
//   message, the bot's own prompt in the reporter's own chat, is edited
//   into the next prompt: a press never causes a new message (critical
//   invariant 5: a direct message only as a reply to the user's own
//   message). A press that answers no current step (an old prompt, a
//   double press) is answered "already answered" and changes nothing.
// - The submit (src/review/drafts.ts) checks the limits, with membership
//   from getChatMember on the update's user id (src/auth/membership.ts,
//   never stored), and merges a duplicate of an open target. The one
//   acknowledgement is byte for byte the same for a new and a merged
//   report: it names the report by platform and date, never by its URL,
//   says that outcomes appear in the channel, and deletes itself from
//   inside the same handler, so inside the update's waitUntil on Workers,
//   at min(handlerStart + 25 s, ackSent + 20 s) (ackDeleteAt), waited for
//   on the clock port; no message id is stored for it. When the reporter's
//   label is "sexual content involving a minor", a second, persistent
//   message carries the hotline links and nothing else. A limit answers the
//   neutral `error.rate_limited`, a blocked reference included.
// - On the Node port's long polling, updates must be handled concurrently
//   (grammY's runner, unit U7): this handler waits up to 25 seconds after
//   the acknowledgement, and a sequential loop would hold every other
//   update for that long.
import type { Context } from 'grammy';
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { membershipOf, type MembershipCache } from '../auth/membership';
import { utcDay, type Clock } from '../clock';
import type { Config } from '../config/schema';
import { randomId } from '../db/ids';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { resolveLocale, t, type Locale, type PlainMessageKey } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { checkReportedLink, outgoingLinkProblems, type LinkRefusal } from '../platforms/link-policy';
import { linkHash } from '../privacy/link-hash';
import type { Logger } from '../privacy/logger';
import { reporterRef } from '../privacy/reporter-ref';
import { CATEGORIES, ROUTING } from '../review/categories';
import {
  cancelDraft,
  readDraft,
  setAccount,
  setAffected,
  setCategory,
  startDraft,
  submitReport,
} from '../review/drafts';
import {
  ackDeleteAt,
  checkComment,
  classifyMessage,
  completeDraft,
  extractLink,
  parsePress,
  pressData,
  stepAfterLink,
  stepOfPress,
  type CompleteDraft,
  type Draft,
  type IntakeInput,
  type IntakeStep,
} from '../review/intake';
import { classifyTelegramError } from './errors';
import { deleteReceivedMessage, withDeleteNote } from './delete-message';
import { answerPress } from './respond';

export interface IntakeDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The membership answers' cache: the isolate's own unless given (tests pass a fresh one). */
  readonly membershipCache?: MembershipCache;
}

/** A prompt: its text and, for a step answered by a press, its buttons. */
interface Prompt {
  readonly text: string;
  readonly keyboard?: InlineKeyboardMarkup;
}

const PROMPT_KEYS: Readonly<Record<IntakeStep, PlainMessageKey>> = {
  url: 'intake.ask_url',
  account: 'intake.ask_account',
  category: 'intake.ask_category',
  affected: 'intake.ask_affected',
  comment: 'intake.ask_comment',
};

/** What each link refusal tells the reporter. */
const REFUSAL_KEYS: Readonly<Record<LinkRefusal | 'one_link', PlainMessageKey>> = {
  not_a_link: 'intake.refused.not_a_link',
  one_link: 'intake.refused.one_link',
  scheme: 'intake.refused.link',
  userinfo: 'intake.refused.link',
  port: 'intake.refused.link',
  ip_address: 'intake.refused.link',
  not_public: 'intake.refused.link',
  host: 'intake.refused.link',
  redirector: 'intake.refused.redirector',
  telegram: 'intake.refused.telegram',
  not_a_target: 'intake.refused.not_a_target',
};

const button = (text: string, data: string) => ({ text, callback_data: data });

/** The buttons of a step answered by a press; none for a step answered by a message. */
function keyboardFor(step: IntakeStep, locale: Locale): InlineKeyboardMarkup | undefined {
  switch (step) {
    case 'account':
      return { inline_keyboard: [[button(t(locale, 'intake.button.dont_know'), pressData({ kind: 'account_unknown' }))]] };
    case 'category':
      return {
        inline_keyboard: CATEGORIES.map((category) => [
          button(t(locale, ROUTING[category].labelKey), pressData({ kind: 'category', category })),
        ]),
      };
    case 'affected':
      return {
        inline_keyboard: [
          [
            button(t(locale, 'intake.button.affected_yes'), pressData({ kind: 'affected', affected: true })),
            button(t(locale, 'intake.button.affected_no'), pressData({ kind: 'affected', affected: false })),
          ],
        ],
      };
    default:
      return undefined;
  }
}

/** The prompt of `step`, after the `lead` lines when given. */
function promptFor(step: IntakeStep, locale: Locale, ...lead: PlainMessageKey[]): Prompt {
  const text = [...lead.map((key) => t(locale, key)), t(locale, PROMPT_KEYS[step])].join('\n\n');
  const keyboard = keyboardFor(step, locale);
  return keyboard === undefined ? { text } : { text, keyboard };
}

/** No target host: an intake message may carry the catalog's own links and nothing else. */
const NO_TARGET_HOSTS: readonly string[] = Object.freeze([]);

/** `text`, after the render-time link check (see the header). */
function checked(text: string): string {
  if (outgoingLinkProblems(text, NO_TARGET_HOSTS).length > 0) {
    throw new AppError('UNEXPECTED', 'an intake message carries a link off the trusted list');
  }
  return text;
}

/** Sends `prompt` (or a bare text) to the reporter's own chat, the update's. */
const send = (ctx: Context, chatId: number, prompt: Prompt): Promise<Message.TextMessage> =>
  ctx.api.sendMessage(chatId, checked(prompt.text), prompt.keyboard === undefined ? {} : { reply_markup: prompt.keyboard });

/** One reporter message being handled: where it is, whose draft it belongs to, and the draft. */
interface Turn {
  readonly deps: IntakeDeps;
  readonly ctx: Context;
  readonly chatId: number;
  readonly messageId: number;
  /** The update's user id: membership only, never stored. */
  readonly userId: number;
  readonly key: string;
  readonly draft: Draft | null;
  readonly locale: Locale;
  readonly handlerStart: number;
  /** The message's deletion, tried once per turn (with its retry), shared by every copy of the turn. */
  readonly deletion: { attempt: Promise<boolean> | undefined };
}

/** Deletes the turn's message, once per turn (see the header); true when it is gone. */
const deleteTurnMessage = (turn: Turn): Promise<boolean> => {
  turn.deletion.attempt ??= deleteReceivedMessage(turn.ctx.api, turn.deps.logger, turn.chatId, turn.messageId);
  return turn.deletion.attempt;
};

/** Deletes the turn's message, then sends `prompt` with the note when the delete failed. */
async function deleteThenReply(turn: Turn, prompt: Prompt): Promise<void> {
  const deleted = await deleteTurnMessage(turn);
  await send(turn.ctx, turn.chatId, { ...prompt, text: withDeleteNote(turn.locale, prompt.text, deleted) });
}

/** The current step's prompt again, after `lead`. */
const repeat = (turn: Turn, lead: PlainMessageKey): Promise<void> =>
  deleteThenReply(turn, promptFor(turn.draft?.step ?? 'url', turn.locale, lead));

/** The URL step: the reported link, screened by the link policy, starts the draft. */
async function urlStep(turn: Turn, text: string): Promise<void> {
  const { deps } = turn;
  const candidate = extractLink(text);
  if (!candidate.ok) return repeat(turn, REFUSAL_KEYS[candidate.refusal]);
  const analysis = checkReportedLink(candidate.candidate, deps.config.allowedLinkHosts);
  if (!analysis.ok) return repeat(turn, REFUSAL_KEYS[analysis.refusal]);
  const { link } = analysis;
  const next = stepAfterLink(link.accountUrl);
  const started = await startDraft(deps.db, deps.clock, turn.key, next, link, turn.locale);
  if (!started) {
    // Another update moved the draft on meanwhile: its step's prompt again.
    const current = await readDraft(deps.db, turn.key);
    return deleteThenReply(turn, promptFor(current?.step ?? 'url', current?.locale ?? turn.locale, 'intake.repeat'));
  }
  return deleteThenReply(turn, promptFor(next, turn.locale));
}

/** The account step: the account's link, on the reported link's platform. */
async function accountStep(turn: Turn, draft: Draft, text: string): Promise<void> {
  const { deps } = turn;
  const candidate = extractLink(text);
  if (!candidate.ok) return repeat(turn, REFUSAL_KEYS[candidate.refusal]);
  const analysis = checkReportedLink(candidate.candidate, deps.config.allowedLinkHosts);
  if (!analysis.ok) return repeat(turn, REFUSAL_KEYS[analysis.refusal]);
  const { link } = analysis;
  const isAccount = link.platform === 'other' || link.kind === 'account';
  if (link.platform !== draft.platform || !isAccount) return repeat(turn, 'intake.refused.account_link');
  const moved = await setAccount(deps.db, deps.clock, turn.key, link.url);
  if (!moved) return repeat(turn, 'intake.repeat');
  return deleteThenReply(turn, promptFor('category', turn.locale));
}

/**
 * The acknowledgement (see the header), then the hotline message for a
 * "sexual content involving a minor" label, then the wait and the
 * acknowledgement's deletion. A failed send is logged by class and ends
 * nothing else: the report is in already.
 */
async function acknowledge(turn: Turn, content: CompleteDraft, now: number, deleted: boolean): Promise<void> {
  const { deps, ctx, chatId, locale } = turn;
  const platform = t(locale, PLATFORM_NAME_KEYS[content.platform]);
  const text = withDeleteNote(locale, t(locale, 'intake.ack', { platform, date: utcDay(now) }), deleted);
  let ack: Message.TextMessage | undefined;
  try {
    ack = await send(ctx, chatId, { text });
  } catch (error) {
    deps.logger.logError('reply.failed', error);
  }
  const ackSentAt = deps.clock.now();
  if (content.category === 'csam') {
    try {
      await send(ctx, chatId, { text: t(locale, 'intake.hotlines') });
    } catch (error) {
      deps.logger.logError('reply.failed', error);
    }
  }
  if (ack === undefined) return;
  await deps.clock.sleep(ackDeleteAt(turn.handlerStart, ackSentAt) - deps.clock.now());
  try {
    await ctx.api.deleteMessage(chatId, ack.message_id);
  } catch (error) {
    if (classifyTelegramError(error).kind !== 'message_not_found') deps.logger.logError('intake.ack_not_deleted', error);
  }
}

/** The submit: the comment (or none) and the draft become a report, if the limits allow. */
async function submit(turn: Turn, draft: Draft, comment: string | null): Promise<void> {
  const { deps } = turn;
  const content = completeDraft(draft);
  if (content === null) return repeat(turn, 'intake.nothing_pending');
  const now = deps.clock.now();
  const member = await membershipOf(
    {
      api: turn.ctx.api,
      config: deps.config,
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.membershipCache === undefined ? {} : { cache: deps.membershipCache }),
    },
    turn.userId,
  );
  const hash = await linkHash(content.url, deps.config.reporterRefKey);
  const outcome = await submitReport(
    deps.db,
    { reporterRef: turn.key, reportId: randomId(), member, ...content, comment, linkHash: hash },
    now,
  );
  if (outcome === 'limited') return deleteThenReply(turn, { text: t(turn.locale, 'error.rate_limited') });
  if (outcome === 'stale') return deleteThenReply(turn, { text: t(turn.locale, 'intake.nothing_pending') });
  await acknowledge(turn, content, now, await deleteTurnMessage(turn));
}

/** The comment step: a comment within the bound submits the report. */
async function commentStep(turn: Turn, draft: Draft, text: string): Promise<void> {
  const check = checkComment(text);
  if (!check.ok) return repeat(turn, 'intake.refused.comment_too_long');
  return submit(turn, draft, check.comment);
}

/** /cancel: the draft deleted, then the message, then the answer. */
async function cancel(turn: Turn): Promise<void> {
  const cancelled = await cancelDraft(turn.deps.db, turn.key);
  return deleteThenReply(turn, { text: t(turn.locale, cancelled ? 'intake.cancelled' : 'intake.nothing_to_cancel') });
}

/** What the turn's message asks for, at its draft's step. */
function dispatch(turn: Turn, input: Exclude<IntakeInput, { readonly kind: 'command' }>): Promise<void> {
  const { draft } = turn;
  switch (input.kind) {
    case 'refused':
      return repeat(turn, 'intake.refused.media');
    case 'cancel':
      return cancel(turn);
    case 'skip':
      return draft?.step === 'comment' ? submit(turn, draft, null) : repeat(turn, 'intake.repeat');
    case 'text':
      if (draft === null || draft.step === 'url') return urlStep(turn, input.text);
      if (draft.step === 'account') return accountStep(turn, draft, input.text);
      if (draft.step === 'comment') return commentStep(turn, draft, input.text);
      return repeat(turn, 'intake.repeat');
  }
}

/** A private message no command took (see the header). */
export async function handleIntakeMessage(deps: IntakeDeps, ctx: Context): Promise<void> {
  const handlerStart = deps.clock.now();
  const message = ctx.message;
  if (message === undefined || message.chat.type !== 'private') return;
  const chatId = message.chat.id;
  const input = classifyMessage(message, deps.config.botUsername);
  const key = await reporterRef(chatId, deps.config.reporterRefKey);
  if (input.kind === 'command') {
    // Nothing about it is read or written: deleted, then the fallback answer
    // in the draft's locale (a /language choice), else the update's.
    const deleted = await deleteReceivedMessage(ctx.api, deps.logger, chatId, message.message_id);
    const locale = (await readDraft(deps.db, key))?.locale ?? resolveLocale(message.from?.language_code);
    await send(ctx, chatId, { text: withDeleteNote(locale, t(locale, 'fallback.help'), deleted) });
    return;
  }
  const turn: Turn = {
    deps,
    ctx,
    chatId,
    messageId: message.message_id,
    userId: message.from?.id ?? chatId,
    key,
    draft: null,
    locale: resolveLocale(message.from?.language_code),
    handlerStart,
    deletion: { attempt: undefined },
  };
  try {
    const draft = await readDraft(deps.db, key);
    await dispatch({ ...turn, draft, locale: draft?.locale ?? turn.locale }, input);
  } catch (error) {
    await deleteTurnMessage(turn);
    throw error;
  }
}

/** An intake button press, in the presser's own chat (see the header). */
export async function handleIntakePress(deps: IntakeDeps, ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (query?.data === undefined || message === undefined || message.chat.type !== 'private' || message.chat.id !== query.from.id) {
    await answerPress(ctx);
    return;
  }
  const chatId = message.chat.id;
  const press = parsePress(query.data);
  const key = await reporterRef(chatId, deps.config.reporterRefKey);
  const draft = await readDraft(deps.db, key);
  const locale = draft?.locale ?? resolveLocale(query.from.language_code);
  const stale = async (): Promise<void> => {
    await answerPress(ctx, { text: t(locale, 'intake.already_answered') });
  };
  if (press === null || draft === null || draft.step !== stepOfPress(press)) return stale();
  let moved: boolean;
  let next: IntakeStep;
  switch (press.kind) {
    case 'account_unknown':
      moved = await setAccount(deps.db, deps.clock, key, null);
      next = 'category';
      break;
    case 'category':
      moved = await setCategory(deps.db, deps.clock, key, press.category);
      next = 'affected';
      break;
    case 'affected':
      moved = await setAffected(deps.db, deps.clock, key, press.affected);
      next = 'comment';
      break;
  }
  if (!moved) return stale();
  await answerPress(ctx);
  const prompt = promptFor(next, locale);
  try {
    await ctx.api.editMessageText(
      chatId,
      message.message_id,
      checked(prompt.text),
      prompt.keyboard === undefined ? {} : { reply_markup: prompt.keyboard },
    );
  } catch (error) {
    // The draft moved on: the reporter's next message gets this step's prompt.
    deps.logger.logError('intake.prompt_not_edited', error);
  }
}
