// @critical-path
// The authority gates every command and button handler is registered behind
// (critical invariant 2; ADR 0003). Authority comes from the update's own
// `from.id` against the allowlists, re-checked on every update; a chat type,
// a name, a callback payload or a forwarded message's origin grants nothing,
// and a forwarded message is never a command.
// - Keyholder commands (/lockdown, /unlock, and the keyholder commands of
//   later units): a keyholder's id, typed in their own private chat with
//   the bot, never in the venue or a group. Anyone else's matching message
//   is not a keyholder command at all: it falls through to whatever answers
//   an unknown command, so nothing hints that the command exists.
// - Admin commands: an admin's id, typed in the admin review venue
//   (isVenueAdminCommand, what the review registers its commands behind,
//   src/telegram/registry.ts); the same fall-through for anyone else. An
//   admin's command typed in a private chat is no admin command: it falls
//   to the intake's unknown-command answer, deleted on receipt like every
//   private message (isAdminCommand, which also takes the admin's private
//   chat, stays for the probes of the tests).
// - Admin replies: an admin's typed reply, in the venue, to one of the
//   bot's own messages there (isVenueAdminReply), the review's force-reply
//   prompts among them.
// - Keyholder replies: a keyholder's typed reply, in their own private chat,
//   to one of the bot's own messages there (isKeyholderReply), the
//   retraction's prompt among them; like the keyholder commands they work
//   under lockdown.
// - Admin buttons (review and status cards): a press by an id outside
//   ADMIN_IDS is refused, and so is one on a message outside the venue
//   (pressedInVenue).
// - Under lockdown every admin action is refused (refuseUnderLockdown and
//   the admin-button gate): the admin sees a refusal and nothing else. The
//   keyholder buttons (Cancel and Lockdown on an approval notice) keep
//   working, as do the keyholder commands.
// A refusal is in the sender's own locale unless the caller names another:
// the review's registrations (src/telegram/registry.ts) answer in the
// venue's one language, VENUE_LOCALE.
import type { Context, MiddlewareFn } from 'grammy';
import { isAdmin, isKeyholder } from '../auth/allowlist';
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { resolveLocale, t, type Locale, type PlainMessageKey } from '../i18n/index';
import { respond, respondWith } from './respond';

export interface GuardDeps {
  readonly config: Config;
  readonly db: SqlDb;
}

/** A message its sender typed, not forwarded, in their own private chat with the bot. */
export const typedInOwnChat = (ctx: Context): boolean => {
  const message = ctx.message;
  return (
    message !== undefined &&
    message.chat.type === 'private' &&
    message.from !== undefined &&
    message.chat.id === message.from.id &&
    message.forward_origin === undefined
  );
};

/** A message typed, not forwarded, in the admin review venue (ADMIN_CHAT_ID). */
export const typedInVenue = (config: Pick<Config, 'adminChatId'>, ctx: Context): boolean => {
  const message = ctx.message;
  return message !== undefined && message.chat.id === config.adminChatId && message.forward_origin === undefined;
};

/** Whether the update is a keyholder command's: a keyholder, in their own private chat. */
export const isKeyholderCommand =
  (config: Pick<Config, 'keyholderIds'>) =>
  (ctx: Context): boolean =>
    typedInOwnChat(ctx) && isKeyholder(config, ctx.message?.from?.id);

/** Whether the update is an admin command's: an admin, in their own private chat or in the venue. */
export const isAdminCommand =
  (config: Pick<Config, 'adminIds' | 'adminChatId'>) =>
  (ctx: Context): boolean =>
    (typedInOwnChat(ctx) || typedInVenue(config, ctx)) && isAdmin(config, ctx.message?.from?.id);

/** Whether the update is a venue admin command's: an admin, typed in the venue. */
export const isVenueAdminCommand =
  (config: Pick<Config, 'adminIds' | 'adminChatId'>) =>
  (ctx: Context): boolean =>
    typedInVenue(config, ctx) && isAdmin(config, ctx.message?.from?.id);

/** Whether the update is an admin's typed reply in the venue to one of the bot's own messages there. */
export const isVenueAdminReply =
  (config: Pick<Config, 'adminIds' | 'adminChatId' | 'botId'>) =>
  (ctx: Context): boolean => {
    const replied = ctx.message?.reply_to_message;
    return (
      typedInVenue(config, ctx) &&
      isAdmin(config, ctx.message?.from?.id) &&
      replied !== undefined &&
      replied.chat.id === config.adminChatId &&
      replied.from?.id === config.botId
    );
  };

/**
 * Whether the update is a keyholder's typed reply, in their own private
 * chat, to one of the bot's own messages there.
 */
export const isKeyholderReply =
  (config: Pick<Config, 'keyholderIds' | 'botId'>) =>
  (ctx: Context): boolean => {
    const message = ctx.message;
    const replied = message?.reply_to_message;
    return (
      typedInOwnChat(ctx) &&
      isKeyholder(config, message?.from?.id) &&
      replied !== undefined &&
      replied.chat.id === message?.chat.id &&
      replied.from?.id === config.botId
    );
  };

/** Put after the admin-button gate: a press on a message outside the venue is refused. */
export const pressedInVenue =
  (config: Pick<Config, 'adminChatId'>): MiddlewareFn<Context> =>
  async (ctx, next) => {
    if (ctx.callbackQuery?.message?.chat.id !== config.adminChatId) {
      await respondWith(ctx, config, 'error.unauthorized');
      return;
    }
    await next();
  };

/** Which locale a refusal is in: the sender's own, unless a caller names another. */
export type RefusalLocale = (ctx: Context) => Locale;

const sendersLocale: RefusalLocale = (ctx) => resolveLocale(ctx.from?.language_code);

/** respondWith(), in the locale `localeOf` names. */
const refuse = (ctx: Context, config: Pick<Config, 'adminChatId'>, localeOf: RefusalLocale, key: PlainMessageKey) =>
  respond(ctx, config, t(localeOf(ctx), key));

/** Put before every admin action: under lockdown it is refused, and nothing runs. */
export const refuseUnderLockdown =
  (deps: GuardDeps, localeOf: RefusalLocale = sendersLocale): MiddlewareFn<Context> =>
  async (ctx, next) => {
    if (await isLockedDown(deps.config, deps.db)) {
      await refuse(ctx, deps.config, localeOf, 'admin.refused');
      return;
    }
    await next();
  };

/** Put before every admin button: a non-admin's press is refused, and under lockdown every press. */
export const adminButton =
  (deps: GuardDeps, localeOf: RefusalLocale = sendersLocale): MiddlewareFn<Context> =>
  async (ctx, next) => {
    const query = ctx.callbackQuery;
    if (query === undefined) return;
    if (!isAdmin(deps.config, query.from.id)) {
      await refuse(ctx, deps.config, localeOf, 'error.unauthorized');
      return;
    }
    await refuseUnderLockdown(deps, localeOf)(ctx, next);
  };

/**
 * Put before every keyholder button: pressed by a keyholder, on a message in
 * their own chat with the bot. It keeps working under lockdown.
 */
export const keyholderButton =
  (config: Pick<Config, 'keyholderIds' | 'adminChatId'>): MiddlewareFn<Context> =>
  async (ctx, next) => {
    const query = ctx.callbackQuery;
    if (query === undefined) return;
    if (!isKeyholder(config, query.from.id) || query.message?.chat.id !== query.from.id) {
      await respondWith(ctx, config, 'error.unauthorized');
      return;
    }
    await next();
  };
