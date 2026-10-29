// @critical-path
// The commands of this unit (ADR 0003; the MVP plan, sections 2 and 4), all
// in private chats only: a command typed in a group, the venue or the
// channel is never one of these (src/telegram/guards.ts).
// - /lockdown and /unlock, keyholders only, in their own private chat with
//   the bot, the allowlist re-checked on every call. /lockdown sets the
//   switch, `meta.lockdown`, with the time, through lockdownNow()
//   (src/broadcast/maintenance.ts), which also runs the immediate retention
//   pass, as the notice's Lockdown button does; /unlock clears it, the only
//   code path that does (src/auth/lockdown.ts), and says so when the
//   deployment's LOCKDOWN override still holds the bot locked, which no
//   Telegram command can clear. From anyone else either is not a command:
//   it falls through to the answer any unknown command gets, so nothing
//   hints that it exists.
// - /start: what the bot does, in the reader's locale; from a keyholder,
//   "you will receive alerts" (a bot cannot start a private chat, so every
//   keyholder sends /start once at go-live). Under lockdown everyone else
//   gets the neutral "temporarily unavailable".
// - /language fa|en: answers in the chosen locale and keeps the choice in
//   the sender's intake draft (src/review/drafts.ts), keyed by the reporter
//   reference of the chat, never the id, for the rest of the conversation
//   (a draft at its first step when there is none yet, deleted with the
//   draft). Under lockdown, the neutral text, and nothing kept.
// Outside lockdown /start and /language are deleted on receipt like every
// message the bot receives in a private chat (src/telegram/delete-message.ts):
// /language after its write, both before the reply, a failed delete noted
// in the reply. A keyholder's own commands, /start from a keyholder,
// /lockdown and /unlock, are kept: that chat is the keyholder's operations
// log. Under lockdown nothing is deleted.
// Nothing else here stores anything about the sender, and every reply goes
// to the sender's own chat.
import { Composer, type Context } from 'grammy';
import { isKeyholder } from '../auth/allowlist';
import { clearLockdown, isLockedDown } from '../auth/lockdown';
import { lockdownNow, type RetentionPass } from '../broadcast/maintenance';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { isLocale, resolveLocale, t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { reporterRef } from '../privacy/reporter-ref';
import { rememberLocale } from '../review/drafts';
import { deleteOwnMessage, withDeleteNote } from './delete-message';
import { isKeyholderCommand, typedInOwnChat } from './guards';

export interface CommandDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The retention pass /lockdown runs: runRetentionNow unless given (tests pass a spy). */
  readonly retentionNow?: RetentionPass;
}

const localeOf = (ctx: Context) => resolveLocale(ctx.from?.language_code);

/** /lockdown and /unlock, for keyholders in their own private chat only. */
export function keyholderCommands(deps: CommandDeps): Composer<Context> {
  const composer = new Composer<Context>();
  const keyholder = composer.filter(isKeyholderCommand(deps.config));

  keyholder.command('lockdown', async (ctx) => {
    const set = await lockdownNow({
      api: ctx.api,
      config: deps.config,
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.retentionNow === undefined ? {} : { retentionNow: deps.retentionNow }),
    });
    await ctx.reply(t(localeOf(ctx), set ? 'lockdown.on' : 'lockdown.already_on'));
  });

  keyholder.command('unlock', async (ctx) => {
    const cleared = await clearLockdown(deps.db);
    if (cleared) deps.logger.log('lockdown.cleared');
    const locale = localeOf(ctx);
    const answer = t(locale, cleared ? 'lockdown.off' : 'lockdown.was_off');
    await ctx.reply(deps.config.lockdown ? `${answer}\n\n${t(locale, 'lockdown.override_on')}` : answer);
  });

  return composer;
}

/** /start and /language, in private chats only. */
export function publicCommands(deps: CommandDeps): Composer<Context> {
  const composer = new Composer<Context>();
  const own = composer.filter(typedInOwnChat);

  own.command('start', async (ctx) => {
    const locale = localeOf(ctx);
    if (isKeyholder(deps.config, ctx.from?.id)) {
      const confirmation = t(locale, 'start.keyholder');
      const locked = await isLockedDown(deps.config, deps.db);
      await ctx.reply(locked ? `${confirmation}\n\n${t(locale, 'keyholder.lockdown_is_on')}` : confirmation);
      return;
    }
    if (await isLockedDown(deps.config, deps.db)) {
      await ctx.reply(t(locale, 'lockdown.unavailable'));
      return;
    }
    const deleted = await deleteOwnMessage(ctx, deps.logger);
    await ctx.reply(withDeleteNote(locale, t(locale, 'start.intro'), deleted));
  });

  own.command('language', async (ctx) => {
    if (await isLockedDown(deps.config, deps.db)) {
      await ctx.reply(t(localeOf(ctx), 'lockdown.unavailable'));
      return;
    }
    const choice = ctx.match.trim().toLowerCase();
    const chatId = ctx.message?.chat.id;
    if (!isLocale(choice) || chatId === undefined) {
      const locale = localeOf(ctx);
      const deleted = await deleteOwnMessage(ctx, deps.logger);
      await ctx.reply(withDeleteNote(locale, t(locale, 'language.usage'), deleted));
      return;
    }
    try {
      await rememberLocale(deps.db, deps.clock, await reporterRef(chatId, deps.config.reporterRefKey), choice);
    } catch (error) {
      // The write failed: the message goes all the same, before the error boundary answers.
      await deleteOwnMessage(ctx, deps.logger);
      throw error;
    }
    const deleted = await deleteOwnMessage(ctx, deps.logger);
    await ctx.reply(withDeleteNote(choice, t(choice, 'language.set'), deleted));
  });

  return composer;
}
