# Phase 08 — Plan-deviation prompts + modification-surfacing warnings

A soft directive on every implementer/critic round prompt + a
post-round modification surfacer. Ships together because both are
about making plan/spec/test drift visible without forcing it. Cheap
phase; could ship anytime after phase 04 in principle, but lands here
so it benefits from the tighter boundary phases above.

## Files to modify

- `src/orchestrator/agent-task.ts` — append a directive to every
  implementer/critic prompt:

  > If your implementation deviates from the original plan or spec,
  > update `{{feature.plan}}` and the relevant `spec.md` to reflect
  > the actual implementation.

  Soft directive only. Saifctl does **not** enforce that the agent
  updated these files — most rounds won't deviate.

## Files to add

- `src/orchestrator/post-round-warnings.ts` (or add to `loop.ts`
  directly if cleaner) — after each round, inspect
  `git diff --name-only <round-base>..HEAD` and emit an informational
  warning to the run log when the modified set intersects any of:
  - `<feature.plan>` (typically `plan.md`)
  - any `spec.md` in the feature
  - any test file (under `saifctl/tests/`,
    `saifctl/features/<feat>/tests/`, or
    `saifctl/features/<feat>/phases/*/tests/`) — regardless of
    mutability

  **Exclude** `/workspace/.saifctl/critic-findings/**` from this glob
  — per phase 04 the critic discover step writes findings files into
  that dir, and the fix step deletes them. Both are expected
  transient artifacts, not noteworthy modifications.

  Format: `[round N] Agent modified the following plan/spec/test
  files: <list>`. Non-fatal. Independent of phase 07's mutability
  enforcement (which fails the gate when *immutable* tests are
  touched; this warning surfaces *all* such modifications including
  permitted ones).

  Rationale: surfaces noteworthy changes for unattended overnight
  runs without forcing the user to read the full diff to find them.

## Clarifications

- **Warning destination:** `consola.warn` to the run log (visible in
  realtime), AND a structured append to
  `.saifctl/runs/<runId>/modifications.log` (newline-delimited JSON,
  one record per warning, for post-hoc grep-ability after long runs).
- **De-duplication.** If the same file is modified across consecutive
  rounds, emit one warning per round (don't try to be clever about
  collapsing — the user wants to see frequency, not just presence).
- **Engine-aware path rendering for the directive.** The directive's
  path (`{{feature.plan}}`) needs to be rebased depending on whether
  the agent runs in a container or on the host. In container mode,
  paths are workspace-relative (resolve under `/workspace/`); in host
  mode (`--engine local`), paths are host absolute. Use a `workspace:
  AgentWorkspace` parameter on the prompt builder to encode the
  difference.
- **Probe before emitting.** Don't emit a deviation directive for a
  plan file that doesn't exist on disk — the agent would then fail to
  read it and might fabricate content instead. Probe
  `<feature>/plan.md` and `<workspace-root>/plan.md`; emit the
  directive only when one exists. Spec-only fallback (feature exists
  but no plan): widen to "update the relevant `spec.md`". Neither
  present: omit.

## What this phase does NOT include

- No documentation roll-up — phase 09.
- No new CLI surface.
- No mutability enforcement — phase 07.
