# Phase 05 — Implementer prompt: link, don't inline (behavior change)

Symmetry with critics: the implementer prompt switches from inlining
plan.md content to a **strong link-only directive** that names the
file path and tells the agent it MUST read it.

This is a **behavior change** for existing single-feature `feat run`
users. Worth a separate phase so the change can be reasoned about in
isolation.

## Two inline sites need fixing, not one

The legacy code inlines plan/spec in two places:

- `src/orchestrator/agent-task.ts` (around lines 23–34) — the per-round
  task prompt currently includes a `## Implementation Plan` section
  with the file's content.
- `src/orchestrator/resolve-subtasks.ts` (`synthesizePlanSpecSubtaskInputs`,
  around lines 107–136) — synthesises the initial subtask `content`
  for legacy non-phased features and inlines BOTH `plan.md` AND
  `specification.md`.

Both must switch to link-only.

## New prompt shape

### Per-round task prompt (`agent-task.ts`)

Replace the `## Implementation Plan` block with:

> Read the implementation plan at `<feature.plan>` before starting any
> work. The file is in your workspace; you MUST read it before you make
> any changes.

Don't keep `## Implementation Plan` as a heading. The directive is a
single instruction, not a section.

### Initial subtask synthesis (`synthesizePlanSpecSubtaskInputs`)

Replace inline plan + spec with:

> Implement the feature `{name}` per the specification at `{specPath}`
> and the plan at `{planPath}`. Both files are in your workspace and you
> MUST read them before you make any changes.

## Why

Symmetry with critics, and the implementer also runs many rounds per
phase (each gate-retry, each phase). Inlining a 600-1200-LOC plan on
every round wastes tokens. The agent has filesystem access and should
fetch what it needs.

## Risk

An agent that previously got plan.md "for free" might now skip reading
it. Mitigations:

- Strong directive ("MUST read") in the prompt;
- Phase 07's mutability/diff inspection includes a best-effort
  heuristic that warns if a step's git log doesn't show the agent
  reading the plan file. (Best-effort; not a hard gate.)

If issues surface in practice, the documented escape hatch is
`feature.yml.implementer.inline-plan: true` — but **ship link-only as
the default**, and don't implement the escape hatch unless real
regressions appear.

## Clarifications

- **Phased path bypasses `synthesizePlanSpecSubtaskInputs`** because
  phase 03's compiler emits its own subtask content. So the
  `resolve-subtasks.ts` edit only matters for the legacy non-phased
  path. Still required — legacy path stays supported.
- **Engine-aware paths** are the responsibility of the consumer, not
  this phase. The directive emitted here uses workspace-relative POSIX
  paths so it works regardless of whether the agent runs in a
  container (`/workspace/...` resolves) or on the host (`--engine
  local`, agent's cwd is `codePath`). Phase 08 will refine this when
  it adds engine-aware path rendering for the per-round directive in
  `buildTaskPrompt`.

## What this phase does NOT include

- No new CLI surface.
- No mustache rendering changes — phase 04 already shipped the
  renderer.
- No deviation directive — phase 08.
