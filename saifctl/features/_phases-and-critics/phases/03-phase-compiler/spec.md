# Phase 03 — Phase → subtasks compiler

The first end-to-end working version of phased features. Given the
validated phase records from phase 01 and the project's discovered
tests dirs, this phase produces a `RunSubtaskInput[]` deterministically:
one implementer subtask per phase, plus N critic subtasks per phase per
critic per round.

After this phase, `saifctl feat run <feature>` works end-to-end for
phased features. No mustache rendering yet — critic subtasks receive
their `critics/<id>.md` body raw (mustache lands in phase 04).

**This is the highest-blast-radius phase of the implementation** (it's
the wire-up that everything else routes through), which is why
`phase.yml` here sets `audit` to `rounds: 2`.

## Files to add

- `src/specs/phases/compile.ts` — phase records → `RunSubtaskInput[]`.
  One implementer subtask per phase, plus 2 subtasks per critic per
  phase per round (discover + fix; the fix template in phase 04).

## Files to modify

- `src/orchestrator/resolve-subtasks.ts` — add a new "from phases"
  source alongside existing `subtasks.json` / `plan.md` sources. When
  `phases/` exists in the feature, prefer phase-compilation; fall back
  to legacy resolution otherwise.
- `src/specs/discover.ts` — recognise `phases/<id>/` as feature-internal
  phase dirs; expose `feature.phases?: PhaseInfo[]` on the discovered
  `Feature` record (or have the compiler call `discoverPhases` directly,
  whichever is cleaner — the as-written plan suggests surfacing on
  `Feature`, but a leaner alternative is to call `discoverPhases` from
  the compiler).

## Clarifications

- **Subtask source resolution is mutual exclusion, not priority.**
  Within a single feature, the following are mutually exclusive sources
  of truth for what subtasks to run; if more than one is present in the
  feature dir, **fail at validate time** with a clear error naming the
  conflicting sources:
  - `phases/` directory (new — phase compilation, this phase)
  - `subtasks.json` file (existing — manual subtask manifest)
  - neither (existing — fall back to synthesising one subtask from
    `plan.md` + spec via `synthesizePlanSpecSubtaskInputs`)

  Phases are an opinionated abstraction *over* `subtasks.json` (both
  normalize to `RunSubtaskInput[]` before reaching the loop), so
  using both is incoherent. Same for "phases AND plan-only" — phases
  imply plan-only is bypassed.

  The current `resolveSubtasks` priority chain at
  `resolve-subtasks.ts:142` silently picks the first present source.
  Replace with an explicit mutual-exclusion check that errors when
  conflicting feature-dir sources coexist.

- **`--subtasks <file.json>` is pinned as an undocumented escape hatch
  on `feat run`.** Currently exposed via `featRunArgs` ←
  `featRunCoreArgs.subtasks`. Behavior:
  - When `--subtasks` is present, it **overrides** any feature-dir
    source (phases/, subtasks.json, plan-only). The override is
    intentional; do NOT raise the mutual-exclusion error on top of it.
  - When `--subtasks` is absent, the mutual-exclusion check applies
    to feature-dir sources only (phases/ vs subtasks.json vs neither).
  - **Hide from `feat run --help`** — set the arg's description to
    something terse like `'(internal escape hatch; prefer phases/ or
    subtasks.json in the feature dir)'`. The flag remains functional
    for emergency use; documentation does not promote it.

- **Scripts threading.** Each compiled subtask needs `agentScript`,
  `gateScript`, `gateRetries`. These come from CLI / saifctl config
  today and apply uniformly. The compiler should set them on every
  emitted subtask from the resolved per-phase config (with feature/
  phase override priority per the resolution order in
  `../../specification.md` §2.3).

- **Compiled task content links, doesn't inline.** Implementer subtask
  content reads roughly:
  > *"Implement `<phase.id>` of feature `<feature.name>` per
  > `<phase.spec>`. Read `<feature.plan>` for the broader plan. Write
  > code in /workspace; do NOT modify files in /<saifctlDir>/ or in
  > immutable test paths."*

  Critic subtask content is the raw `critics/<id>.md` body until
  phase 04 wires mustache rendering on top.

## What this phase does NOT include

- No mustache rendering — phase 04. The compiler emits the raw
  `critics/<id>.md` body so phase 04 has something to render.
- No `feat phases` CLI surface — phase 06.
- No mutability enforcement — phase 07. The compiler does emit the
  `testScope` per phase 02's contract; mutability is the loop's job
  later.
- No deviation directives or modification surfacer — phase 08.

## Risk surface

The compiler is the wire-up that every later phase routes through. A
silent bug here (wrong subtask order, missing test scope, incorrect
findings path) is hard to detect downstream and easy to mistake for a
phase-04+ regression. Hence audit×2 on this phase: a second pass to
catch anything the first round missed.
