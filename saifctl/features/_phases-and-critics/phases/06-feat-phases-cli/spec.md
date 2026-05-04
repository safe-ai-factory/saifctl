# Phase 06 — `saifctl feat phases` CLI

User-facing surface for inspecting and validating phased features
without running the agent. Observability + pre-flight; not strictly
required for `feat run` to work, but multiplies user confidence
(especially when authoring `feature.yml` / `phase.yml` for the first
time).

This is a **user-input boundary** — every flag, every output, every
exit code becomes contract. Subtle handling errors here (silent
fallthroughs on validation, ambiguous error messages, missing
permissions checks) are easy to miss and become support burden later.
Hence audit×2 on this phase.

## Files to add

- `src/cli/commands/feat-phases.ts` — subcommands:
  - `phases compile <feature>` — write a deterministic compiled
    output (the `RunSubtaskInput[]` that phase 03 would produce).
    Diff-friendly, reviewable, gives the user a way to inspect what
    the loop will see.
  - `phases validate <feature>` — run schema validation, file
    existence checks, glob expansion, mutability resolution; report
    errors and warnings without running anything. Auto-runs as a
    pre-flight before `feat run`.

  Optionally also:
  - `phases list <feature>` — terse output of discovered phases +
    critics (no compilation, no JSON file write). Useful for fast
    "what's in this feature?" answers.

## Files to modify

- `src/cli/commands/feat.ts` — wire as a subcommand of the existing
  `featCommand` (around line ~777) under the key `phases`. Add the
  pre-flight `phases validate` invocation in `parseRunArgs` so
  `feat run` errors out before the orchestrator boots when phase
  config is broken. Skip the auto-run when `--subtasks` is set
  (user is explicitly bypassing phase compilation).

## Clarifications

- **Output path:** `.saifctl/features/<feat>/phases.compiled.json`
  (per-feature, not per-run). Per-run state lives at
  `.saifctl/runs/<runId>/`; the compiled phases output is
  config-derived and should sit next to the feature.
- **Auto-run pre-flight on `feat run`** runs `phases validate` if a
  `phases/` dir exists. On error, exit 1 with the validation report.
  Skip the auto-run when `--subtasks` is passed (user is explicitly
  bypassing phase compilation).
- **Validation that depends on phase 07** (mutability / glob
  expansion against `tests.immutable-files`) can land here as a
  no-op stub and be filled in when phase 07 lands. Don't block this
  phase on mutability resolution.
- **Empty-`phases/` dir handling.** A feature with `phases/` present
  but empty is a misconfiguration; validate should reject with a
  clear error. Don't silently fall back to the legacy path.
- **Multi-feature mode** is a stretch goal here: `feat phases
  validate` (no feature arg) walks the entire features tree and
  validates every phased feature. Useful for CI / pre-commit hooks.
  Make this work if it's cheap; defer otherwise.

## Risk surface (why audit×2)

This phase is the **user-input boundary** for phased features. The
common failure modes:

- A flag's default that elevates access (e.g. `--strict` defaulting to
  `false` would silently make every test mutable across the whole
  repo). Defaults must err toward the safer setting.
- An ambiguous validation error message that points at the wrong
  config file or the wrong line. Users will copy-paste broken YAML
  if the error message is unclear.
- A `phases compile` output that silently differs from what `feat
  run` actually executes. Users rely on this to preview before
  committing — if it lies, the whole observability story breaks.
- Pre-flight that's too strict (rejects valid configs) or too lenient
  (accepts broken configs that then fail mid-run). Both are bad,
  loose-then-strict is worse than tight-then-loose.

The audit critic should specifically check the second pass for any
silent-fallthrough patterns, exit-code inconsistencies, or
preview-vs-run drift.

## What this phase does NOT include

- No new compilation logic — `phases compile` calls phase 03's
  compiler verbatim.
- No mutability enforcement — phase 07 owns that. Validation here
  surfaces shape errors only.
- No documentation roll-up — phase 09.
