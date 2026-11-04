---
type: runbook
title: "Fallback deployment and the yearly drill"
description: "Running the Node port of the bot when Cloudflare is out of reach: obtaining a host, deploying the Docker image with the keyholder's values, the webhook deleted by the port itself, verifying a /start and a posted report, announcing re-submission in the channel; operating it, lockdown included; switching back to the Worker; destroying the port's SQLite database; and the yearly drill's checklist, recorded in an audit doc."
status: active
tags: [runbook, operations, fallback, node, docker, drill, keyholder]
timestamp: 2026-11-04T00:00:00Z
---

# Fallback deployment and the yearly drill

For the keyholder and the owner. The bot runs on Cloudflare Workers; its
fallback is the Node port of the same code, run in Docker on any host that
can reach `api.telegram.org`
([ADR 0001](../architecture/adr-0001-runtime-and-hosting.md)). Nothing in
this procedure needs a Cloudflare account, because the fallback exists for
the day that account is suspended or out of reach. The
[operations and security runbook](./operations-and-security.md) holds
everything else (who holds which value, lockdown, incidents); section 6
there points here.

## 1. What the port is

- The same bot. `src/node.ts` composes exactly what the Worker composes:
  the same handlers, the same allowlist and lockdown gates, the same error
  boundary, the same link policy. Only the transport and the storage differ.
- Long polling instead of the webhook. The port asks Telegram for updates
  (`getUpdates`, `message` and `callback_query` only) and handles them
  concurrently. It opens no inbound port and runs no HTTP server. It deletes
  the webhook itself every time it starts, because Telegram refuses
  `getUpdates` while a webhook is set. A webhook set while it runs makes it
  yield: it alerts the keyholders and stops for good (section 5). Updates
  Telegram kept while the Worker was unreachable (it keeps them for up to
  24 hours) are handled like any other.
- A minute loop instead of the cron. Once a minute, at the minute's start,
  the port runs the Worker's own run: the due post, the edit jobs,
  reconciliation every 15th minute, the retention job at 00:15 UTC and the
  monthly snapshot on the first day at 06:00 UTC. A minute that comes while
  the previous run is still going is skipped, never run twice.
- A SQLite file instead of D1. The port starts on an empty database and
  applies the same migrations as D1 (`migrations/`). It refuses to start
  when a migration fails. The file sits in a Docker volume, owner-only, and
  SQLite overwrites deleted rows in it (`secure_delete`); what that does not
  reach on the disk is section 7's.
- Nothing is carried over from D1: not the open reports, not the reporter
  counters, not the statistics. The reporter-reference key may be a new
  one.
- Logs are the redacting logger's one-line JSON records on the container's
  output (`docker compose logs`): event names, error classes and counts,
  never a URL, a text or an id. On Node 22 the first lines include Node's
  own notice that `node:sqlite` is experimental.
- Differences that matter to the keyholder:
  - `/lockdown` and `/unlock` work as on the Worker, through the same
    `meta` row in the database.
  - The `LOCKDOWN` override is a line in the port's `.env` file, read at
    start only: setting or clearing it takes a restart (section 5).
  - `scripts/wipe.sh` is the Worker's wipe and does not apply here. The
    port's equivalent is to stop it and destroy its database (section 7).
  - The approval notices are remembered by the one process. A restart
    forgets them, as a new Worker isolate does. A forgotten notice keeps its
    text until its own Cancel is pressed.

## 2. Obtain a host

- A foreign VPS needs a payment path; an Iranian VPS needs a tunnel to
  `api.telegram.org`. Both are the owner's operational choices at the time
  ([ADR 0001](../architecture/adr-0001-runtime-and-hosting.md)).
- The host needs Docker Engine with the Compose plugin, outbound HTTPS to
  `api.telegram.org`, and, for the build, outbound HTTPS to Docker Hub
  (the `node:22-slim` image) and the npm registry (the three production
  packages). It needs no inbound port.
- Treat the host as seizable: it holds the bot token and the open reports.
  Use full-disk encryption where the provider offers it, an account that
  only the keyholder or the owner uses, and no shared shells. Provider
  snapshots and backups are copies of the database: turn them off.
- Never run two ports with the same token. Each port's `getUpdates` ends
  the other's, and the one that gets the conflict stops.

## 3. Deploy

From the keyholder's or the owner's machine, on the host:

1. Get the code at the commit to deploy: a `git clone` of the repository,
   or an archive of it. It holds no secret.
