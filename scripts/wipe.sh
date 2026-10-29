#!/usr/bin/env bash
# The emergency wipe (critical invariant 8; doc/guides/operations-and-security.md,
# section 7; doc/product/threat-model-seizure.md, control 5; ADR 0004): deletes
# every row of every table of the bot's D1 database except `stats` (the
# aggregate rows that outlive their reports) and `meta` (the schema version,
# /halt, the pause and the lockdown switch, which stays set), so the live
# database holds no report, reporter reference, URL, comment, prompt, job or
# counter afterwards. It is not part of the Worker: the keyholder runs it from
# their own machine, with wrangler logged in to the Cloudflare account, AT
# LEAST ONE MINUTE AFTER setting lockdown (/lockdown, the Lockdown button, or
# `wrangler secret put LOCKDOWN`), because handlers already in flight may
# write for up to 30 seconds after the switch.
#
# It defends against the seized admins, not against a seized Cloudflare
# account: D1 keeps a 30-day point-in-time history of the database (Time
# Travel), which the account holder can restore. When the account itself is
# in doubt, the second step is `wrangler d1 delete div-report` and a new
# database (the runbook's procedure), which also removes that history, and
# also works when D1 refuses queries (a daily cap exhausted).
#
# Usage: scripts/wipe.sh [--local]
#   --local   a rehearsal on the local database of `wrangler dev` (see
#             `npm run migrate:local`), never the deployed one
# It asks for the database's name to be typed before anything runs.
# test/invariants/wipe.test.ts pins WIPE_SQL to "every table but stats and
# meta": a table a later migration adds is added here in the same change.
set -euo pipefail

DATABASE='div-report'
# The tables that reference a report first, then the reports, then the rest.
WIPE_SQL='DELETE FROM drafts; DELETE FROM admin_prompts; DELETE FROM jobs; DELETE FROM approvals; DELETE FROM reports; DELETE FROM reporter_stats; DELETE FROM counters;'

target='--remote'
case "${1:-}" in
  '') ;;
  --local) target='--local' ;;
  *)
    echo 'usage: scripts/wipe.sh [--local]' >&2
    exit 2
    ;;
esac

cat >&2 <<EOF
The emergency wipe deletes every row of every table of the D1 database
'${DATABASE}' (${target#--}) except stats and meta.
- Lockdown must have been set at least a minute ago.
- D1 Time Travel keeps a 30-day history that the Cloudflare account holder
  can restore. If the account itself is in doubt, follow with
  'wrangler d1 delete ${DATABASE}' (the operations runbook, section 7).
Type the database's name to go on:
EOF
read -r answer
if [ "${answer}" != "${DATABASE}" ]; then
  echo 'Not confirmed: nothing was run.' >&2
  exit 1
fi
npx wrangler d1 execute "${DATABASE}" "${target}" --command "${WIPE_SQL}"
