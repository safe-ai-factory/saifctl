# `_phases-example` plan

A toy two-phase feature that validates input then emits output. Used purely
as a reference for the Block 4 critic-prompt contract — no production code
ships from this directory.

## Phases

1. `01-validate-input` — parse the input, reject malformed records.
2. `02-emit-output` — transform validated records into the output format.

Each phase has its own spec under `phases/<id>/spec.md`. A real feature
would also ship `phases/<id>/tests/` populated with assertions; this
doc-only example intentionally ships no tests, so the gate degrades to a
no-op (the compiler emits paths to missing test dirs and the test runner
silently skips them — see `compile.ts` `buildPhaseTestScope`). Critic
templates still describe the cumulative gate so the prompt shape matches
production usage; copy this example, then add real tests under each
phase before running it for real.
