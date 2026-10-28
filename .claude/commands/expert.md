---
description: Delegate a coding/discovery/exploration task to the expert (strong model, max effort, full tools) — then review its diff, run the suites, and commit yourself.
argument-hint: "<task to delegate>"
---

Delegate to the expert: spawn the `expert` agent (Agent tool,
subagent_type "expert") to execute a task. Model and effort are pinned in
the agent definition — always, regardless of the session model; spawn with
NO model override.

Arguments: $ARGUMENTS

The expert sees NONE of this conversation. Compose a SELF-CONTAINED brief
from the arguments plus the context you hold:

- the goal and concrete acceptance criteria;
- files/modules in scope — and what must NOT be touched;
- the invariants in play (call out critical paths explicitly; name the
  relevant CLAUDE.md rules rather than assuming it will infer them);
- known context it cannot discover cheaply (decisions already made, prior
  attempts, gotchas);
- how to verify (which specs/suites to run).

Run it synchronously for short tasks; use run_in_background: true for long
ones — and never report delegated work as done without verifying the
result yourself.

Supervisor duties when it returns — non-negotiable:

- Review the FULL diff yourself (`git diff`), file by file.
- Run the project's gates (the unit/build commands named in CLAUDE.md's
  Commands section; plus targeted integration/e2e suites when the change
  warrants).
- On any diff touching critical paths (`.claude/devil/critical-globs.conf`):
  run the domain-auditor agent — and `/devil diff` for high stakes — before
  committing.
- YOU make the commit — the expert never commits.
- Route review findings back with SendMessage to the SAME expert id (it
  holds the context — never a fresh spawn). State the agent id in your
  response so later rounds are possible.
