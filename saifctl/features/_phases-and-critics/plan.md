# `_phases-and-critics` — implementation plan

Retrospective definition of the work that adds **phased features** and
**critics** to saifctl. The implementation has already shipped on this
branch; this directory captures the plan/spec in saifctl's native shape so
the format itself can be exercised on a non-trivial body of work and any
rough edges surface.

The canonical design doc is `TODO_phases_and_critics.md` at the repo root.
This `plan.md` lifts §1–3 (background, goals, mental model). The companion
`specification.md` lifts §4–9 + §11, with §10 as an appendix. Each phase's
own `spec.md` lifts the corresponding "Block N" section, minus its
post-review-deviations subsection.

## Bootstrap caveat (read first)

This feature **cannot run end-to-end on a clean copy of this repo**.
Phases-and-critics is what makes phased features work; trying to compile
it before phases 01–03 land would invoke a code path that doesn't exist
yet. The parent dir is underscored (`_phases-and-critics/`) so feature
discovery skips it — saifctl will not pick this up as a runnable feature.

If we ever wanted to teach an agent to rebuild this from scratch on a
fresh checkout, the spec would say "use `--subtasks <manifest>` mode for
phases 01–03 to bootstrap, then phased mode for 04+". For now this is
documentation / dogfood material, not an execution target.

## 1. Background — the user's workflow (verbatim)

These are the user's own words from the conversation that motivated this
work. Treat them as authoritative for "what the user actually does today"
and as the benchmark against which the design is judged.

### 1.1 The current Claude-Opus workflow

> Currently I use claude opus in following manner:
> 1. I usually start exploring some idea.
> 2. Then I go deeper into individual parts of it, iterating, recursing,
>    clearing out the unknowns until the impl seems clear to me.
> 3. After that I ask opus to prepare implementation plan for the entire
>    feature. The agent usually breaks up the implementation into several
>    sections (e.g. phases or weeks).
> 4. What I usually end up with is something with easily 600-1200 lines of
>    code, 4-12 phases, and a clear idea for implementation. (with phase 0
>    for spikes and questions).
> 5. Once I have that, I proceed to implementation - I go step by step -
>    phase 0 → phase 1 → phase 2, etc. Each phase is a new claude chat to
>    avoid context rot (and to minimize how much latent info is stored in
>    chats instead of the plan).
> 6. However, to be more exact, I also do a rounds of reviews after each
>    phase. So in reality I go "phase 0 → review p0 → phase 1 → review p1
>    → ...". And again, each is separate chat instance, reviews don't
>    reuse impl's context so reviewers are not swayed. The reviews
>    usually find a range of issues - large and small, and I tell the
>    agent to fix all found issues.
>
> 7. Sometimes, for large refactors, or when I'm not confident in the
>    result, I do a second review pass. Again the same prompt, and again
>    in a fresh context (review1 and review2 don't see each other's
>    context). So the pattern is "impl p1 → review#1 p1 → review#2 p1".
>
> 8. Also, for EVERY step of the agent's flow (impl1, review#1, review#2),
>    I tell the agent in the prompt to update the plan doc with deviations
>    from the original doc as it is implementing it.
>
> 9. At the end I usually ask the agent to write E2E tests for the entire
>    phase / entire feature. And after that I again run a review agent to
>    review how the e2e tests were implemented. So the flow is roughly
>    "impl1 → review1 #1 → review1 #2 → ... → e2e tests → review e2e tests".
>    Again, both "write e2e tests" and "review e2e tests" agents run in
>    separate chats.

### 1.2 The user's standard reviewer prompt

The verbatim daily-driver template lives at `critics/audit.md`. Its
historical form (paraphrased from the originating conversation):

> Consider TODO_<feature>.md, TODO_<feature>_phase_1.md, … and other
> TODO_ files. Review the implementation of entire phase N.
>
> As an example why we're doing this, we found that the lesser model that
> implemented these was lazy, and sometimes even made false claims in
> comments or omitted planned work. Further patterns to look out for
> include: optional inputs where the defaults elevate access; backwards-
> compat code or old patterns left just to avoid changing tests; skipped
> or dropped nuance compared to what was planned out; security issues
> (cross-project / cross-team / cross-user data access), or really
> anything that can be misused; etc.
>
> Do a deep analysis, and report back with your findings.

