// @critical-path
// The scheduler's commands (critical invariants 1, 2 and 5; the MVP plan,
// section 4, "The post" and "Admin commands";
// doc/guides/operations-and-security.md, 3.1 and 3.2), registered through
// the admin surface (src/telegram/registry.ts) into the review's
// (src/telegram/review.ts), so their gates are the surface's and the
// lockdown spec's iteration over registrations() drives them:
// - in the venue, from an admin, refused under lockdown: /attach <id>
//   <message>, /repost <id>, /halt and /resume, answered in the venue's one
//   language;
// - in a keyholder's own chat, under lockdown too: /attach <id> <message>
//   and /halt, answered in the keyholder's own language, never deleted (the
//   keyholder's chat is their operations log).
// Each command answers in the chat it was typed in and nowhere else; a
// recorded attach also edits the bot's own messages about the report (the
// keyholders' notices and, outside lockdown, the status card and the review
// card: src/broadcast/post.ts). /attach answers with the message id it
// recorded, never with the link it was given.
import type { Context } from 'grammy';
import { attachPost, parseAttach, type Attacher, type AttachOutcome } from '../broadcast/attach';
import type { PostDeps } from '../broadcast/post';
import { repostReport } from '../broadcast/repost';
import { clearHalt, setHalt } from '../broadcast/state';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { isId } from '../db/ids';
import type { SqlDb } from '../db/sql';
import { resolveLocale, t, type Locale } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { isolateNotices, type NoticeMemory } from '../review/notify';
import { checkedText } from '../review/venue';
import type { AdminSurface } from './registry';

/** The scheduler's admin commands, in the venue. */
export const POSTING_ADMIN_COMMANDS = ['attach', 'repost', 'halt', 'resume'] as const;
/** The scheduler's keyholder commands, in their own chat. */
export const POSTING_KEYHOLDER_COMMANDS = ['attach', 'halt'] as const;

export interface PostingFeatureDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The keyholder notices' memory: the isolate's own unless given (tests pass a fresh one). */
  readonly notices?: NoticeMemory;
}

/** The text after a command's name, trimmed. */
const argumentOf = (ctx: Context): string => {
  const text = ctx.message?.text ?? '';
  const space = text.search(/\s/);
  return space === -1 ? '' : text.slice(space + 1).trim();
};

/** The answer to an /attach that got as far as the report. */
function attachAnswer(locale: Locale, outcome: AttachOutcome, reportId: string, messageId: number): string {
  switch (outcome) {
    case 'recorded':
      return t(locale, 'attach.done', { id: reportId, message: messageId });
    case 'not_found':
      return t(locale, 'attach.not_found');
    case 'not_posting':
      return t(locale, 'attach.not_posting', { id: reportId });
    case 'taken':
      return t(locale, 'attach.taken');
    case 'not_verified':
      return t(locale, 'attach.not_verified', { id: reportId });
    case 'text_mismatch':
      return t(locale, 'attach.text_mismatch', { id: reportId });
    case 'window_mismatch':
      return t(locale, 'attach.window_mismatch', { id: reportId });
    case 'unavailable':
      return t(locale, 'attach.unavailable');
    case 'locked':
      return t(locale, 'admin.refused');
  }
}

/** Registers the commands of the header on `surface`. */
export function registerPosting(surface: AdminSurface, deps: PostingFeatureDeps): void {
  const notices = deps.notices ?? isolateNotices;
  const post = (ctx: Context): PostDeps => ({ api: ctx.api, config: deps.config, db: deps.db, clock: deps.clock, logger: deps.logger, notices });
  const localeOf = (ctx: Context, who: Attacher): Locale => (who === 'admin' ? deps.config.venueLocale : resolveLocale(ctx.from?.language_code));
  /** A command's answer, in the chat it was typed in, after the check every outgoing text gets. */
  const reply = async (ctx: Context, text: string): Promise<void> => {
    await ctx.reply(checkedText(deps.config, text));
  };

  const attach =
    (who: Attacher) =>
    async (ctx: Context): Promise<void> => {
      const locale = localeOf(ctx, who);
      const request = parseAttach(argumentOf(ctx), deps.config.broadcastChatId);
      if (!request.ok) {
        await reply(ctx, t(locale, request.reason === 'other_channel' ? 'attach.other_channel' : 'attach.usage'));
        return;
      }
      const outcome = await attachPost(post(ctx), who, request.reportId, request.messageId);
      await reply(ctx, attachAnswer(locale, outcome, request.reportId, request.messageId));
    };

  const halt =
    (who: Attacher) =>
    async (ctx: Context): Promise<void> => {
      const set = await setHalt(deps.db, deps.clock);
      if (set) deps.logger.log('halt.set');
      await reply(ctx, t(localeOf(ctx, who), set ? 'halt.on' : 'halt.already_on'));
    };

  surface.adminCommand('attach', attach('admin'));
  surface.adminCommand('repost', async (ctx) => {
    const locale = deps.config.venueLocale;
    const reportId = argumentOf(ctx).toLowerCase();
    if (!isId(reportId)) {
      await reply(ctx, t(locale, 'repost.usage'));
      return;
    }
    const outcome = await repostReport(post(ctx), reportId);
    const key = outcome === 'done' ? 'repost.done' : outcome === 'refused' ? 'repost.refused' : null;
    await reply(ctx, key === null ? t(locale, 'repost.not_found') : t(locale, key, { id: reportId }));
  });
  surface.adminCommand('halt', halt('admin'));
  surface.adminCommand('resume', async (ctx) => {
    const cleared = await clearHalt(deps.db);
    if (cleared) deps.logger.log('halt.cleared');
    await reply(ctx, t(deps.config.venueLocale, cleared ? 'halt.off' : 'halt.was_off'));
  });
  surface.keyholderCommand('attach', attach('keyholder'));
  surface.keyholderCommand('halt', halt('keyholder'));
}
