# Phase 01 — Phase config: schema, loader, validator

The data model. No execution. Pure "shapes exist and reject bad input."

This phase implements the canonical persistence + validation for
`feature.yml` and `phases/<id>/phase.yml`, plus filesystem discovery of
phases and critics. The CLI that exposes the validator (`feat phases
validate`) lands in phase 06; the compiler that consumes the validated
records lands in phase 03. This phase is the data foundation everything
else builds on.

See `../../specification.md` §1 (filesystem shape) and §2 (configs) for
the resolved contract.

## Files to add

- `src/specs/phases/schema.ts` — Zod schemas for `feature.yml` and
  `phase.yml`. Closed key set; `.strict()` so unknown keys fail fast.
- `src/specs/phases/load.ts` — read + validate both files; resolve
  inheritance (`phase.yml` ← `feature.yml.phases.defaults` ←
  `feature.yml` ← built-in defaults). **No key-level merge for
  list-valued keys** (a `phase.yml.critics:` declaration replaces the
  inherited list entirely).
- `src/specs/phases/discover.ts` — scan `phases/<id>/` dirs and
  `critics/<id>.md` files; cross-check against
  `feature.yml.phases.order` and per-phase `critics:` references. Fail
  loudly on any mismatch.

## Validation rules to enforce

- Referenced critic id must correspond to an existing `critics/<id>.md`.
- Referenced phase id (in `feature.yml.phases.order`) must correspond to
  an existing `phases/<id>/` directory.
- `phases:` section in `feature.yml` is meaningful only when a `phases/`
  dir exists; if set without one, error.
- `tests.immutable-files` globs that contain `..` segments or absolute
  paths ⇒ error.

## Clarifications (load-bearing for later phases)

- **File extension precedence.** When multiple of `feature.{yml,yaml,json}`
  exist in the same dir: error (refuse to silently pick one). Same for
  `phase.{yml,yaml,json}`.
- **Route-group interaction.** Existing `src/specs/discover.ts` supports
  Next.js-style route groups (`saifctl/features/(auth)/login/`). Phases
  live under the resolved feature dir, so a feature `(auth)/login` can
  have `phases/01-x/` etc. Phase ids must NOT start with `(` (avoid
  future ambiguity with route-group syntax). Reject in validator.
- **Phase-id charset.** Restrict to `[a-z0-9][a-z0-9_-]*` (lowercase
  kebab/snake). Same constraint already applied to feature names in the
  `new` command. Avoids cross-OS path issues.

## What this phase does NOT include

- No CLI surface — `feat phases validate` is phase 06.
- No subtask compilation — that's phase 03.
- No mustache rendering for critic templates — that's phase 04.
- No mutability enforcement — that's phase 07. The schema parses
  `tests.mutable` and `tests.enforce`; validation of those values lands
  here only insofar as `tests.enforce: 'read-only'` is rejected as
  "not implemented in this release; use 'diff-inspection'" (deferred to
  v2). The Zod schema parses `'read-only'` so users can future-proof
  their config files.
