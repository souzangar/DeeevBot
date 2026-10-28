-- @critical-path
-- The D1 schema of the MVP (doc/architecture/adr-0006-data-model-and-module-layout.md),
-- under critical invariants 1 and 8. D1 is the only store: there is no
-- Durable Object (doc/architecture/adr-0004-storage-and-delivery-ledger.md).
-- Wrangler applies this file on Cloudflare (`npm run migrate:local` for the
-- local database) and src/db/migrate.ts applies it on the Node port. A later
-- change adds a new file and never edits an applied one; a file that changes
-- the schema raises meta.schema_version.
--
-- The bot stores no member or reporter identity: there is no subscriber
-- table, a reporter is known only by the keyed reporter reference
-- (drafts.draft_key, reports.reporter_ref), and an "I reported it" press is
-- a count (reports.presses), never a list of who pressed.
--
-- Conventions, the same in every table:
-- - a time (`*_at`) is INTEGER milliseconds since the Unix epoch, UTC
-- - a day (`day`, `*_day`, `last_seen`) is TEXT 'YYYY-MM-DD', UTC
-- - a flag is INTEGER 0 or 1
-- - a JSON column (jobs.payload) is TEXT holding a JSON object
-- - a report id, an approval id or a job id is 20 lowercase letters a to z
--   (src/db/ids.ts)
-- - a reporter reference, a draft key or a link hash is 64 lowercase hex
--   characters (an HMAC-SHA-256, src/privacy/reporter-ref.ts), so a raw
--   Telegram id or URL cannot be stored there as is; that the value is the
--   keyed one is tested where it is written
-- - a Telegram id (an admin's or a keyholder's, a chat's, a message's) is
--   INTEGER
-- - a personal field is nullable wherever the deletion schedule nulls it
--   instead of deleting its row (doc/product/retention-and-minimisation.md)
-- Every table but `reports` is WITHOUT ROWID: one row written per insert
-- instead of two (D1 counts index rows), and a NULL key is refused rather
-- than turned into a fresh rowid. Indexes are the ones the flows query by,
-- because every index row costs a D1 row written.

