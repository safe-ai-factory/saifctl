# Phase 07 — Test mutability: model, enforcement, project-level dir

The end-to-end workflow unlock. Larger surface area than earlier
phases because three things ship together:

1. The three-layer mutability model (`saifctl/tests/` always-immutable,
   feature/phase tests config-driven).
2. Diff-inspection enforcement after each round.
3. The `--strict` / `--no-strict` CLI flag + project-default plumbing.

After this phase, `saifctl/tests/` works as a true contract dir and
the agent cannot silently rewrite tests it wasn't asked to touch.

See `../../specification.md` §2.6 for the resolved mutability model.

## Files to add

- `src/specs/tests/mutability.ts` — given a feature/phase config and a
  set of test file paths, classify each as mutable or immutable per
  the three-layer model in `../../specification.md` §2.6.
- `saifctl/tests/` directory convention support — discovered and
  always run as part of every feature run; always immutable.

## Files to modify

- `src/specs/discover.ts` — surface project-level `saifctl/tests/`
  alongside feature tests; ensure feature-level
  `saifctl/features/<feat>/tests/` continues to be discovered when
  `phases/` also exists (both coexist; both contribute to cumulative
  test set per `../../specification.md` §6's "Feature-level tests…"
  decision).
- `src/orchestrator/loop.ts` — after each round, before tests run, do
  the diff inspection: `git diff <round-base>..HEAD -- <immutable
  paths>`; if non-empty, fail the gate with a message naming
  offending paths.
- `src/cli/args.ts` and feature-level config loader — add `--strict` /
  `--no-strict` flag plumbing; default `true` (strict). Read project
  default from `~/.saifctl/config.yml.defaults.strict` if present.
- `src/cli/commands/feat.ts` — `design-fail2pass` skips when phase
  has `tests.mutable: true` and `tests.fail2pass` is unset. Confirmed
  location: `_runDesignFail2pass`.

## Clarifications

- **`tests.enforce: 'read-only'` deferred to v2.** Implementing
  read-only mounts inside the existing workspace bind-mount is
  non-trivial (requires per-dir overlay mounts or a separate
  bind-mount layer), and diff-inspection covers the use case for most
  projects. Document the field in the schema (so users can set it in
  anticipation), but reject it at validate time with "not implemented
  in this release; use diff-inspection." Ship in v2.

  Note: phase 01 already lands the validator-side rejection of
  `'read-only'`, so this phase shouldn't re-implement it.
- **Round-base for diff inspection** = the git rev at the start of
  this round (i.e., before the agent ran). Already tracked as
  `perSubtaskPreRoundHead` in the loop. Reuse that.
- **`--no-strict` interaction with the existing `dangerousNoLeash`
  flag** — these are distinct concepts. `dangerous-no-leash` removes
  the gate/test guarantee entirely; `--no-strict` only relaxes
  test-file mutability. Document the difference explicitly in CLI
  help. Default-elevates-access is the failure mode the audit critic
  must guard against here.

## Risk surface

Mutability enforcement is one of the few places where saifctl makes a
hard guarantee to the user ("the agent cannot edit immutable tests").
A hole in this enforcement (missed glob, off-by-one in path
classification, wrong base ref for the diff) silently breaks that
guarantee in a way the user won't notice until trust is already lost.

Specifically:
- `--strict` defaulting to `false` would invert the safety contract
  project-wide. Default MUST be `true` and the resolver MUST never
  silently flip without an explicit input.
- `saifctl/tests/` mutability MUST be hard-coded immutable, never
  overridable.
- The diff base for inspection MUST be the round's pre-agent head,
  not the previous gate-pass head (which can include earlier-round
  agent commits).

## What this phase does NOT include

- No critic-prompt rendering changes.
- No deviation directive — phase 08.
- No documentation — phase 09.