### 1.3 Why this didn't fit saifctl before

> Right now, I have to drive this entire workflow (design, prepare impl
> plan, impl, reviews, impl, reviews, [...], e2e, e2e review, etc).
> - This is very limiting — I have to stand by the laptop as a single
>   step usually takes ~10 min.
> - This is also slow — because usually the implementation is only as
>   fast or slow as I notice that a single step has ended. And it also
>   means I can't run agent workflows 1) alone for longer period of
>   time, and 2) overnight.

### 1.4 Constraints the user named

- Design + plan are done **outside** saifctl. The user writes plan.md by hand.
- The user does **not** want to use `saifctl feat design`. They may use
  `saifctl feat new` to scaffold the dir.
- "Fresh context" between steps means **fresh LLM session**, not fresh
  sandbox/container. The container, filesystem, and git branch should
  persist across all steps to avoid wasteful teardown/rebuild.
- Each step (impl, critic, e2e) must be its own discrete unit, ordered.
- Reviews/critics must not poison each other's context (independence is
  achieved by the fact that each LLM session is fresh; we do not need a
  separate independence flag).

## 2. Goals

Run `saifctl feat run <feature>` and have it drive, unattended:

```
phase-0 impl  →  phase-1 impl  →  phase-1 critic A  →  phase-1 critic B
              →  phase-2 impl  →  phase-2 critic A  →  phase-2 critic B
              →  …
              →  e2e impl     →  e2e critic
```

…using one container, one sandbox, one git branch, one runId — with each
step being a fresh LLM session.

## 3. Mental model & terminology

Pinned vocabulary. These names are load-bearing in code, config, docs.

- **Implementer** — coding agent invocation that builds a phase. Same
  CLI/profile as today's coder (e.g. `claude/agent.sh`).
- **Critic** — coding agent invocation that audits-and-fixes a phase.
  *Same CLI, same profile, same piping as the implementer.* Distinguished
  only by prompt. Critics are not gates; critics modify code in-place
  and commit, just like implementers.
- **Reviewer gate** — the existing Argus-driven gate
  (`src/orchestrator/scripts/reviewer.sh`). Runs inside the inner round
  between `gate.sh` and the `subtask-done` signal. **Untouched by this
  design.** The word "reviewer" is reserved for the gate.
- **Phase** — a directory under `saifctl/features/<feat>/phases/`. Has
  its own spec, tests, and optional `phase.yml`.
- **Round** — has two meanings; pin both:
  - **Gate retries** (existing): if `gate.sh` + `reviewer.sh` fail, the
    inner loop re-invokes the agent in the same subtask up to N times.
    Inner-loop concept. Field: `gateRetries`.
  - **Critic rounds** (new): the number of sequential subtasks a critic
    runs against the phase. Outer-loop concept. Field: `rounds` per
    critic in `feature.yml` / `phase.yml`. `rounds: 2` ⇒ two subtasks
    in sequence, each fresh LLM, both gated on cumulative tests.

Why the implementer/critic distinction is just a prompt: every
`agent.sh` invocation is already a fresh LLM session
(`claude -p ... --no-session-persistence`), so no new agent-process model
is needed. The container, working tree, and git history persist; the LLM
mind does not. Both implementer and critic exploit this.

## Implementation order (informational)

Phases run in numeric order. The natural sequencing is:

1. `01-phase-config` — pure data model; unblocks every other phase.
2. `02-per-subtask-test-scope` — the only loop edit; somewhere for `03` to plug in.
3. `03-phase-compiler` — first end-to-end working version.
4. `04-critic-prompt-rendering` — critics get proper adversarial prompts (folds Block 4b's discover/fix split).
5. `05-link-not-inline` — small, user-visible behavior change for the implementer prompt.
6. `06-feat-phases-cli` — observability and pre-flight; not blocking.
7. `07-test-mutability` — e2e workflow unlock.
8. `08-deviation-directives` — plan/spec deviation soft directive + post-round modification surfacer.
9. `09-docs-and-examples` — bundles each phase's doc work; runs last as cleanup.
