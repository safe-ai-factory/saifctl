# Phase 09 — Documentation & examples

Documentation work that runs alongside the code phases. **Bundle each
section's doc updates with the code phase that delivers the feature**,
rather than batching everything here. This phase exists to:

- Catch any doc work that wasn't bundled with its owning code phase.
- Land the worked-example feature's README + tour
  (`saifctl/features/_phases-example/_README.md`).
- Cross-cut updates that touch multiple phases' docs (top-level README,
  multi-phase walkthrough sections of how-tos).

This phase has **no functional risk**. The risk is doc debt: claims
that don't match shipped behavior, broken links, scope creep, dead
references. The audit critic should specifically check:

- Every code-snippet / YAML example actually validates against the
  schemas shipped by phases 01–07.
- Every internal markdown link resolves to an extant file.
- Doc claims about runtime behavior are grounded in shipped code (no
  "the reviewer sees per-phase diffs" if the reviewer doesn't actually
  do that — see specification.md §A.5 for the canonical example).
- New content matches phase 09's stated scope; nothing slips in
  unrelated TODO links or broken-link placeholders.

## Files to add

- `saifctl/features/_phases-example/` — worked-example feature
  demonstrating the full new pattern. Already mentioned in phase 04;
  consolidated here as the canonical place to point readers at.
  Underscore prefix reserves it as docs, not a real feature.

## Files to modify (organised by tree)

### Forward-looking docs source (`docspec/` → regenerates `docs/`)

- `docspec/products/saifctl/concepts/feat-run-loop.md` — loop now
  repeats per-phase + per-critic-round.
- `docspec/products/saifctl/concepts/gate-reviewer-holdout.md` —
  per-phase test scope; clarify critics run after gates and see prior
  commits via `git log`. **Be precise about which stages are
  phase-scoped** (gate, holdout: yes, via cumulative test scope;
  critics: yes, via `{{phase.baseRef}}`; reviewer: NOT phase-scoped
  today — see `../../specification.md` §A.5).
- `docspec/references/commands/feat.md` — `feat run` mentions phase
  compilation; document new `feat phases` subcommands.
- `docspec/products/saifctl/how-tos/run-first-feature.md` — add an
  optional multi-phase walkthrough section.
- `docspec/products/saifctl/tutorials/spec-to-pr.md` — alt path for
  phased features.

### Top-level README

- `README.md` — three-stage guarantee mention should clarify it
  applies per-phase; sandbox-vs-phases distinction.

### Legacy docs (`docs_old/` — update if still authoritative)

- `docs_old/usage.md` — directory structure adds phases/critics;
  feature- vs phase-level tests.
- `docs_old/specs.md` — phases section; cumulative test scoping.
  **YAML examples must use the object shape `{ id: <name> }`** — bare
  strings (`critics: [paranoid]`) fail Zod validation.
- `docs_old/commands/feat-run.md` — phase compilation; subtasks now
  derived. Don't link to a `feat-phases.md` that doesn't exist; use
  inline-code references and point at the new `docspec/` content.
- `docs_old/features.md` — note `feature.yml` / `phase.yml` are
  feature-scoped configs distinct from project-level `saifctl/config.*`.
- `docs_old/guides/feature-lifecycle.md` — multi-phase lifecycle
  section.
- `docs_old/guides/run-lifecycle.md` — pause/resume work per-phase.

### CLI help text

- `src/cli/args.ts` — descriptions for `--strict` / `--no-strict`.
- `src/cli/commands/feat.ts` — top-of-file docstring +
  `runCommand.meta.description` mention phases.

### Source code doc-comments

- `src/orchestrator/agent-task.ts` (top-of-file JSDoc) — reflects
  link-don't-inline; per-round prompt no longer enriches with plan.md
  inline.
- `src/orchestrator/resolve-subtasks.ts` (JSDoc on
  `synthesizePlanSpecSubtaskInputs`) — note legacy path; phased
  features bypass via phase 03's compiler.
- `src/agent-profiles/types.ts` — note that `AgentProfile`
  infrastructure is reused for critics (same agent script, fresh LLM
  context, distinguished only by prompt template).
- `src/orchestrator/phases/run-agent-phase.ts` — "built once per
  loop" comment is wrong with phases; rebuilt per subtask.

## Risk surface

The lazy-implementer failure mode for documentation:

- **False claims**: "feature X works like Y" when the code does Z.
  Verifiable by reading the code, but easy to skim past.
- **Broken links**: especially in newly-added content, where the
  implementer added a link to a file they didn't create / a path
  that's been deprecated.
- **Scope creep**: TODO markers, placeholders for unrelated work,
  dead-link "coming soon" notes that survive into rendered output.
- **Sample code that wouldn't compile/parse**: YAML that doesn't pass
  the schema, command examples with wrong flag names.

The audit critic should bias toward verifying claims against shipped
code, not just reading docs in isolation.

## What this phase does NOT include

- No code changes (other than JSDoc updates flagged above).
- No new CLI surface.
- No new functional behavior.
