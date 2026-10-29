// @critical-path
// /open (critical invariants 2, 3 and 4; the MVP plan, section 4, "Admin
// commands"; doc/product/threat-model-seizure.md, control 4): the reports
// still open, pending a decision or approved, posting, posted, closing or
// retracting, as their id, platform, category, day of intake and state, the
// approval's start for one in its grace, and "no card" for a pending
// report whose card was never stored (/card posts it). Never a URL, a
// comment or a reference: it answers an admin in the venue, and a
// keyholder in their own chat, under lockdown too, since the status cards
// sit in a venue the keyholder is not in and this is how an id is found.
// At most OPEN_LIST_LIMIT lines, the oldest first, and how many more there
// are.
import { utcDay, utcMinute } from '../clock';
import { sql, type SqlDb, type SqlValue } from '../db/sql';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { isPlatform } from '../platforms/platforms';
import { isCategory } from './categories';
import { CATEGORY_NAME_KEYS, STATUS_NAME_KEYS } from './names';
import { isReportStatus, type ReportStatus } from './reports';

/** The most reports one /open lists. */
export const OPEN_LIST_LIMIT = 40;

/** The statuses /open lists. */
export const OPEN_STATUSES = ['pending', 'approved', 'posting', 'posted', 'closing', 'retracting'] as const satisfies readonly ReportStatus[];

const OPEN = sql`SELECT r.id, r.status, r.platform, r.category, r.created_at, r.card_message_id, a.starts_at FROM reports AS r LEFT JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.status IN ('pending', 'approved', 'posting', 'posted', 'closing', 'retracting') ORDER BY r.created_at, r.id LIMIT ?`;
const COUNT = sql`SELECT count(*) AS n FROM reports WHERE status IN ('pending', 'approved', 'posting', 'posted', 'closing', 'retracting')`;

interface OpenRow {
  readonly id: SqlValue;
  readonly status: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly created_at: SqlValue;
  readonly card_message_id: SqlValue;
  readonly starts_at: SqlValue;
}

/** The text /open answers in `locale` (see the header). */
export async function openReportsText(db: SqlDb, locale: Locale): Promise<string> {
  const rows = await db.all<OpenRow>(OPEN, [OPEN_LIST_LIMIT]);
  const total = (await db.first<{ n: SqlValue }>(COUNT))?.n;
  const count = typeof total === 'number' ? total : rows.length;
  if (count === 0) return t(locale, 'open.none');
  const lines = [t(locale, 'open.title', { count })];
  for (const row of rows) {
    const { id, status, platform, category, created_at: createdAt } = row;
    if (typeof id !== 'string' || !isReportStatus(status) || !isPlatform(platform) || !isCategory(category) || typeof createdAt !== 'number') {
      continue;
    }
    let state = t(locale, STATUS_NAME_KEYS[status]);
    if (status === 'approved' && typeof row.starts_at === 'number') state = t(locale, 'open.state.approved', { time: utcMinute(row.starts_at) });
    if (status === 'pending' && row.card_message_id === null) state = t(locale, 'open.state.no_card');
    lines.push(
      t(locale, 'open.line', {
        id,
        platform: t(locale, PLATFORM_NAME_KEYS[platform]),
        category: t(locale, CATEGORY_NAME_KEYS[category]),
        day: utcDay(createdAt),
        state,
      }),
    );
  }
  if (count > rows.length) lines.push(t(locale, 'open.more', { count: count - rows.length }));
  return lines.join('\n');
}
