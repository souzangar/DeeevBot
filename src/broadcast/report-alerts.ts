// @critical-path
// The scheduler's alerts (critical invariants 2, 4 and 5; ADR 0004,
// "Reconciliation"; doc/guides/operations-and-security.md, 3.2 and 3.3):
// every alert goes to every keyholder by direct message, in both locales,
// Persian first, since a keyholder's own locale is not known here, and,
// when asked and the bot is not locked down, to the admin review venue in
// its one language (alertVenue() reads the switch itself and sends nothing
// under lockdown, the venue being compromised by assumption then). Both go
// through src/telegram/alerts.ts, the choke point for every link; these
// alerts carry none, only report ids, message numbers and commands.
// An alert counts as delivered once at least one keyholder got it, as the
// approval notice does (one delivered of several suffices): the caller then
// marks the reports alerted (`reports.alert_sent_at`), the misses being
// logged by class, and an alert that reached nobody is sent again by the
// next reconciliation. A venue alert that fails is logged by class and never
// stops anything.
import type { Config } from '../config/schema';
import { placeholders, sql, concatSql, type SqlDb } from '../db/sql';
import type { Locale } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { alertKeyholders, alertVenue, type AlertOutcome } from '../telegram/alerts';
import type { BotApiPort } from '../telegram/bot-api-port';

export interface ReportAlertDeps {
  readonly api: Pick<BotApiPort, 'sendMessage'>;
  readonly config: Pick<Config, 'keyholderIds' | 'adminChatId' | 'lockdown' | 'allowedLinkHosts' | 'venueLocale'>;
  readonly db: SqlDb;
  readonly logger: Logger;
}

/** A text rendered in each locale, Persian first: what a keyholder gets. */
export const inBothLocales = (render: (locale: Locale) => string): string => `${render('fa')}\n\n${render('en')}`;

/**
 * Sends the alert `render` writes to every keyholder in both locales and,
 * when `venue` is true, to the venue in its language unless the bot is
 * locked down (see the header). The keyholders' outcome; throws only for a
 * text that may not be sent.
 */
export async function alertEveryone(deps: ReportAlertDeps, render: (locale: Locale) => string, venue: boolean): Promise<AlertOutcome> {
  const outcome = await alertKeyholders(deps, inBothLocales(render));
  if (venue) {
    try {
      await alertVenue(deps, render(deps.config.venueLocale));
    } catch (error) {
      deps.logger.logError('alert.failed', error);
    }
  }
  return outcome;
}

/** The most reports one statement marks alerted: D1 binds at most 100 parameters, the time among them. */
export const MARK_LIMIT = 50;

/** Marks `reportIds` alerted at `now`, those not marked yet; how many it marked. */
export async function markAlerted(db: SqlDb, reportIds: readonly string[], now: number): Promise<number> {
  if (reportIds.length === 0) return 0;
  const ids = reportIds.slice(0, MARK_LIMIT);
  const statement = concatSql(sql`UPDATE reports SET alert_sent_at = ? WHERE alert_sent_at IS NULL AND id IN (`, placeholders(ids.length), sql`)`);
  return (await db.run(statement, [now, ...ids])).changes;
}
