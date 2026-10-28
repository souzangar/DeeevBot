---
description: Summon the angel — blunt strongest-model advisor (read-only by instruction) on a plan, the working diff, an impasse, or a completion claim — then engage with every objection.
argument-hint: "[plan|diff|stuck|wrapup|free-text question]"
---

Summon the angel: spawn the `angel` agent (Agent tool, subagent_type
"angel") for counsel before you act. Model and effort are pinned in the
agent definition — spawn with NO model override unless the user explicitly
asked for a different model. Run it synchronously
(run_in_background: false): the point is counsel before proceeding, not
after.

Arguments: $ARGUMENTS

Pick the mode from the first word (`plan`, `diff`, `stuck`, `wrapup`);
anything else — or nothing — is a freeform question (if an approach is
currently being decided, default to `plan`).

The angel sees NONE of this conversation — every prompt must be
self-contained:

- **plan** — before committing to an approach. Inline a brief: the premise
  first — ONE claim about the current system the plan rests on, plus the
  existing mechanisms searched BY CAPABILITY (what already does this job,
  whatever it is called), each with the grep used; the angel re-runs them
  first — then the task as you understand it, intended file-by-file
  changes, invariants you will touch, test plan, open questions. Ask what it
  would do.
- **diff** — a full pass on the working diff. State the base rev (default
  HEAD; if the agenda spans commits, the rev before your first commit) and
  the focus. Improvements, simplification, reuse, missed conventions AND
  bugs/risks/invariant violations — nothing is off-limits. If the diff
  touches critical paths (`.claude/devil/critical-globs.conf`), ALSO launch
  the domain-auditor agent — independent reviewers, ideally in parallel.
- **stuck** — a recurring error or impasse. Inline what you tried, the
  exact errors/observations, and your current hypothesis. Ask for a way
  out.
- **wrapup** — before declaring a multi-step agenda done. Inline the
  agenda as a checklist with per-item status and evidence pointers. Ask
  what is missing or wrong.

A brief kept on disk (a prompt or SendMessage that names a file instead of
inlining it) is verified before it is named: write each revision in the
foreground, then `test -r <file>` and grep the marker it folded in (a
version tag, a new section title) before the spawn or SendMessage names the
file. Never chain a brief patch with a spawn or SendMessage. Assemble briefs
with assert-guarded edits (Edit, or a script that fails unless its anchor
matched exactly once), never with sed ranges derived from a grep. When the
same brief then goes to the devil, pass the marker as `--expect <marker>`
and the script refuses a brief that lacks it.

Afterwards, engage explicitly — nothing is silently dropped:

- Answer EVERY numbered objection: adopt (state the fix, then apply it or
  plan it), adapt, or decline — each with a concrete reason or file:line
  evidence.
- Address substantive suggestions and flags the same way; triage by real
  failure cost — the angel supplies recall, you supply judgment.
- Continue the argument with SendMessage to the SAME agent id (never a
  fresh spawn — it holds the context). State the agent id in your response
  so a later round is possible.

On high-stakes work run both critics: /angel for direction, /devil for
attack. They are NOT symmetric in cost: the angel is bounded only by this
session's quota, the devil spends a scarce external one. So the angel
carries the argument — as many SendMessage rounds as the decision needs —
and the devil enters once, at the end, as the terminal cross-vendor check
on the settled plan or diff. See CLAUDE.md's review-lane rules and
.claude/kit-docs/WORKFLOW.md.
