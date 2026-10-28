// @critical-path
// The intake entry (critical invariant 2: while the bot is locked down no
// intake is performed): every private message no command took arrives
// here. The lockdown check comes first: under lockdown the sender gets the
// neutral "temporarily unavailable", which says nothing of why, and nothing
// is stored. Otherwise the message goes on to the intake conversation,
// which the intake unit (U3) adds behind this gate; until then it is
// answered with the fallback text, the same for an unknown command (a
// non-keyholder's /lockdown included) as for any other message.
import { Composer, type Context } from 'grammy';
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { resolveLocale, t } from '../i18n/index';

export interface IntakeEntryDeps {
  readonly config: Pick<Config, 'lockdown'>;
  readonly db: SqlDb;
}

/** Private messages: the lockdown gate, then (for now) the fallback text. */
export function intakeEntry(deps: IntakeEntryDeps): Composer<Context> {
  const composer = new Composer<Context>();
  composer.chatType('private').on('message', async (ctx) => {
    const locale = resolveLocale(ctx.from.language_code);
    if (await isLockedDown(deps.config, deps.db)) {
      await ctx.reply(t(locale, 'lockdown.unavailable'));
      return;
    }
    await ctx.reply(t(locale, 'fallback.help'));
  });
  return composer;
}
