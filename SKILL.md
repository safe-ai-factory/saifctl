# SKILL — Authoring features in the saifctl repo

This document tells an agent **how to think about, structure, and incrementally
write a feature** under `saifctl/features/<name>/`. It captures the working
methodology used to produce features like `_phases-and-critics` and
`release-readiness`. If you point a fresh agent at this file with the
prompt _"continue our feature work using SKILL.md"_, it should be able to
reproduce the workflow without further hand-holding.

The format follows saifctl's own filesystem-as-structure convention: every
file under a feature dir means something specific (see §3 below). The
_content_ of those files follows the conventions in §4–§7.

---

## 1. Reference examples

Two existing features that you can read end-to-end as templates:

- **`saifctl/features/_phases-and-critics/`**
- **`saifctl/features/release-readiness/`**

They look different because they describe different work, not because
they belong to different categories. Same workflow, same
`specification.md` structure, same ID conventions — both yield phases
when ready. Read one or both to see how the conventions in this
document play out in practice.

---

## 2. The workflow (in order)

Six phases, executed sequentially. Do not skip ahead — each phase's
output is the next phase's input.

### Phase A — Orient

Read what the user is actually asking. Identify:

- The **components** in scope (e.g. npm package, vscode-ext, web, docs,
  sandbox, the orchestrator loop, a specific subsystem, etc.).
- The **target state** they're aiming at (e.g. alpha release? new
  capability? migration? — this changes the bar).
- Which **pieces of the codebase / docs / config / prior conversations**
  you'll need to inspect to gather context.

Write it down. This is your reference point for the next phase. It also forces you to confront any ambiguity in the ask before you dive into the weeds.

### Phase B — Gather context (parallel exploration)

**Inventory first; design later.** You cannot write a useful spec until
you know the territory. Resist the urge to propose fixes / designs
during this phase — just record what's there.

Sources of context vary by feature. Common ones:

- **Code audit** — when the feature operates against existing code,
  delegate parallel sub-agents to walk the relevant subtrees.
- **README / docs / marketing copy** — when the feature involves
  matching claims against reality.
- **User conversations** — when the feature derives from a workflow
  the user has been doing manually. Capture verbatim quotes; they
  age into authoritative §0 Background in `specification.md` later.
- **External references** — issues, PRs, prior design docs, external
  tools the feature integrates with.

When delegating to parallel sub-agents, use `Explore`-type agents for
"find and inventory" tasks (read-only, context-cheap), and
`general-purpose` agents for "analyze and assess" tasks that need
judgment. Always:

- Brief each agent like a smart colleague who hasn't seen the
  conversation: _what to investigate, why it matters, what shape the
  report should take, how long_.
- Give each one a **distinct, non-overlapping scope** so you don't pay
  for duplicated work.
- Ask for a **structured report** with file:line citations. Pick the
  shape that matches your tracking needs (a flat punch list, a tagged
  table, a per-component list). Tell the agent to be specific —
  "tests fail" is useless; "vitest reports 3 failing in
  foo/bar.test.ts:42" is useful.
- Tell the agent **not to fix or design anything** during this phase.