2. Create the environment file: `cp .env.example .env`, then fill in
   `.env` (never `.env.example`, which is committed) from the keyholder's
   records ([operations and security runbook](./operations-and-security.md),
   section 1.4), and run `chmod 600 .env`:
   - `BOT_TOKEN`, `BOT_ID`, `BOT_USERNAME`: the bot's. After a token
     compromise, the re-issued token.
   - `ADMIN_IDS`, `KEYHOLDER_IDS`: numeric ids, no id in both lists.
   - `ADMIN_CHAT_ID`, `MEMBERSHIP_CHAT_ID`, `BROADCAST_CHAT_ID`: the review
     venue, the membership chat and the channel.
   - `REPORTER_REF_KEY`: the existing key or a new one. Nothing is carried
     over, so a new one loses nothing.
   - `WEBHOOK_SECRET`, `WEBHOOK_PATH_SEGMENT`: the configuration requires
     them, but the port uses no webhook. Set fresh values of `A-Z`, `a-z`,
     `0-9`, `_` and `-`, never the Worker's own. The port needs no webhook
     step either: it deletes the webhook itself at start (section 1).
     `npm run set-webhook:delete`, the operations runbook's script, deletes
     it without starting anything; it is for cleaning up, not part of the
     switch.
   - The tunables keep their defaults. `SQLITE_PATH` stays empty:
     `docker-compose.yml` sets it to the volume's file.
   - Never define `DEBUG`, `NODE_DEBUG` or `NODE_DEBUG_NATIVE`, with any
     value: each switches on debug lines past the redacting logger, and
     with `NODE_DEBUG=fetch` Node would print every Bot API request, the
     token in its path. The port refuses to start with any of them.
3. Start it: `docker compose up -d --build`.
4. Watch it start: `docker compose logs -f div-report`. On an empty
   database you see `port.migrated` with `"count":2` (the migrations
   applied), then `port.started`. Any of the following means the port
   refused to start and exited with code 1, before polling:
   - `config.invalid`: a value missing or malformed. The line names no
     value; check `.env` against `.env.example` and
     `doc/guides/developer-setup.md`, section 6.
   - `port.database_failed`: the volume or the file could not be opened.
   - `port.migration_failed`: a migration failed. Nothing ran, and nothing
     was sent.
   - `port.webhook_not_deleted`: Telegram refused or could not be reached;
     a `telegramErrorCode` of 401 means the token is wrong or was revoked.

   Docker restarts a port that exited with a failure (`restart:
   on-failure`), so fix `.env` and run `docker compose up -d` again. Docker
   does not bring the port back after a reboot of the host by itself: run
   `docker compose up -d` after every reboot.

## 4. Verify

1. Every keyholder sends `/start` to the bot in their private chat and gets
   the confirmation that alerts will reach them. This proves the updates
   flow through the port, and the keyholders' chats are what the alerts
   need.
2. A posted report, end to end: from an ordinary account, report a public
   link on an allowed platform that harms nobody. An admin approves it in
   the venue with a recommended point. The keyholders get the approval
   notice with Cancel and Lockdown. After the grace period the post
   appears in the channel with its "I reported it" button. In a real
   fallback this can be the first real report instead.
3. In a real fallback, announce in the channel that open reports must be
   submitted again: the reports open on the Worker were not carried over.
   There is nothing to re-subscribe; members keep reading the channel.

## 5. Operating the port

- Lockdown: `/lockdown` and `/unlock` from a keyholder, as on the Worker
  ([operations and security runbook](./operations-and-security.md),
  section 3.6). The override: set `LOCKDOWN=1` in `.env`, then run
  `docker compose up -d`, which recreates the container. The variable is
  read at start only, so it takes that restart to set it and to clear it;
  `/lockdown` acts at once.
- `/attach`, `/repost`, `/halt`, `/close`, `/retract`, `/stats` and
  `/budget` work as on the Worker; the incidents of the operations runbook,
  section 7, apply.
