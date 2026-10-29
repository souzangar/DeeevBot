// @critical-path
// The closure unit's commands (critical invariants 1, 2, 5 and 8; the MVP
// plan, section 4, "Closure and retraction" and "Admin commands";
// doc/guides/admin-review-runbook.md, sections 7, 8 and 10;
// doc/guides/operations-and-security.md, 3.6), registered through the admin
// surface (src/telegram/registry.ts) into the review's
// (src/telegram/review.ts), so their gates are the surface's and the
// lockdown spec's iteration over registrations() drives them:
// - in the venue, from an admin, refused under lockdown: /close <id>
//   taken_down|no_result, /retract <id> (its prompt goes to the venue),
//   /stats [YYYY-MM] and /budget, answered in the venue's one language;
// - in a keyholder's own chat, under lockdown too: /retract <id> (its
//   prompt goes to that chat) and /stats [YYYY-MM], answered in the
//   keyholder's own language and never deleted (the keyholder's chat is
//   their operations log), and the keyholder's reply to their own
//   retraction prompt (keyholderReply()), which is deleted with the prompt
//   once it is taken; any other reply falls through.
// The status card's buttons (Taken down, Closed without result, Retract)
// and an admin's reply to a retraction prompt in the venue are the
// review's own registrations (src/telegram/review.ts), running the same
// flows (src/broadcast/closure.ts, retraction.ts). Each command answers in
// the chat it was typed in and nowhere else. /close takes no keyholder:
// under lockdown nothing but a retraction edits a post.
import type { Context } from 'grammy';
import { orderClosure } from '../broadcast/closure';
import { answerRetraction, RETRACTION_PROMPT, startRetraction, type Retractor } from '../broadcast/retraction';
import { budgetText, currentMonth, parseMonth, statsAnswer } from '../broadcast/stats';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { isId } from '../db/ids';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { resolveLocale, t, type Locale } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { isCloseOutcome, type CloseOutcome } from '../review/callbacks';
import { outcomeNameKey } from '../review/names';
import { isolateNotices, type NoticeMemory } from '../review/notify';
import { readPrompt } from '../review/prompts';
import { checkedText, type ReviewDeps } from '../review/venue';
import type { AdminSurface } from './registry';

/** The closure unit's admin commands, in the venue, in the order they are registered. */
export const CLOSURE_ADMIN_COMMANDS = ['close', 'retract', 'stats', 'budget'] as const;
/** The closure unit's keyholder commands, in their own chat, in the order they are registered. */
export const CLOSURE_KEYHOLDER_COMMANDS = ['retract', 'stats'] as const;

export interface ClosureFeatureDeps {
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

/** A /close argument, read: the report id and the outcome. */
export type CloseRequest = { readonly ok: true; readonly reportId: string; readonly outcome: CloseOutcome } | { readonly ok: false };

/** Reads `/close <id> taken_down|no_result`'s argument. */
export function parseClose(argument: string): CloseRequest {
  const parts = argument.trim().split(/\s+/);
  const [rawId, rawOutcome] = parts;
  if (parts.length !== 2 || rawId === undefined || rawOutcome === undefined) return { ok: false };
  const reportId = rawId.toLowerCase();
  const outcome = rawOutcome.toLowerCase();
  return isId(reportId) && isCloseOutcome(outcome) ? { ok: true, reportId, outcome } : { ok: false };
}

/** Registers the commands of the header on `surface`. */
export function registerClosure(surface: AdminSurface, deps: ClosureFeatureDeps): void {
  const notices = deps.notices ?? isolateNotices;
  const flow = (ctx: Context): ReviewDeps => ({ api: ctx.api, config: deps.config, db: deps.db, clock: deps.clock, logger: deps.logger, notices });
  const venueLocale = (): Locale => deps.config.venueLocale;
  const keyholderLocale = (ctx: Context): Locale => resolveLocale(ctx.from?.language_code);
  const senderOf = (ctx: Context): number => {
    const id = ctx.from?.id;
    if (id === undefined) throw new AppError('UNEXPECTED', 'a closure update has no sender');
    return id;
  };
  const retractorOf = (ctx: Context, role: Retractor['role']): Retractor =>
    role === 'admin'
      ? { id: senderOf(ctx), role, locale: venueLocale(), chatId: deps.config.adminChatId }
      : { id: senderOf(ctx), role, locale: keyholderLocale(ctx), chatId: senderOf(ctx) };
  /** A command's answer, in the chat it was typed in, after the check every outgoing text gets. */
  const reply = async (ctx: Context, text: string): Promise<void> => {
    await ctx.reply(checkedText(deps.config, text));
  };

  surface.adminCommand('close', async (ctx) => {
    const locale = venueLocale();
    const request = parseClose(argumentOf(ctx));
    if (!request.ok) {
      await reply(ctx, t(locale, 'close.usage'));
      return;
    }
    const { reportId, outcome } = request;
    switch (await orderClosure(flow(ctx), reportId, outcome)) {
      case 'closing':
        await reply(ctx, t(locale, 'close.done', { id: reportId, outcome: t(locale, outcomeNameKey(outcome)) }));
        return;
      case 'not_found':
        await reply(ctx, t(locale, 'close.not_found'));
        return;
      case 'refused':
        await reply(ctx, t(locale, 'close.refused', { id: reportId }));
        return;
      case 'locked':
        await reply(ctx, t(locale, 'admin.refused'));
        return;
    }
  });

  const retract =
    (role: Retractor['role']) =>
    async (ctx: Context): Promise<void> => {
      const retractor = retractorOf(ctx, role);
      const reportId = argumentOf(ctx).toLowerCase();
      if (!isId(reportId)) {
        await reply(ctx, t(retractor.locale, 'retract.usage'));
        return;
      }
      const started = await startRetraction(flow(ctx), retractor, reportId);
      // The prompt is the answer.
      if (started === 'prompted') return;
      await reply(ctx, started === 'not_found' ? t(retractor.locale, 'retract.not_found') : t(retractor.locale, 'retract.refused', { id: reportId }));
    };

  const stats =
    (locale: (ctx: Context) => Locale) =>
    async (ctx: Context): Promise<void> => {
      const argument = argumentOf(ctx);
      const period = argument === '' ? currentMonth(deps.clock.now()) : parseMonth(argument);
      await reply(ctx, period === null ? t(locale(ctx), 'stats.usage') : await statsAnswer(deps.db, locale(ctx), period));
    };

  surface.adminCommand('retract', retract('admin'));
  surface.adminCommand('stats', stats(venueLocale));
  surface.adminCommand('budget', async (ctx) => {
    await reply(ctx, await budgetText(deps, deps.clock.now(), venueLocale()));
  });
  surface.keyholderCommand('retract', retract('keyholder'));
  surface.keyholderCommand('stats', stats(keyholderLocale));

  surface.keyholderReply(async (ctx, next) => {
    const message = ctx.message;
    const replied = message?.reply_to_message;
    if (message === undefined || replied === undefined) return next();
    const prompt = await readPrompt(deps.db, message.chat.id, replied.message_id);
    if (prompt === null || prompt.kind !== RETRACTION_PROMPT || prompt.adminId !== message.from?.id) return next();
    const taken = await answerRetraction(flow(ctx), retractorOf(ctx, 'keyholder'), prompt, { messageId: message.message_id, text: message.text });
    if (!taken) await next();
  });
}
