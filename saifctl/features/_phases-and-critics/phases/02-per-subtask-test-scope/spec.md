# Phase 02 — Per-subtask test scope (the only loop edit)

The single structural change to the agentic loop. Subtasks gain an
optional `testScope` field; `prepareTestRunnerOpts` /
`runStagingTestVerification` consult it instead of the feature's
whole `tests/` dir. Cumulative behavior includes the current subtask's
tests + all prior phases' tests.

Everything else (subtasks shape, agent script overrides, gate script,
fresh LLM per round) already exists in the loop and is **untouched** by
this phase. If the diff for this phase touches anything outside test-
scope wiring, that's a red flag worth surfacing.

## Files to modify

- `src/runs/types.ts` — add
  `testScope?: { include?: string[]; cumulative?: boolean }` to
  `RunSubtaskInput`.
- `src/orchestrator/loop.ts` — `prepareTestRunnerOpts` (around line
  ~904) and `runStagingTestVerification` (around line ~1337) honor
  `activeRow.testScope`. Cumulative behavior includes the current
  subtask's tests + all prior phases' tests.

## Implementation notes

- **`prepareTestRunnerOpts` is called once today** at loop start. For
  per-subtask scope, either re-prep at each subtask transition (around
  the existing subtask-cursor advance at `loop.ts:1373`) or pre-build
  all scopes upfront keyed by subtask index. Lean toward re-prep at
  transition (lazy, simpler invariants).
- **`tests/public/` and `tests/hidden/` extend into phases.** Phases
  use the same convention: `phases/<id>/tests/public/` and
  `phases/<id>/tests/hidden/`. The hidden-strip logic at
  `sandbox.ts:615` is path-pattern-based; verify (or extend) that phase
  `hidden/` dirs are also removed from the agent's code copy.
- **Project-level `saifctl/tests/` and feature-level
  `features/<feat>/tests/` run only after the last phase**, not at
  every phase. Rationale (mongo→postgres example): a feature-level
  test like *"URL `/a/b/c` works on the new app"* in a multi-phase
  migration *cannot* pass at phase 1 (postgres data duplication) or
  phase 2 (bare express setup) — it's only meaningful after the API
  is reimplemented at phase 3. Putting feat-level / project-level
  tests in early phases' cumulative scope would block every run on
  tests that are correctly failing-by-design until the end.

  Implementation: the compiler (phase 03) emits the **last phase's**
  `testScope` to include `saifctl/tests/` + `features/<feat>/tests/`
  in addition to the cumulative phase tests. Earlier phases' gates
  see only phase-level tests.

  See specification.md §A.4 for the open question on whether
  project-level tests need an opt-in "always-on" subset.

## Cumulative gate model (phase by phase)

- Phase 1 gate: `phases/01/tests/`
- Phase 2 gate: `phases/01/tests/` + `phases/02/tests/`
- …
- Phase N (last) gate: all `phases/*/tests/` cumulative
  + `features/<feat>/tests/`
  + `saifctl/tests/`

## What this phase does NOT include

- No subtask compilation from phases — that's phase 03. This phase
  only wires `testScope` into the loop's gate machinery; the field is
  populated by the compiler (or by the manifest writer, for legacy
  `--subtasks` flows).
- No new CLI surface.
- No critic-prompt rendering.
