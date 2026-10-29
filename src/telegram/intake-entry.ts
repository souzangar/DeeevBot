// @critical-path
// The intake entry (critical invariant 2: while the bot is locked down no
// intake is performed): every private message no command took, and every
// intake button press in a private chat (`intake:` data), arrive here, and
// the lockdown check comes first for both. Under lockdown the sender gets
// the neutral "temporarily unavailable", which says nothing of why (as the
// message's reply, or as the press's callback answer), and nothing is
// stored or deleted. Otherwise the intake conversation takes them
// (src/telegram/intake.ts): the intake lives behind this one gate, and
// last among the handlers of private messages, so every command
// registered before it, the later units' included, keeps precedence.
import { Composer, type Context } from 'grammy';
import { isLockedDown } from '../auth/lockdown';
import { resolveLocale, t } from '../i18n/index';
import { INTAKE_PREFIX } from '../review/intake';
import { handleIntakeMessage, handleIntakePress, type IntakeDeps } from './intake';
import { answerPress } from './respond';

export type IntakeEntryDeps = IntakeDeps;

/** Private messages and intake presses: the lockdown gate, then the intake conversation. */
export function intakeEntry(deps: IntakeEntryDeps): Composer<Context> {
  const composer = new Composer<Context>();
  const own = composer.chatType('private');
  own.on('message', async (ctx) => {
    if (await isLockedDown(deps.config, deps.db)) {
      await ctx.reply(t(resolveLocale(ctx.from.language_code), 'lockdown.unavailable'));
      return;
    }
    await handleIntakeMessage(deps, ctx);
  });
  own.on('callback_query:data').filter(
    (ctx) => ctx.callbackQuery.data.startsWith(INTAKE_PREFIX),
    async (ctx) => {
      if (await isLockedDown(deps.config, deps.db)) {
        await answerPress(ctx, { text: t(resolveLocale(ctx.from.language_code), 'lockdown.unavailable') });
        return;
      }
      await handleIntakePress(deps, ctx);
    },
  );
  return composer;
}
