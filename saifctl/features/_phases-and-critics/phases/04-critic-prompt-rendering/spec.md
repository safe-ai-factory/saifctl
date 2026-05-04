# Phase 04 — Critic prompt rendering (mustache, with discover/fix split)

This phase folds the original "Block 4 + Block 4b" pivot into a single
unit. Block 4 was the initial mustache renderer; Block 4b was the
post-Block-4 design pivot that splits each critic round into two
subtasks (discover + fix). Both sub-pieces ship together here because
the discover/fix split materially changes the prompt-rendering surface
(`critic.step`, `critic.findingsPath`, the saifctl-owned fix template)
and shipping them separately would be wasted churn.

After this phase, critics receive properly rendered adversarial
prompts and the discover/fix workflow matches the user's manual flow
(reviewer agent writes findings, fixer agent applies them).

## Files to add

- `src/specs/phases/critic-prompt.ts` — mustache renderer for critic
  templates. Closed variable set:
  - `feature.{name,dir,plan}`
  - `phase.{id,dir,spec,baseRef,tests}`
  - `critic.{id,round,totalRounds,step,findingsPath}`

  Partial: `{{> file <path>}}` reads a workspace-relative file and
  inserts it inside a fenced code block. Path is workspace-relative;
  rejected at render time if it contains `..` or starts with `/`. The
  host-side resolver further canonicalises both root and target via
  `realpath` and refuses any path resolving outside the sandbox
  (blocks symlink-based escape).

  Add `BUILTIN_FIX_TEMPLATE` constant — the saifctl-owned template
  the fix step uses. Users author only the discover template at
  `critics/<id>.md`.

- A worked-example feature under `saifctl/features/_phases-example/`
  demonstrating the full pattern (feature.yml + phases/ + critics/).
  Underscore prefix reserves it as documentation, not a runnable
  feature; confirm `discover.ts` skips `_`-prefixed dirs (add the
  filter if not).

## Files to modify

- `src/orchestrator/agent-task.ts` — when assembling a critic
  subtask's task, render the template instead of using the raw body.
- `src/runs/types.ts` — extend `RunSubtaskCriticPrompt` with
  `step: 'discover' | 'fix'` and `findingsPath: string`. Both
  round-trip through `runSubtasksFromInputs` / `runSubtasksToInputs`
  so they persist in the artifact and resume cleanly.
- `src/specs/phases/compile.ts` — for each (phase, critic, round)
  emit TWO subtasks: a `discover` carrying the user's `critics/<id>.md`
  body, and a `fix` carrying `BUILTIN_FIX_TEMPLATE`. Both share the
  same `criticPrompt.findingsPath` (so fix reads what discover wrote)
  and the same `testScope` (so both gate on phase tests). Add
  `buildFindingsPath()` helper: pinned per (phase, critic, round) at
  `/workspace/.saifctl/critic-findings/<phase>--<critic>--r<n>.md`.
- `src/orchestrator/loop.ts` — `renderCriticContent` passes the new
  `critic.step` and `critic.findingsPath` into the renderer alongside
  the existing vars (single one-line edit).

## Clarifications

- **Library:** `mustache` (npm) — minimal API, partials supported via
  custom partial resolver. Reject `handlebars` (heavier, more features
  than we need).
- **`phase.baseRef` capture.** Need the git rev at the start of the
  phase's implementer subtask. Capture via a small hook at subtask-
  start in `loop.ts` (around the `subtaskCursorIndex` advance), store
  on the runtime subtask record, and pass into the critic-prompt
  renderer when compiling subsequent critic subtasks for that phase.
  Do NOT persist into `RunSubtaskInput` (it's runtime state, not
  config).
- **Where rendered content goes.** Renderer output replaces the
  critic subtask's `content` field at compile-time-with-runtime-vars,
  i.e. just before the critic subtask becomes the active row. Render
  late so `phase.baseRef` is known.
- **Cardinality change from Block 4 to Block 4b.** `rounds: N` for a
  critic was `N` subtasks; now `2N`. Phase 08's modification-warning
  glob must exclude `/workspace/.saifctl/critic-findings/**` — the
  findings file is an expected transient artifact, not a code/spec
  change worth surfacing.
- **Closed-set rendering — typos error loud.** The renderer rejects any
  `{{ ... }}` token outside the closed variable list. Empty tokens,
  triple-stash (`{{{...}}}`), comments (`{{!...}}`), and section /
  inverted-section / closing tokens are all rejected. Mistyping
  `{{phase.basRef}}` produces a `CriticPromptRenderError` with the
  token name, not a silently-empty render.

## Decisions baked in (Block 4b)

- **Empty / `no findings`** (case-insensitive) findings file ⇒ fix
  step exits immediately as a no-op. Built into `BUILTIN_FIX_TEMPLATE`.
- **Fix step deletes the findings file when done** — explicit in the
  built-in prompt. If interrupted, the next discover overwrites the
  orphan deterministically (path is round-pinned).
- **No "independent" flag for critics** — file deletion +
  fresh-LLM-per-round give independence between rounds for free.
- **Per-critic fix-template override** (`critics/<id>.fix.md`) is
  **out of scope for v1**. Power users can shadow later.
- **Findings file name format pinned**:
  `<phaseId>--<criticId>--r<round>.md`. Locked in tests; changing it
  later means a search-and-replace across the worked example.

## What this phase does NOT include

- No `feat phases` CLI surface — phase 06.
- No mutability enforcement — phase 07.
- No deviation directives or modification surfacer — phase 08.
- No documentation roll-up — phase 09. (The worked example dir lives
  here because it serves as an integration test for the renderer; the
  README inside it lands in phase 09.)
