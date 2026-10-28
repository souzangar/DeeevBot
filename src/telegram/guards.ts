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
// - Admin commands (later units): an admin's id, typed in their own private
//   chat or in the admin review venue; the same fall-through for anyone
//   else.
// - Admin buttons (review and status cards, later units): a press by an id
//   outside ADMIN_IDS is refused.
// - Under lockdown every admin action is refused (refuseUnderLockdown and
//   the admin-button gate): the admin sees a refusal and nothing else. The
//   keyholder buttons (Cancel and Lockdown on an approval notice) keep
//   working, as do the keyholder commands.
import type { Context, MiddlewareFn } from 'grammy';
import { isAdmin, isKeyholder } from '../auth/allowlist';
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { respondWith } from './respond';

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

/** Put before every admin action: under lockdown it is refused, and nothing runs. */
export const refuseUnderLockdown =
  (deps: GuardDeps): MiddlewareFn<Context> =>
  async (ctx, next) => {
    if (await isLockedDown(deps.config, deps.db)) {
      await respondWith(ctx, deps.config, 'admin.refused');
      return;
    }
    await next();
  };

/** Put before every admin button: a non-admin's press is refused, and under lockdown every press. */
export const adminButton =
  (deps: GuardDeps): MiddlewareFn<Context> =>
  async (ctx, next) => {
    const query = ctx.callbackQuery;
    if (query === undefined) return;
    if (!isAdmin(deps.config, query.from.id)) {
      await respondWith(ctx, deps.config, 'error.unauthorized');
      return;
    }
    await refuseUnderLockdown(deps)(ctx, next);
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
