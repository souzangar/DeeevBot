// @critical-path
// The admin surface (critical invariant 2; ADR 0003; the U2 audit's
// carried rule): the ONE helper every admin command, admin button, admin
// reply, keyholder command and keyholder button of the review is
// registered through, so no registration can leave out a gate. Each kind
// carries its gates, in this order, before its handler runs:
// - adminCommand(name): typed in the venue by an id on ADMIN_IDS
//   (isVenueAdminCommand; from anyone else, or anywhere else, it is no
//   command and falls through), then refused under lockdown;
// - adminButton(prefix): on a message in the venue (else refused), pressed
//   by an id on ADMIN_IDS (else refused), then refused under lockdown;
// - adminReply(): an admin's typed reply in the venue to one of the bot's
//   own messages (isVenueAdminReply; anyone else's falls through), then
//   refused under lockdown;
// every refusal in the venue is in its one language, VENUE_LOCALE, whoever
// pressed or typed, so the venue's text reveals no admin's client language;
// - keyholderCommand(name): typed by an id on KEYHOLDER_IDS in their own
//   private chat (isKeyholderCommand; from anyone else it is no command and
//   falls through, so nothing hints that it exists); it works under
//   lockdown, and is never deleted on receipt: the keyholder's chat is
//   their operations log;
// - keyholderButton(prefix): pressed by an id on KEYHOLDER_IDS on a message
//   in their own chat (keyholderButton); it works under lockdown;
// - keyholderReply(): a keyholder's typed reply in their own private chat to
//   one of the bot's own messages there (isKeyholderReply; anyone else's
//   falls through), the retraction's prompt among them; it works under
//   lockdown.
// The gates are src/telegram/guards.ts; authority is the update's own
// `from.id`, re-checked on every update. A button prefix is registered
// once, and no prefix may be a prefix of another, so a press reaches one
// handler. registrations() lists what was registered, which the always-run
// lockdown spec iterates (test/invariants/lockdown.test.ts) and a source
// scan pins: no `.command(` or `.callbackQuery(` call in src/review/ or
// src/telegram/ outside this file but the keyholder and public commands of
// src/telegram/commands.ts.
import { Composer, type Context, type Middleware } from 'grammy';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import {
  adminButton,
  isKeyholderCommand,
  isKeyholderReply,
  isVenueAdminCommand,
  isVenueAdminReply,
  keyholderButton,
  pressedInVenue,
  refuseUnderLockdown,
} from './guards';

export interface SurfaceDeps {
  readonly config: Config;
  readonly db: SqlDb;
}

/** What the surface registered, by kind. */
export interface SurfaceRegistrations {
  readonly adminCommands: readonly string[];
  readonly adminButtons: readonly string[];
  readonly adminReplies: number;
  readonly keyholderCommands: readonly string[];
  readonly keyholderButtons: readonly string[];
  readonly keyholderReplies: number;
}

export interface AdminSurface {
  adminCommand(name: string, handler: Middleware<Context>): void;
  adminButton(prefix: string, handler: Middleware<Context>): void;
  adminReply(handler: Middleware<Context>): void;
  keyholderCommand(name: string, handler: Middleware<Context>): void;
  keyholderButton(prefix: string, handler: Middleware<Context>): void;
  keyholderReply(handler: Middleware<Context>): void;
  /** The composer the registrations went into, for createBot()'s slot. */
  readonly composer: Composer<Context>;
  registrations(): SurfaceRegistrations;
}

const COMMAND_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PREFIX = /^[a-z]{2}:[a-z]{2}:?$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The surface of the header over `deps`. */
export function adminSurface(deps: SurfaceDeps): AdminSurface {
  const composer = new Composer<Context>();
  const adminCommands: string[] = [];
  const adminButtons: string[] = [];
  const keyholderCommands: string[] = [];
  const keyholderButtons: string[] = [];
  let adminReplies = 0;
  let keyholderReplies = 0;
  const venue = (): 'fa' | 'en' => deps.config.venueLocale;

  const commandName = (name: string, taken: readonly string[]): string => {
    if (!COMMAND_NAME.test(name) || taken.includes(name)) {
      throw new AppError('UNEXPECTED', 'a command is registered once, by a plain lowercase name');
    }
    return name;
  };
  const buttonPrefix = (prefix: string): RegExp => {
    const all = [...adminButtons, ...keyholderButtons];
    if (!PREFIX.test(prefix) || all.some((other) => other.startsWith(prefix) || prefix.startsWith(other))) {
      throw new AppError('UNEXPECTED', 'a button prefix is registered once, and is no prefix of another');
    }
    return new RegExp(`^${escapeRegExp(prefix)}`);
  };

  return {
    adminCommand: (name, handler) => {
      composer.filter(isVenueAdminCommand(deps.config)).command(commandName(name, adminCommands), refuseUnderLockdown(deps, venue), handler);
      adminCommands.push(name);
    },
    adminButton: (prefix, handler) => {
      composer.callbackQuery(buttonPrefix(prefix), pressedInVenue(deps.config), adminButton(deps, venue), handler);
      adminButtons.push(prefix);
    },
    adminReply: (handler) => {
      composer.filter(isVenueAdminReply(deps.config)).on('message', refuseUnderLockdown(deps, venue), handler);
      adminReplies += 1;
    },
    keyholderCommand: (name, handler) => {
      composer.filter(isKeyholderCommand(deps.config)).command(commandName(name, keyholderCommands), handler);
      keyholderCommands.push(name);
    },
    keyholderButton: (prefix, handler) => {
      composer.callbackQuery(buttonPrefix(prefix), keyholderButton(deps.config), handler);
      keyholderButtons.push(prefix);
    },
    keyholderReply: (handler) => {
      composer.filter(isKeyholderReply(deps.config)).on('message', handler);
      keyholderReplies += 1;
    },
    composer,
    registrations: () => ({
      adminCommands: [...adminCommands],
      adminButtons: [...adminButtons],
      adminReplies,
      keyholderCommands: [...keyholderCommands],
      keyholderButtons: [...keyholderButtons],
      keyholderReplies,
    }),
  };
}
