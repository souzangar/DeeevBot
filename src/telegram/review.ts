// @critical-path
// The review's handlers (critical invariants 1, 2, 3, 4, 5, 7 and 8; the
// MVP plan, sections 4 and 5, unit U4; doc/guides/admin-review-runbook.md):
// every command, button and reply of the admin review, registered through
// the admin surface (src/telegram/registry.ts), whose gates run first: the
// presser's, sender's or replier's own id on ADMIN_IDS (KEYHOLDER_IDS for
// the notice's buttons and a keyholder's /open), the venue (a keyholder's
// own chat), and the lockdown refusal for everything an admin does. Each
// handler reads the update, runs its flow (src/review/), and answers: a
// press with answerCallbackQuery, once, never with a message; a command in
// the chat it was typed in; a reply by the flow's own messages in the venue.
//
// - In the venue, from an admin: /open, /block <ref>, /unblock <ref>,
//   /card <id>; the buttons of the review card, the routing card and the
//   status card (src/review/callbacks.ts, REVIEW_PREFIXES); the replies to
//   the force-reply prompts. Everything the bot writes or answers there is
//   in the venue's one language, VENUE_LOCALE, whatever the admin's app's.
// - In a keyholder's own chat, under lockdown too: /open, and the Cancel
//   and Lockdown buttons of an approval notice (NOTICE_PREFIXES), answered
//   in the keyholder's own locale; the notice itself is in both.
// An admin's command typed in a private chat is not one of these: it falls
// to the intake's unknown-command answer, deleted on receipt. Nothing here
// ever messages a reporter, a member or the channel.
import type { Context, Middleware } from 'grammy';
import { setLockdown } from '../auth/lockdown';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { isId } from '../db/ids';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { resolveLocale, t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { answerPrompt, chooseCategory, chooseLinkMode, goBack, startApproval } from '../review/approve';
import { blockReference, blockReporterOf, isReporterRef, unblockReference } from '../review/block';
import {
  NOTICE_PREFIXES,
  parseNoticeData,
  parseReviewData,
  REVIEW_PREFIXES,
  type ReviewAction,
  type ReviewActionKind,
} from '../review/callbacks';
import { repostCard } from '../review/card-post';
import { cancelByAdmin, cancelByKeyholder } from '../review/cancel';
import { loadPress } from '../review/flow';
import { isolateNotices, type NoticeMemory } from '../review/notify';
import { openReportsText } from '../review/open';
import { readPrompt } from '../review/prompts';
import { reject, showReasons } from '../review/reject';
import { confirmRoute, showRouting } from '../review/route';
import { checkedText, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from '../review/venue';
import { adminSurface, type AdminSurface } from './registry';
import { answerPress } from './respond';

export interface ReviewFeatureDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The keyholder notices' memory: the isolate's own unless given (tests pass a fresh one). */
  readonly notices?: NoticeMemory;
}

/** The venue's admin commands. */
export const REVIEW_ADMIN_COMMANDS = ['open', 'block', 'unblock', 'card'] as const;
/** The keyholders' commands of the review, in their own chat. */
export const REVIEW_KEYHOLDER_COMMANDS = ['open'] as const;

/**
 * Who acts: the update's own sender, whom the gates checked. In the venue
 * the actor speaks the venue's one language, VENUE_LOCALE, whatever their
 * own app's; a keyholder in their own chat keeps their own.
 */
const actorOf = (ctx: Context, where: 'venue' | 'keyholder', config: Pick<Config, 'venueLocale'>): Actor => {
  const id = ctx.from?.id;
  if (id === undefined) throw new AppError('UNEXPECTED', 'a review update has no sender');
  return { id, locale: where === 'venue' ? config.venueLocale : resolveLocale(ctx.from?.language_code) };
};

/** The text after a command's name, trimmed. */
const commandArgument = (ctx: Context): string => {
  const text = ctx.message?.text ?? '';
  const space = text.search(/\s/);
  return space === -1 ? '' : text.slice(space + 1).trim();
};

/** A press handler: the flow's answer, once; an empty one for data the flow does not take. */
const press =
  (run: (ctx: Context, data: string, pressed: Pressed) => Promise<PressOutcome>): Middleware<Context> =>
  async (ctx) => {
    const query = ctx.callbackQuery;
    const message = query?.message;
    if (query?.data === undefined || message === undefined) {
      await answerPress(ctx);
      return;
    }
    const outcome = await run(ctx, query.data, { chatId: message.chat.id, messageId: message.message_id, sentAt: message.date * 1000 });
    await answerPress(ctx, outcome.answer === undefined ? undefined : { text: outcome.answer });
  };

/** Block reporter, on the review card or the status card. */
async function blockFromCard(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: false, statusCard: true });
  if (!loaded.ok) return loaded.outcome;
  const outcome = await blockReporterOf(deps.db, deps.clock, reportId);
  const key = outcome === 'blocked' ? 'review.answer.blocked' : outcome === 'already_blocked' ? 'review.answer.already_blocked' : 'review.answer.no_reference';
  return { answer: t(actor.locale, key) };
}