-- One reporter's intake conversation, filled step by step and keyed by the
-- reporter reference of the chat, never the chat id: deleted on submit, on
-- /cancel and by the retention job after 24 hours. No message id is kept:
-- each reporter message is deleted on receipt by the handler that
-- processed it.
CREATE TABLE drafts (
  draft_key TEXT NOT NULL PRIMARY KEY CHECK (length(draft_key) = 64 AND draft_key NOT GLOB '*[^0-9a-f]*'),
  step TEXT NOT NULL,
  url TEXT,
  platform TEXT,
  account_url TEXT,
  category TEXT,
  affected_person INTEGER CHECK (affected_person IN (0, 1)),
  comment TEXT,
  locale TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- One row per report (doc/product/report-lifecycle.md). A duplicate is its
-- own `merged` row pointing at the open primary, and goes with it. The
-- statuses: pending to approved (the grace period, Cancel) to posting to
-- posted, then closing (to closed, or expired after 90 days) or retracting
-- (to retracted), the terminal status written only by the edit job's
-- success; pending to rejected, routed, merged or expired. An approved
-- report is posted once into the broadcast channel: the post job claims it
-- (approved to posting, exactly one row changed), posting_started_at is
-- written before the send and post_message_id with posted_at after it, so
-- a post is attempted at most once; a posted row carries posted_at, and
-- retraction and closure edit that post. A status update into approved or
-- posting is refused without an un-voided approval (the
-- reports_need_approval trigger below). comment and affected_person serve
-- the review only and are nulled at the decision. presses counts the "I
-- reported it" presses. Finalization nulls every remaining personal field
-- and sets data_deleted_at.
CREATE TABLE reports (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 20 AND id NOT GLOB '*[^a-z]*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'posting', 'posted', 'closing', 'retracting', 'closed', 'retracted', 'expired', 'rejected', 'routed', 'merged')),
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT,
  account_url TEXT,
  comment TEXT,
  affected_person INTEGER CHECK (affected_person IN (0, 1)),
  reporter_ref TEXT CHECK (length(reporter_ref) = 64 AND reporter_ref NOT GLOB '*[^0-9a-f]*'),
  merged_into TEXT REFERENCES reports (id) ON DELETE CASCADE,
  link_hash TEXT CHECK (length(link_hash) = 64 AND link_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER CHECK (decided_by > 0),
  rejection_reason TEXT,
  broadcast_text TEXT,
  correction_text TEXT,
  link_mode TEXT,
  card_message_id INTEGER,
  status_message_id INTEGER,
  post_message_id INTEGER,
  posting_started_at INTEGER,
  posted_at INTEGER,
  presses INTEGER NOT NULL DEFAULT 0 CHECK (presses >= 0),
  alert_sent_at INTEGER,
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  data_deleted_at INTEGER,
  closed_at INTEGER,
  outcome TEXT,
  CHECK (merged_into IS NULL OR merged_into <> id),
  CHECK (posted_at IS NULL OR (posting_started_at IS NOT NULL AND posted_at >= posting_started_at)),
  CHECK (status <> 'posted' OR posted_at IS NOT NULL)
);

-- Every by-status scan (/open, the cron's checks, retention);
-- data_deleted_at second, so "terminal and not yet finalized" skips the
-- finalized rows.
CREATE INDEX reports_by_status ON reports (status, data_deleted_at);
-- The duplicate check against open targets.
CREATE INDEX reports_by_link_hash ON reports (link_hash);
-- A reporter reference's reports (limits, blocks).
CREATE INDEX reports_by_reporter_ref ON reports (reporter_ref);
-- The rows merged into a primary (routing, finalization, the cascade);
-- merged rows only.
CREATE INDEX reports_by_merged_into ON reports (merged_into) WHERE merged_into IS NOT NULL;
-- One report per post: neither the post job's write nor /attach, which
-- records a human-supplied message id, can give two reports the same post
-- (every post is in the one broadcast chat, BROADCAST_CHAT_ID); posted rows
-- only.
CREATE UNIQUE INDEX reports_by_post_message_id ON reports (post_message_id) WHERE post_message_id IS NOT NULL;

-- The approval record (critical invariant 1): the approving admin's numeric
-- id, the time and the start time, under approval_id, a random id that
-- every approval and every re-approval writes afresh. The post derives from
-- an un-voided row, and the row is the schedule: "approved, not voided,
-- starts_at reached". The post job carries the approval_id it was enqueued
-- for, and its claim binds that id, so a job of a cancelled approval never
-- posts under a re-approval, and a timestamp is never the key. Cancel sets
-- voided_at; a re-approval upserts over the voided row with a new
-- approval_id. Deleted at finalization, and with its report.
CREATE TABLE approvals (
  report_id TEXT NOT NULL PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE CHECK (length(approval_id) = 20 AND approval_id NOT GLOB '*[^a-z]*'),
  admin_id INTEGER NOT NULL CHECK (admin_id > 0),
  approved_at INTEGER NOT NULL,
  link_mode TEXT NOT NULL,
  recommended_comment TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  voided_at INTEGER,
  CHECK (starts_at >= approved_at)
) WITHOUT ROWID;

-- Un-voided approvals by start time, for the approvals-side reads of the
-- due starts. The due query joined with the report's status is driven from
-- reports_by_status instead, few reports being approved at any one time.
CREATE INDEX approvals_due ON approvals (starts_at) WHERE voided_at IS NULL;

-- Critical invariant 1 in the schema itself: an update of the status that
-- leaves a report approved or posting is refused unless the report has an
-- un-voided approval, so an approval or a re-approval that writes the status
-- before its approval row, or a claim whose approval was voided meanwhile,
-- fails and its batch rolls back. The post job's claim binds the
-- approval_id as well, which this trigger cannot know.
CREATE TRIGGER reports_need_approval
BEFORE UPDATE OF status ON reports
FOR EACH ROW
WHEN NEW.status IN ('approved', 'posting')
  AND NOT EXISTS (SELECT 1 FROM approvals WHERE report_id = NEW.id AND voided_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a report is approved or posting only with an un-voided approval');
END;

-- The force-reply prompts awaiting an admin's reply (the recommended
-- comment, the retraction text). Message ids are
-- per chat, hence the key; the reply is matched on the replier's
-- allowlisted id and the replied-to message id. Deleted on completion, by
-- the retention job after 24 hours, at finalization and with its report.
CREATE TABLE admin_prompts (
  chat_id INTEGER NOT NULL,
  prompt_message_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL CHECK (admin_id > 0),
  report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  link_mode TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, prompt_message_id)
) WITHOUT ROWID;

-- A report's prompts (finalization, the cascade).
CREATE INDEX admin_prompts_by_report ON admin_prompts (report_id);

-- Per reporter reference: the intake limits, the rejection throttle and the
-- block list (doc/product/review-and-abuse-controls.md). Expires after 90
-- days without activity; a blocked row persists.
CREATE TABLE reporter_stats (
  reporter_ref TEXT NOT NULL PRIMARY KEY CHECK (length(reporter_ref) = 64 AND reporter_ref NOT GLOB '*[^0-9a-f]*'),
  open_count INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  day TEXT CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  day_count INTEGER NOT NULL DEFAULT 0 CHECK (day_count >= 0),
  rejections_30d INTEGER NOT NULL DEFAULT 0 CHECK (rejections_30d >= 0),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  last_seen TEXT NOT NULL CHECK (last_seen GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) WITHOUT ROWID;

-- Daily counts (the global non-member intake cap, the day's presses
-- against MARKS_PER_DAY and the like), keyed by day first, so the primary
-- key serves the by-day reads and the 90-day deletion.
CREATE TABLE counters (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, key)
) WITHOUT ROWID;

-- The aggregate row that outlives its report (critical invariant 8):
-- category, platform, day-level dates, outcome, the press count and the
-- keyed link hash, which lets a later review card say "previously reported,
-- outcome X".
CREATE TABLE stats (
  report_id TEXT NOT NULL PRIMARY KEY CHECK (length(report_id) = 20 AND report_id NOT GLOB '*[^a-z]*'),
  category TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_day TEXT NOT NULL CHECK (created_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  decided_day TEXT CHECK (decided_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  closed_day TEXT CHECK (closed_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome TEXT,
  presses INTEGER NOT NULL DEFAULT 0 CHECK (presses >= 0),
  link_hash TEXT NOT NULL CHECK (length(link_hash) = 64 AND link_hash NOT GLOB '*[^0-9a-f]*')
) WITHOUT ROWID;

-- The review card's "previously reported" lookup.
CREATE INDEX stats_by_link_hash ON stats (link_hash);

-- The work the one-minute cron drains: `post` (the single post of an
-- approved report, gated on its approval row) and `edit` (retraction and
-- closure editing that post). One job per kind and report; an enqueue never
-- resets an existing one, which keeps its payload, attempts and due time.
-- Deleted on completion, at finalization and with its report.
CREATE TABLE jobs (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 20 AND id NOT GLOB '*[^a-z]*'),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'edit')),
  report_id TEXT NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  due_at INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE (kind, report_id)
) WITHOUT ROWID;

-- The cron's due query.
CREATE INDEX jobs_due ON jobs (due_at);

-- Global state, one row per key; an absent key reads as its default:
-- - schema_version: the schema this file leaves, raised by each later file
--   that changes it
-- - halted: /halt holds the posts and the closure edits
-- - paused_until: the global 429 pause, honoured by every job
-- - lockdown: the keyholder's switch, set by /lockdown and cleared only by
--   /unlock from a keyholder; under it nothing runs but a keyholder's
--   /retract (the LOCKDOWN secret is its override, outside D1)
-- A value is an integer or a text of at most 64 characters. The INTEGER
-- affinity stores a whole-number REAL as an integer before the check, and
-- node:sqlite binds every JavaScript number as a REAL.
CREATE TABLE meta (
  key TEXT NOT NULL PRIMARY KEY,
  value INTEGER CHECK (typeof(value) IN ('integer', 'text') AND length(value) <= 64)
) WITHOUT ROWID;

INSERT INTO meta (key, value) VALUES ('schema_version', 1);
