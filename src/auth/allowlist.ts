// @critical-path
// The two allowlist gates (critical invariant 2;
// doc/architecture/adr-0003-update-transport-and-admin-authority.md):
// isAdmin() over ADMIN_IDS and isKeyholder() over KEYHOLDER_IDS, both lists
// of numeric Telegram user ids parsed by the configuration schema, which
// refuses a username and refuses an id present in both lists, so the two
// gates are disjoint: no single account can both approve and unlock.
//
// The id passed in is the update's own `from.id`, which Telegram sets on an
// authentic update (the webhook's secret check, or long polling); nothing
// else the client sends (a chat type, a name, a username, a callback
// payload, a forwarded message's origin) is ever an input here. Every admin
// and keyholder action calls its gate again, at every step: nothing is
// cached, so an id removed from the configuration loses its authority at
// its next update.
import type { Config } from '../config/schema';

/** A Telegram user id: a positive safe integer. */
const isUserId = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0;

/** Whether `userId` is on ADMIN_IDS. */
export const isAdmin = (config: Pick<Config, 'adminIds'>, userId: number | undefined): boolean =>
  isUserId(userId) && config.adminIds.includes(userId);

/** Whether `userId` is on KEYHOLDER_IDS. */
export const isKeyholder = (config: Pick<Config, 'keyholderIds'>, userId: number | undefined): boolean =>
  isUserId(userId) && config.keyholderIds.includes(userId);