/** The flow of an admin's press. */
function runReview(deps: ReviewDeps, actor: Actor, action: ReviewAction, pressed: Pressed): Promise<PressOutcome> {
  switch (action.kind) {
    case 'approve':
      return startApproval(deps, actor, action.reportId, pressed);
    case 'category':
      return chooseCategory(deps, actor, action.reportId, action.category, pressed);
    case 'mode':
      return chooseLinkMode(deps, actor, action.reportId, action.category, action.mode, pressed);
    case 'reject':
      return showReasons(deps, actor, action.reportId, pressed);
    case 'reason':
      return reject(deps, actor, action.reportId, action.reason, pressed);
    case 'route':
      return showRouting(deps, actor, action.reportId, pressed);
    case 'confirm_route':
      return confirmRoute(deps, actor, action.reportId, pressed);
    case 'cancel':
      return cancelByAdmin(deps, actor, action.reportId, action.approvalId, pressed);
    case 'block':
      return blockFromCard(deps, actor, action.reportId, pressed);
    case 'back':
      return goBack(deps, actor, action.reportId, pressed);
  }
}

/** The review's surface: every registration of the header. */
export function reviewSurface(deps: ReviewFeatureDeps): AdminSurface {
  const surface = adminSurface(deps);
  const notices = deps.notices ?? isolateNotices;
  const flow = (ctx: Context): ReviewDeps => ({
    api: ctx.api,
    config: deps.config,
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    notices,
  });

  const venue = (ctx: Context): Actor => actorOf(ctx, 'venue', deps.config);
  const keyholder = (ctx: Context): Actor => actorOf(ctx, 'keyholder', deps.config);
  /** A command's answer, in the chat it was typed in, after the check every outgoing text gets. */
  const reply = async (ctx: Context, text: string): Promise<void> => {
    await ctx.reply(checkedText(deps.config, text));
  };
  surface.adminCommand('open', async (ctx) => {
    await reply(ctx, await openReportsText(deps.db, venue(ctx).locale));
  });
  surface.adminCommand('block', async (ctx) => {
    const { locale } = venue(ctx);
    const ref = commandArgument(ctx).toLowerCase();
    if (!isReporterRef(ref)) {
      await reply(ctx, t(locale, 'block.usage'));
      return;
    }
    const outcome = await blockReference(deps.db, deps.clock, ref);
    await reply(ctx, t(locale, outcome === 'blocked' ? 'block.done' : 'block.already'));
  });
  surface.adminCommand('unblock', async (ctx) => {
    const { locale } = venue(ctx);
    const ref = commandArgument(ctx).toLowerCase();
    if (!isReporterRef(ref)) {
      await reply(ctx, t(locale, 'unblock.usage'));
      return;
    }
    await reply(ctx, t(locale, (await unblockReference(deps.db, ref)) ? 'unblock.done' : 'unblock.not_blocked'));
  });
  surface.adminCommand('card', async (ctx) => {
    const { locale } = venue(ctx);
    const reportId = commandArgument(ctx);
    if (!isId(reportId)) {
      await reply(ctx, t(locale, 'card.usage'));
      return;
    }
    const outcome = await repostCard(flow(ctx), reportId);
    if (outcome !== 'posted') await reply(ctx, t(locale, outcome === 'not_found' ? 'card.not_found' : 'card.not_pending'));
  });
  surface.keyholderCommand('open', async (ctx) => {
    await reply(ctx, await openReportsText(deps.db, keyholder(ctx).locale));
  });

  for (const kind of Object.keys(REVIEW_PREFIXES) as ReviewActionKind[]) {
    surface.adminButton(
      REVIEW_PREFIXES[kind],
      press(async (ctx, data, pressed) => {
        const action = parseReviewData(data);
        if (action === null || action.kind !== kind) return {};
        return runReview(flow(ctx), venue(ctx), action, pressed);
      }),
    );
  }

  surface.keyholderButton(
    NOTICE_PREFIXES.cancel,
    press(async (ctx, data, pressed) => {
      const action = parseNoticeData(data);
      if (action?.kind !== 'cancel') return {};
      return cancelByKeyholder(flow(ctx), keyholder(ctx), action.reportId, action.approvalId, pressed);
    }),
  );
  surface.keyholderButton(
    NOTICE_PREFIXES.lockdown,
    press(async (ctx, data) => {
      if (parseNoticeData(data)?.kind !== 'lockdown') return {};
      const set = await setLockdown(deps.db, deps.clock);
      if (set) deps.logger.log('lockdown.set');
      return { answer: t(keyholder(ctx).locale, set ? 'keyholder.lockdown_is_on' : 'lockdown.already_on') };
    }),
  );

  surface.adminReply(async (ctx, next) => {
    const message = ctx.message;
    const replied = message?.reply_to_message;
    if (message === undefined || replied === undefined) return next();
    const prompt = await readPrompt(deps.db, message.chat.id, replied.message_id);
    if (prompt === null || prompt.adminId !== message.from?.id) return next();
    const taken = await answerPrompt(flow(ctx), venue(ctx), prompt, { messageId: message.message_id, text: message.text });
    if (!taken) await next();
  });

  return surface;
}

/** The review's composer, for createBot()'s slot of the later units' features. */
export const reviewFeatures = (deps: ReviewFeatureDeps): Middleware<Context> => reviewSurface(deps).composer;