Run sub-agents in parallel by issuing multiple `Agent` tool calls in
the same response. Synthesize the results yourself; do not delegate
the synthesis to another agent (that's where overclaiming sneaks in).

For the canonical example, see how the four parallel audits feeding
`release-readiness` are recorded in
`saifctl/features/release-readiness/specification.md` Appendix A.

### Phase C — First-pass `specification.md`

Create the feature dir at `saifctl/features/<name>/`. No underscore
prefix unless the feature is documentation-only / not runnable
(`_phases-and-critics`, `_phases-example` use the prefix because they
exist for reference, not for `feat run`).

Write `specification.md` first. Use the section structure in §4 below.
The first version is a **verbatim lift of the gathered context** —
every finding / requirement / user-stated constraint becomes a row in
§3 with a fresh ID. Don't try to be comprehensive; don't try to resolve
open questions; don't try to lock the phase breakdown. Capture, then
refine.

Note this in the file's preamble: _"This file is a working document.
The first pass is a verbatim lift of the gathered context. Subsequent
passes will refine."_ That sets expectations for the user reading it.

### Phase D — Iterative refinement (the conversation loop)

Walk the user through §6 (open questions). For each one:

1. Lay out the options briefly.
2. Capture the user's decision.
3. Migrate the question into §5 as `D-NN` with rationale + back-references
   (which work-item IDs it touches).
4. Update the affected work-item rows so they reference **Decision
   D-NN** (and update any tracking columns the spec uses to mark the
   row as resolved).
5. If new work surfaces from the decision, add it as a fresh ID
   (don't recycle).
6. Update §6 to mark the question as `Q-NN → resolved as D-NN` (keep
   the slot for stable referencing; don't renumber).
7. Re-flow §9 (phase breakdown — or §8 if the spec doesn't use a
   Prerequisites section) if the decision shifts scope.

Do **not** start writing code, `feature.yml`, or `phase.yml` during this
loop. The spec stabilizes first; the phase breakdown follows from
stable decisions.

### Phase E — Cut phases

Once §5 (decisions) is mostly populated and §6 (open questions) is
mostly empty, cut the phases. For each phase:

1. `mkdir saifctl/features/<feat>/phases/NN-<short-name>/`
2. Write `phases/NN-<short-name>/spec.md` — the implementation slice.
   Lift the relevant work items from §3 and expand them into
   step-by-step instructions an implementer can follow.
3. Optionally `phase.yml` for per-phase config (test mutability,
   critic overrides, etc.).
4. Update `feature.yml` if you need feature-wide critic selection or
   test settings.

Phases are lexicographic-ordered by directory name unless overridden
in `feature.yml.phases.order`. Number with leading zeros (`01-`, `02-`,
…) so adding `1a` later isn't awkward.

### Phase F — Critics (only if useful)

Critics aren't always needed. Add a critic (e.g. `critics/audit.md`)
only when phases will produce non-trivial code changes that benefit
from adversarial review. If the phases are mostly mechanical work
(delete a file, rename a field, fix a broken link), skip critics
entirely — they're noise on a clean phase.

If you do add a critic, follow the convention in
`_phases-and-critics/critics/audit.md`: a discover prompt referencing
mustache variables (`{{phase.id}}`, `{{critic.findingsPath}}`, etc.).
The fix step uses a saifctl-built-in template — you don't write it.

---

## 3. Filesystem layout for a feature

```
saifctl/features/<feat>/
  specification.md        # the spec — decisions, work items, conventions.
                          #            Living document; the authoritative
                          #            artifact for this workflow.
  proposal.md             # OPTIONAL — original ask, freeform prose.
                          #            Skipped when context lives elsewhere.
  feature.yml             # OPTIONAL — feature-wide config (critics, test mutability)
  critics/                # OPTIONAL — critic prompt templates, one file per critic
    <critic-id>.md
  tests/                  # OPTIONAL — feature-wide tests
                          #            (no-phases mode or end-state tests)
  phases/                 # OPTIONAL — split work into ordered phases.
                          #            Skip if the feature is small.
    NN-<slug>/
      spec.md             # phase-specific spec / tasks
      tests/              # OPTIONAL — phase-specific tests
      phase.yml           # OPTIONAL — phase-specific overrides
```

Strict rules carried over from `_phases-and-critics/specification.md` §1:

- A **phase is a directory** under `phases/`. Existence creates the phase.
- Phase order is **lexicographic** unless overridden in `feature.yml`.
- A **critic is a file** under `critics/`. Filename = critic id.
- `phases/` is **optional**. Without it, the feature behaves as a single
  implicit phase = the whole feature.

Underscore-prefixed feature dirs (`_foo/`) are skipped by feature
discovery — use the prefix for reference / documentation features that
should not appear in `feat run` listings.

---

## 4. `specification.md` section structure

Use this skeleton for every feature spec. Section headings
are stable so we can cross-reference between specs and chat.

```
# `<feature-name>` — specification

<2-3 sentence preamble:>
- What this spec covers and the scope it operates against.
- That this is a living document; first pass = verbatim context lift.

## 0. Background
   Current state of the world the feature operates against. Audit scope.

## 1. Goals
   Target state. Split into release tiers (e.g. v0.1, v1.0) so the
   first tier ships without blocking on the second.

## 2. Non-goals
   Explicit guardrails. Critical for preventing scope creep during
   the iterative refinement loop. Each non-goal is one bullet with
   a *why*.

## 3. Inventory (feature-shaped)
   The body of the spec — what the feature is tracking, designing, or
   specifying. Format is the feature's choice: prose subsections
   (good for design-style features laying out filesystem shape,
   configs, mental models), tables grouped by component (good for
   audit-style features), or a flat list. Add as many sub-sections
   as the feature needs.

## 4. (varies by feature)
   Some features add a §4 for content that doesn't fit §3's grouping
   (e.g. cross-cutting items, a distinct design subsystem, prompt
   templates). Skip if not needed; don't invent content to fill the
   slot.

## 5. Decisions
   Empty placeholder initially. Populated during Phase D. Each entry:
   ### D-NN — <short name>
   <rationale>
   Touches: <list of items / IDs the decision affects>

## 6. Open questions
   Things that need user input before they become decisions. Stable
   IDs Q-01..Q-NN. When resolved, replace body with "→ resolved as D-NN".

## 7. Out of scope
   Explicit holding pen for things people might ask about. Prevents
   scope creep more reliably than non-goals because it's where
   "interesting but not now" ideas go to be remembered without being
   acted on.

## 8. Prerequisites (human-only, do these first)
   OPTIONAL but recommended for any workstream / release-style feature.
   Items here are work an AI agent CANNOT complete on its own —
   external accounts, marketplace publishers, fresh screenshots, DNS
   config, judgement calls that gate downstream work. Stable IDs
   PRE-01..PRE-NN. Each row should declare what work items it BLOCKS
   so the next agent can see what's stuck on a human and not silently
   stall (or fabricate a stand-in artifact). Status: 🟠 pending /
   ✅ done.

## 9. Suggested phase breakdown (preliminary)
   Working hypothesis only. Do not lock until §5 is mostly populated
   AND §8 prerequisites are ✅ (or at least scheduled). Each phase:
   `NN-<slug>` — bullet list of items the phase covers, one-line
   goal. Each phase implicitly assumes its blocking PREs are ✅ before
   the phase starts.

## Appendices (as needed)
   Optional. Use for content that doesn't fit the main flow.
   Examples from existing features: provenance of the §3 inventory,
   a "what's working" counterweight, future considerations / deferred
   ideas. Pick what the feature needs; don't force the shape.
```

---

## 5. ID and tag conventions

### 5.1 Work-item IDs

Used by features that track concrete work items. Not every feature
needs IDs — design-style specs often refer to subsections by name
instead.

Format: `<COMPONENT>-<NN>` with leading zero. Examples: `NPM-01`,
`VSX-11`, `WEB-03`, `X-04`.

- One ID per item.
- IDs are **stable forever** — never reuse, never renumber. New work
  gets new IDs at the end of the list.
- The component prefix is short and recognisable. Reuse existing
  prefixes when possible (`NPM`, `VSX`, `WEB`, `DOC`, `X` for
  cross-cutting). Coin new ones sparingly.

### 5.2 Decision IDs

Format: `D-NN`, leading zero. Decisions migrate up from §6 questions.

Each decision has:

- A short name (e.g. _"Extension and CLI track independent SemVer trains"_)
- A 1-3 paragraph rationale
- A **Touches:** line listing work-item IDs the decision affects

The Touches line is load-bearing — when the user asks "what does D-04
affect?", the answer is one line away.

### 5.3 Open-question IDs

Format: `Q-NN`, leading zero. Questions are numbered in the order they
arose, not by priority.

When a question becomes a decision:

- Mark §6 entry as `Q-NN → resolved as D-NN` and replace the body with
  a one-line summary.
- **Do not delete or renumber** — the slot stays so cross-references
  in chat history don't rot.

### 5.4 Prerequisite IDs

Format: `PRE-NN`, leading zero. Prerequisites live in §8 (when the
spec uses one) and capture human-only / external-account / judgement-
call work that gates the phase plan.

Each PRE row should declare:

- What the human needs to do (capture screenshots, set up an org
  account, configure a secret, decide an open question, etc.).
- What work items it **blocks** — so a phase-runner agent can see at
  a glance whether it's safe to start phase N.

PREs are append-only and stable, like all other IDs. Mark 🟠 when
pending and ✅ when done. New PREs may surface mid-execution — when
that happens, add them and immediately escalate the block to the
human.

(Note on emoji semantics across the spec: ✅ means "actually completed
work landed". For work _items_ — not PREs — there's a separate 👍
status meaning "decision made, work pending"; the work flips to ✅
when the change ships. PREs skip 👍 because they don't carry decisions
— they're either pending or done.)

---

## 6. Iterative refinement protocol

When the user makes a decision during Phase D:

1. **Add a §5 entry.** Pick the next `D-NN`. Write rationale.
   Include the **Touches:** line. If the decision creates new work
   items, add them now (e.g. _"this decision implies a new
   activation-time probe; add `VSX-11`"_).
2. **Update affected work-item rows.** Edit the item text to reference
   the decision: _"... **Decision D-NN.**"_. Flip any tracking columns
   the spec uses to mark the row as resolved. This makes the spec
   self-explanatory without cross-referencing.
3. **Update §6.** Mark the resolved question as `Q-NN → resolved as
D-NN`. Don't renumber other questions.
4. **Update §9 (phase breakdown — or §8 if the spec skips
   Prerequisites).** If the decision shifts which work items belong
   to which phase, re-flow. If it just resolves an open question
   without changing scope, leave the phase breakdown alone.
5. **Acknowledge in chat** — confirm what changed, link to decision
   id, suggest 1-2 candidate next threads. Don't dump the full diff
   unless asked.

Use targeted `Edit` calls for these updates, one per affected section.
Don't `Write` the whole file just to flip one cell — preserves audit
trail in tool-use logs.

---

## 7. Audit delegation conventions

When kicking off Phase B parallel audits, use these patterns:

### 7.1 Pick the right agent type

- **`Explore`** for read-only inventory tasks. ("Find every TODO/FIXME
  in `src/`", "Walk `docs/` and report which files are <500 bytes")
- **`general-purpose`** for assessment tasks that need to compose
  evidence into a judgment. ("Audit whether the README's `14 Agentic
CLI tools` claim is backed by code.")

### 7.2 Brief each agent self-containedly

The agent has not seen this conversation. Each prompt must include:

- **What you're trying to accomplish and why** — so the agent can
  make judgment calls instead of following narrow instructions.
- **What you've already established** — so it doesn't re-do work.
- **Concrete questions to answer** — numbered, with sub-questions.
- **The expected report shape** — structured punch list, file:line
  citations, word count cap. Specify any tagging or columns you want.
- **Anti-instructions** — explicit "do not fix anything", "do not
  rewrite code", "do not run destructive commands".

### 7.3 Run audits in parallel

Issue multiple `Agent` tool calls in a single response. They run
concurrently. Plan the scopes so they don't overlap — overlapping
audits are paid duplication.

### 7.4 Synthesize yourself

Don't ask a meta-agent to summarize the sub-agent reports. Read them
yourself, deduplicate, classify, and group. The synthesis is where the
value is — delegate it and you import every sub-agent's
misclassification.

---

## 8. Common pitfalls

These trip people up. Each one was caught at least once during the
release-readiness work.

1. **Writing fixes instead of inventorying.** During Phase B you are a
   surveyor, not a contractor. If you find yourself proposing how to
   fix something, stop and just record the finding.

2. **Pre-deciding things in the spec.** §5 is empty until the user
   makes a decision. Don't write _"I'd suggest we…"_ into §5;
   speculation belongs in §6 as an open question with options.

3. **Renumbering IDs.** Once a row has an ID like `NPM-04`, that ID is
   permanent. Renumbering breaks every cross-reference in chat history
   and in `D-NN` Touches lines. Always append at the end of the table.

4. **Locking phases too early.** The phase breakdown (§9, or §8 if
   no Prerequisites) is a working hypothesis until §5 stabilizes and
   §8 prerequisites are ✅. If you start cutting `phases/01-…/`
   before the user has answered the load-bearing open questions,
   you'll re-cut them when the answers come in.

5. **Skipping non-goals.** §2 is the most under-rated section. Without
   explicit non-goals, the iterative refinement loop drifts into
   adjacent rewrites. Write non-goals before you write findings.

6. **Treating the spec as final.** It is a working document. The spec
   will gain rows, lose questions, and grow phases over weeks of
   conversation. The filesystem is the source of truth, not any single
   snapshot.

7. **Editing the spec in big rewrites.** Use targeted `Edit` calls
   when changing one row, one decision, one open question. `Write`
   the whole file only for the initial creation or for a deliberate
   restructure. Targeted edits keep the audit trail clean and avoid
   accidentally reverting the user's manual tweaks.

---

## 9. Worked examples

Two existing features, read in this order to internalize the workflow:

**`saifctl/features/release-readiness/`**

1. `specification.md` §0–§2 — how the feature was framed (current
   state, target tiers, non-goals).
2. `specification.md` §3 — how findings are grouped, scored, tagged.
   Notice the IDs are stable across the conversation.
3. `specification.md` §5–§6 — how decisions migrate up from questions,
   with stable Q-NN slots.
4. `specification.md` §8 (Prerequisites) — what humans must do
   before agents can take over. §9 — how phase breakdown is
   preliminary and re-flows with each decision.
5. `specification.md` Appendix A and B — how source-of-context and
   "what's working well" are preserved.

**`saifctl/features/_phases-and-critics/`**

1. `specification.md` §1–§5 — how filesystem shape, configs, and
   decisions get fully specified before any code is written.
2. `phases/<id>/spec.md` files — how per-phase implementation slices
   are scoped (this is the file the in-container coding agent reads
   each round).
3. `critics/audit.md` — how a critic prompt is authored against the
   documented mustache variables.
4. `_phases-example/` (sibling) — a runnable template that exercises
   the conventions end-to-end.

   _(Note: this feature also ships a `plan.md`. Treat it as a legacy
   artifact, not a model to copy — see §3's "Note on `plan.md`".)_

---

## 10. Quick reference card

When in doubt:

| You're about to…                  | Do this first                                                          |
| --------------------------------- | ---------------------------------------------------------------------- |
| Propose a fix during audit        | Stop. Just record the finding with file:line.                          |
| Write a §5 decision               | Confirm the user actually decided it; don't guess.                     |
| Renumber an ID                    | Don't. Append a new ID.                                                |
| Delete a §6 question              | Don't. Mark it `Q-NN → resolved as D-NN`.                              |
| Cut a phase early                 | Wait until §5 is mostly populated.                                     |
| Write the whole spec from scratch | Start with audit, then §0–§2, then §3, then §6. §5, §8, and §9 follow. |
| Audit four things in series       | Stop. Run them in parallel via concurrent `Agent` calls.               |