- Stopping: `docker compose stop` sends SIGTERM. The port stops polling,
  waits for the updates being handled and the run in progress (at most 50
  seconds, inside the compose file's 60-second grace), closes the database
  and logs `port.stopping`, then `port.stopped`. A second SIGTERM ends it
  at once.
- The port yields when a webhook is set for the bot while it runs
  (Telegram's 409 "webhook is active"): it logs `polling.webhook_set`,
  sends every keyholder the alert that the fallback port has stopped,
  stops, and exits with code 0, which `restart: on-failure` does not
  restart, so the webhook keeps the bot. If nobody meant to set a webhook,
  re-issue the token from the BotFather owner account
  ([operations and security runbook](./operations-and-security.md),
  section 7).
- The port stops by itself, logs `polling.stopped`, exits with code 1, and
  Docker restarts it, when:
  - Telegram answers 401: the token was revoked or re-issued. Put the new
    token in `.env` and run `docker compose up -d`.
  - Telegram answers the other 409, "terminated by other getUpdates
    request": another port polls with the same token. Stop one of them
    (section 2).
  - Fetching has failed for 15 hours on end. Each failed fetch is logged
    as `polling.failed` and retried after a wait that grows by a tenth of
    a second each time.
- After a reboot of the host, start the port again with
  `docker compose up -d`: Docker does not bring it back by itself.
- `port.crashed` (an unexpected error, logged by class) is followed by an
  exit and a restart by Docker. Repeated crashes are a bug to report with
  the log lines.
- The logs are rotated by the compose file (three files of 10 MB).

## 6. Switching back to the Worker

The port deletes the webhook every time it starts, so the order matters:

1. Stop the port for good: `docker compose down`, which stops and removes
   the container, so Docker does not restart it.
2. Register the webhook again from the keyholder's machine:
   `npm run set-webhook -- https://div-report.<account subdomain>.workers.dev`
   ([operations and security runbook](./operations-and-security.md),
   section 2.1), with the Worker's own values in the environment, never the
   port's `.env`: its `WEBHOOK_SECRET` and `WEBHOOK_PATH_SEGMENT` are fresh
   ones (section 3), and a webhook registered with them would be answered
   404 by the Worker. The printed answer shows the Worker's origin with
   `<WEBHOOK_PATH_SEGMENT>`, `message` and `callback_query`, and
   `max_connections` 10.
3. Announce in the channel that reports still open on the port must be
   submitted again. The port's database is not carried over to D1.
4. Destroy the port's database (section 7) once nothing in it is needed.

If the webhook is set while the port still runs, the port's next
`getUpdates` gets a 409: the port alerts the keyholders, stops and stays
stopped (section 5), and the webhook keeps the bot. Stopping the port first
is still the order to follow: a port started again later, by hand or after a
reboot, deletes the webhook at once.

A stop or a 409 can leave the last batch the port fetched (up to 100
updates) unconfirmed at Telegram, so after the switch-back the Worker may
receive updates the port already handled on its own store: a second answer
to a `/start`, a report in both stores, a press counted twice. That is why
the reports open on the port are submitted again rather than carried
over.

## 7. Destroying the port's database

- With Docker: `docker compose down --volumes` removes the container and
  the volume `div-report-data`, which holds the SQLite file and its journal.
  Unlike the Worker's wipe, which keeps the aggregate statistics and the
  lockdown switch, this removes everything.
- Without Docker: stop the process (SIGTERM), then delete the file at
  `SQLITE_PATH` (`./data/div-report.sqlite` by default) and its
  `-journal` file beside it, if any.
- In an emergency (an admin seized while the port runs): lock down first
  (`/lockdown`, or `LOCKDOWN=1` and a restart), wait a minute for the
  handlers in flight, then destroy the database as above.
- What this does not reach: the provider's snapshots and backups, and the
  host's disk, where a deleted file's blocks stay until they are reused
  (`secure_delete` only overwrites rows deleted inside a live file). The
  rollback journal is one such file: `journal_mode` stays DELETE (no pragma
  sets it), and the journal holds a copy of every page a transaction
  changes, taken before the change, so a deletion's content can survive in
  the blocks of the unlinked journal whatever `secure_delete` does to the
  database file. Full-disk encryption, no provider snapshots and destroying
  the VPS are the remedies that reach it: when the host itself may be
  seized, destroy the VPS through the provider after the volume.
- The token on the host goes with it: after a seizure of the host, re-issue
  the token from the BotFather owner account
  ([operations and security runbook](./operations-and-security.md),
  section 7).

## 8. The yearly drill

The drill proves that the port starts, receives updates and posts, and
that the keyholder still reaches the accounts. It never uses the
production token: the port deletes the webhook of the token it runs with,
which would take the Worker off the air.

- [ ] A date set; the keyholder and one admin take part.
- [ ] A drill bot created from the BotFather owner account, with its own
      token, never the production one.
- [ ] A drill channel owned by the keyholder, the drill bot its only
      posting administrator, and a drill venue (a private supergroup, the
      drill bot an administrator with `can_delete_messages`). The drill
      channel can serve as the membership chat too.
- [ ] A host obtained as in section 2, which also proves one can be
      obtained.
- [ ] The port deployed as in section 3 with the drill bot's values and
      `APPROVAL_GRACE_MINUTES=1`; the logs show `port.migrated` with
      `"count":2`, then `port.started`.
- [ ] `/start` from the keyholder gets the alert confirmation; `/start`
      from an ordinary account gets the introduction.
- [ ] A test report of a public link that harms nobody, approved, posted
      into the drill channel after the grace; "I reported it" pressed;
      then closed (`/close <id> no_result`) and the post edited
      ([admin review runbook](./admin-review-runbook.md), section 7).
- [ ] `/lockdown` and `/unlock` from the keyholder; the `LOCKDOWN=1`
      override set and cleared, each with a restart.
- [ ] `docker compose stop`: the logs show `port.stopping`, then
      `port.stopped`.
- [ ] The database destroyed as in section 7; the drill bot deleted, or
      kept for next year's drill.
- [ ] The keyholder proves access to the Cloudflare account, the BotFather
      credentials and the channel
      ([operations and security runbook](./operations-and-security.md),
      section 1.3).
- [ ] Recorded in `doc/audits/` as `YYYY-MM-DD-fallback-drill.md` (type
      `audit`): the date, who took part, the kind of host, the commit
      deployed, each item's outcome, and what to fix. Then regenerate the
      indexes with `node scripts/okf/build-index.mjs`.
