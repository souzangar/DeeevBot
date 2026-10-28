// @critical-path
// The commands of this unit (ADR 0003; the MVP plan, sections 2 and 4), all
// in private chats only: a command typed in a group, the venue or the
// channel is never one of these (src/telegram/guards.ts).
// - /lockdown and /unlock, keyholders only, in their own private chat with
//   the bot, the allowlist re-checked on every call. /lockdown sets the
//   switch, `meta.lockdown`, with the time; /unlock clears it, the only
//   code path that does (src/auth/lockdown.ts), and says so when the
//   deployment's LOCKDOWN override still holds the bot locked, which no
//   Telegram command can clear. From anyone else either is not a command:
//   it falls through to the answer any unknown command gets, so nothing
//   hints that it exists.
// - /start: what the bot does, in the reader's locale; from a keyholder,
//   "you will receive alerts" (a bot cannot start a private chat, so every
//   keyholder sends /start once at go-live). Under lockdown everyone else
//   gets the neutral "temporarily unavailable".
// - /language fa|en: answers in the chosen locale; remembering the choice
//   is the intake unit's (the draft row). Under lockdown, the neutral text.
// Nothing here stores anything about the sender, and every reply goes to
// the sender's own chat.
import { Composer, type Context } from 'grammy';
import { isKeyholder } from '../auth/allowlist';
import { clearLockdown, isLockedDown, setLockdown } from '../auth/lockdown';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { isLocale, resolveLocale, t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { isKeyholderCommand, typedInOwnChat } from './guards';

export interface CommandDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
}

const localeOf = (ctx: Context) => resolveLocale(ctx.from?.language_code);

/** /lockdown and /unlock, for keyholders in their own private chat only. */
export function keyholderCommands(deps: CommandDeps): Composer<Context> {
  const composer = new Composer<Context>();
  const keyholder = composer.filter(isKeyholderCommand(deps.config));

  keyholder.command('lockdown', async (ctx) => {
    const set = await setLockdown(deps.db, deps.clock);
    if (set) deps.logger.log('lockdown.set');
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
    await ctx.reply(t(locale, 'start.intro'));
  });

  own.command('language', async (ctx) => {
    if (await isLockedDown(deps.config, deps.db)) {
      await ctx.reply(t(localeOf(ctx), 'lockdown.unavailable'));
      return;
    }
    const choice = ctx.match.trim().toLowerCase();
    await ctx.reply(isLocale(choice) ? t(choice, 'language.set') : t(localeOf(ctx), 'language.usage'));
  });

  return composer;
}
