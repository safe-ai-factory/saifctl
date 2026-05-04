# `_phases-and-critics` — specification

This is the *what* (filesystem shape, configs, critic mental model,
decisions). The *why* lives in `plan.md`. Per-phase implementation slices
live in each `phases/<id>/spec.md`.

This feature ships a single critic, `audit` — the project author's
daily-driver reviewer. Examples in this spec use `audit` accordingly. If
you compare against `TODO_phases_and_critics.md` you'll see older drafts
referenced `strict` / `paranoid` / `security` in the example YAML; those
have been collapsed to `audit` here so the spec matches what's actually
shipped under `critics/`.

## 1. Filesystem shape

```
saifctl/features/auth/
  proposal.md, plan.md, discovery.md   # freeform prose (existing convention)
  feature.yml                          # OPTIONAL — feature-wide settings
  critics/                             # OPTIONAL — critic prompt templates
    audit.md
  tests/                               # OPTIONAL — feature-wide tests (no-phases mode)
  phases/                              # OPTIONAL — presence triggers phased mode
    01-core/
      spec.md
      tests/
      phase.yml                        #   OPTIONAL — per-phase overrides
    02-trigger/
      spec.md
      tests/
    e2e/
      spec.md
      tests/
      phase.yml
```

### Strict filesystem rules

- **A phase is a directory under `phases/`.** Existence creates the phase.
- **Phase order = lexicographic** by directory name. Override only via
  `feature.yml.phases.order: [...]`.
- **A critic is a file under `critics/`.** Filename (sans `.md`) = critic
  id. Body = mustache prompt template.
- **No filename suffixes carry behavioral meaning.** No `--independent`,
  no marker files, no `.no-cumulative`, etc. All behavior lives in
  `feature.yml` / `phase.yml`. Filesystem encodes structure, not settings.
- **The `phases/` dir is optional.** If absent, the feature behaves as a
  single implicit phase = the whole feature.

### Why filesystem-as-structure

- Reordering phases = `git mv` — diff-friendly, reviewable.
- Adding a phase = `mkdir + touch spec.md + mkdir tests`. No registry
  bookkeeping.
- The directory tree is a complete, at-a-glance index of what the
  feature contains.
- Anything that can be inferred from the filesystem (phase id, test
  scope, presence of a critic) is **not** repeated in config.

## 2. Configuration files

Two files. Both optional. One vocabulary.

### 2.1 `feature.yml` (feature root)

```yaml
# All keys optional.
critics:                            # default critic selection at feature scope (no-phases mode
                                    # uses this directly; phased mode uses it as a fallback only
                                    # if neither phases.defaults.critics nor phase.yml specify)
  - { id: audit, rounds: 1 }

tests:                              # feature-scope test mutability config
  mutable: false                    # default false; see §2.6
  immutable-files: []               # globs that stay locked even when mutable=true

phases:                             # only meaningful if phases/ dir exists
  order: [01-core, 02-trigger, e2e] # omit to use lexicographic
  # Phases use cumulative tests. Always. (Not configurable.)
  defaults:                         # inherited by every phase that doesn't override
    critics:
      - { id: audit, rounds: 1 }
    tests:
      mutable: false                # default
      fail2pass: true               # default; auto-flips to false when mutable=true
```

Optionally, full per-phase config can live inline in `feature.yml`
under `phases.phases:` so a small project doesn't need to scatter
`phase.yml` files. For a 12-phase project, scattering is preferred to
avoid scrolling between feature.yml and the phase tree. Both forms
supported; per-phase `phase.yml` overrides whatever inline config
`feature.yml` declared for that phase.

### 2.2 `phases/<phase>/phase.yml` (per-phase)

```yaml
# All keys optional. Same vocabulary as feature.yml.phases.defaults.
critics:                            # FULL OVERRIDE of inherited list (no key-level merge)
  - { id: audit, rounds: 2 }
spec: spec.md                       # default; only set if you want a custom spec file path
tests:
  mutable: false
  fail2pass: true                   # default; auto-flips to false when mutable=true
  enforce: diff-inspection          # 'diff-inspection' (default) | 'read-only'
```

### 2.3 Resolution order (most-specific wins)

1. `phases/<id>/phase.yml`
2. `feature.yml.phases.defaults`
3. `feature.yml` top-level (for keys defined at both scopes, like
   `critics:`)
4. saifctl built-in default

**No key-level merge.** If `phase.yml` declares `critics:`, that
*replaces* the inherited list entirely. To extend, write the full list.
Rationale: avoids the "I added one critic but inherited two and now I
have three" surprise.

### 2.4 Critics list shape

Each critic entry is an object, not a bare string:

```yaml
critics:
  - { id: audit, rounds: 2 }        # rounds optional, default 1
  - { id: audit }
```

- `id` is required and matches a filename in `critics/<id>.md`.
- `rounds` defaults to `1`.
- The list ordering is significant: critics run in the order listed.
- If `critics:` is omitted in **all** of feature.yml, phases.defaults, and
  phase.yml, **all** critic files in `critics/` run, in alphabetical
  order, with `rounds: 1` each. (Conservative default — running too many
  is safer than skipping a critic the user expected.)

### 2.5 Validation rules (strict; fail loudly at validate time)

- Referenced critic id must correspond to an existing
  `critics/<id>.md`. Typo ⇒ error.
- Referenced phase id (in `feature.yml.phases.order`) must correspond to
  an existing `phases/<id>/` directory. Typo ⇒ error.
- `phases:` section in `feature.yml` is meaningful only when a `phases/`
  dir exists; if set without one, error.
- `tests.immutable-files` globs that match zero files at validate time
  ⇒ warn (may match files that don't exist yet in a "write the tests"
  phase). Globs that contain `..` segments or absolute paths ⇒ error.

### 2.6 Test mutability — full model

Three layers, evaluated as: walk up the dir tree from the test file,
first explicit declaration wins; if none found, fall back to the
project default (which `--strict`/`--no-strict` flips).

| Location                                         | Mutability                                    |
|--------------------------------------------------|-----------------------------------------------|
| `saifctl/tests/**`                               | **Always immutable.** Hard-coded; never overridable. |
| `saifctl/features/<feat>/phases/<id>/tests/**`   | Per `phase.yml.tests.mutable` ⇒ inherited from `feature.yml.phases.defaults` ⇒ inherited from `feature.yml.tests.mutable` ⇒ project default. |
| `saifctl/features/<feat>/tests/**`               | Per `feature.yml.tests.mutable` ⇒ project default. |

The project default is `false` (strict) unless `--no-strict` is passed
(or `defaults.strict: false` is set in `~/.saifctl/config.yml`).
`--no-strict` applies project-wide to every feature's tests dir;
`saifctl/tests/` stays immutable regardless.

**Per-file escape hatch:** `feature.yml.tests.immutable-files` (a list
of globs relative to the feature dir) marks specific files as immutable
even when the surrounding scope is mutable. Use for:
- a single test file that's been promoted to "this is now part of the
  contract, don't touch" without elevating the whole feature to
  `saifctl/tests/`;
- third-party-API mocks where the contract shape matters.

```yaml
# feature.yml
tests:
  mutable: true
  immutable-files:
    - "tests/api-contract.test.ts"
    - "tests/auth-flows/**"
```

**Enforcement:** `tests.enforce` selects mechanism, default
`diff-inspection`:

- `diff-inspection` (default) — after each round, saifctl runs
  `git diff` against the round's base commit; if any path resolved as
  immutable was touched, gate fails with a message naming offending
  paths. Composes with shared fixtures, gives useful error messages.
- `read-only` — bind-mount the test directory read-only inside the
  container. Bulletproof; breaks if tests need to write to siblings.
  Opt-in for the truly paranoid (e.g. third-party contracts in
  `saifctl/tests/`). Documented for v2; the schema parses it but the
  validator currently rejects it as "not implemented in this release".

**Implication for `design-fail2pass`:**
`tests.mutable: true` implies `tests.fail2pass: false` by default.
Cannot evaluate "tests must initially fail" when the agent is the one
writing them. Explicit `tests.fail2pass: true` overrides.

## 3. Critic mental model

A critic is **not a new subsystem**. A critic compiles to **two
subtasks per round** — a **discover** step and a **fix** step. Both
use the same `agentScript` as the implementer (same coder CLI). They
differ only in the prompt:

- **Discover** subtask uses the user-authored `critics/<id>.md`
  (mustache-rendered with phase + critic context). The prompt
  instructs the agent to find issues and **write them to a temp file
  at `{{critic.findingsPath}}`** as a markdown checklist. The agent
  does NOT modify code in this step.
- **Fix** subtask uses a **built-in template** (saifctl-owned, not
  user-provided). The prompt instructs the agent to read the findings
  file, address every item in code, update plan/spec/tests if needed
  (respecting mutability), and **delete the findings file** when done.

Both subtasks inherit the phase's test scope as their gate. Both run
in fresh LLM context (per-invocation `--no-session-persistence` of
the existing `agent.sh`). The container, working tree, and git history
persist; the LLM mind does not.

`rounds: 2` for critic `audit` ⇒ **four subtasks in sequence**:
discover#1 → fix#1 → discover#2 → fix#2. A "round" = one
(discover, fix) cycle. The second round's discover sees the first
round's fix commits via `git log` / `git diff` — we don't hide
anything between rounds, since critics are coding agents operating
on the working tree.

**There is no critic-specific success criterion.** Each critic
subtask "succeeds" when its tests pass — exactly like an implementer
round. If discover finds nothing (file is empty / contains "no
findings" sentinel), fix exits immediately as a no-op.

### 3.1 Why discover and fix are split (matches user's actual workflow)

Earlier drafts proposed a single "find AND fix in-place" critic
subtask. The user's real workflow has always been two steps:

1. *Reviewer agent* reads code + writes findings to a file.
2. *Coding agent* reads findings + applies fixes.

The split has practical benefits:

- **Cleaner separation of concerns.** The discover agent only
  thinks; the fix agent only changes code. Each step in fresh LLM
  context, so no "thought it through then changed its mind during
  fixing" entanglement.
- **Tangible artifact.** The findings file is inspectable between
  steps (helpful for debugging long overnight runs and for paused
  runs).
- **Cheap no-op for clean phases.** Discover finishes fast when
  there's nothing to find; fix exits immediately on empty findings.
- **Mirrors the user's existing manual flow** — direct translation,
  not a saifctl-flavored reinterpretation.

### 3.2 Findings file convention

Path: `/workspace/.saifctl/critic-findings/<phaseId>--<criticId>--r<round>.md`

- Inside the workspace `.saifctl/` dir (where `task.md` already
  lives). Distinct from the project's `saifctl/` *config* dir.
- Filename pinned by phase + critic + round so re-runs are
  deterministic and the fix step can find what discover wrote.
- Format: markdown checklist (`- [ ] Issue: ...`) so the fix step
  can iterate items.
- `"no findings"` (case-insensitive, on a line by itself) or empty
  body ⇒ fix step exits immediately as a no-op.
- Fix step deletes the file when done. If fix is interrupted and the
  file survives, it's re-overwritten by the next discover (no
  long-term orphan risk).
- Excluded from Phase 08's "noteworthy modification" warning — it's
  an expected transient artifact, not a code/spec change worth
  surfacing.

### 3.3 Why no "independent" flag

Earlier drafts proposed `independent: true` to mean "review #2 must
not see review #1's findings." This flag is dropped because:

- Each LLM invocation is already a fresh session
  (`--no-session-persistence`), so there is no chat history to share.
- The findings file from round#1 is **deleted** by fix#1 before
  discover#2 runs, so there's nothing to leak.
- The user's stated independence requirement (review #1 ⫫ review #2)
  is naturally satisfied by the fresh-LLM-per-round property + file
  deletion.

## 4. Critic prompt templates (mustache)

### 4.1 Reference, don't inline

The whole project repo is bind-mounted at `/workspace` in the container
(see `src/orchestrator/sandbox.ts`). The agent already has filesystem
access to:

- `/workspace/saifctl/features/<feat>/plan.md`
- `/workspace/saifctl/features/<feat>/phases/<id>/spec.md`
- `/workspace/saifctl/features/<feat>/critics/<id>.md`

…plus `git` for diff/log inspection. **Do not inline** plan/spec/diff
content into the critic prompt — it bloats every round (each round is
a fresh LLM context, so inlined content is paid for repeatedly) and
removes the agent's ability to selectively read what it needs.

### 4.2 Standard mustache variables (closed set, documented)

- `feature.name`, `feature.dir` (relative to /workspace),
  `feature.plan` (path to plan.md, may be empty)
- `phase.id`, `phase.dir`, `phase.spec` (path), `phase.baseRef`
  (git rev at start of this phase), `phase.tests` (path)
- `critic.id`, `critic.round`, `critic.totalRounds`,
  `critic.step` (`'discover' | 'fix'`),
  `critic.findingsPath` (workspace-rooted path to the temp findings file)

### 4.3 Partials for the rare inline case

`{{> file <path>}}` inlines a file's contents inside a fenced block
(so prose vs. file content is unambiguous). Use sparingly — for short,
always-needed preambles only. The path is workspace-relative and is
guarded against `..` segments and absolute paths at render time; the
host-side resolver further rejects anything that resolves outside the
sandbox via symlink.

**Authoring caveats (worth knowing before writing a partial file):**

- **The LLM sees everything inlined.** No author-aimed HTML comments,
  no editorial notes, no commentary about how the partial works. Keep
  partial files to direct content only (rules, conventions, reference
  text the agent should act on). Documentation about the partial
  belongs in a sibling README that *isn't* inlined.
- **Partial content is text, not a template.** Mustache tokens
  (`{{phase.id}}` etc.) inside an inlined file render as literal text;
  they are NOT substituted. This is intentional — it keeps the partial
  mechanism a one-way pipe and prevents stale tokens in referenced
  files from breaking renders. If you need a variable in the inlined
  section, put it in the *template* before/after the `{{> file ...}}`
  partial, not in the file itself.

The combined consequence: prose that mentions partial syntax (e.g.
"this file is inlined via `{{> file ...}}`") ships verbatim into every
prompt that uses the partial. Both `_phases-example/_preamble.md` and
`_phases-and-critics/_preamble.md` were trimmed to direct-content only
for this reason.

### 4.4 Worked example

The user-authored discover template ships at `critics/audit.md` in this
feature, and at `saifctl/features/_phases-example/critics/audit.md` for
the runnable worked example. Both reference `_preamble.md` via the
`{{> file ...}}` partial.

### 4.5 Built-in fix template

The fix step uses a saifctl-owned template (not user-provided). The
agent reads `{{critic.findingsPath}}`, addresses every item, updates
plan/spec/tests if needed (respecting mutability per §2.6), and
deletes the findings file. Empty / "no findings" file ⇒ no-op exit.

The fix template lives in `src/specs/phases/critic-prompt.ts` as a
named export. Power users can shadow it later via a per-critic
override (`critics/<id>.fix.md`) — out of scope for v1.

## 5. How phases compile to subtasks

A feature with phases compiles deterministically to a `subtasks.json`-
shaped sequence consumed by the existing `runIterativeLoop` in
`src/orchestrator/loop.ts`.

### 5.1 Worked example

Given a feature with phases `00-spikes` (no critics), `01-core`,
`02-trigger`, `03-edge` (override: audit×2), `e2e`, and the default
critic list `[{audit, 1}]`:

```
[ implementer(00-spikes),
  implementer(01-core),
    discover(audit, 01-core, r1), fix(audit, 01-core, r1),
  implementer(02-trigger),
    discover(audit, 02-trigger, r1), fix(audit, 02-trigger, r1),
  implementer(03-edge),
    discover(audit, 03-edge, r1), fix(audit, 03-edge, r1),
    discover(audit, 03-edge, r2), fix(audit, 03-edge, r2),    # rounds: 2
  implementer(e2e),
    discover(audit, e2e, r1), fix(audit, e2e, r1) ]
```

Each row is a subtask in the existing model:
`{ id, agentScript, gateScript, gateRetries, prompt, ... }`.
Phase tests are scoped per-phase and **always cumulative** (each phase
gates on its own tests + all prior phases' tests). Discover and fix
share the same `testScope` (the phase's gate); discover almost always
passes that gate trivially since it doesn't modify code.

A complete copy-pasteable phased feature lives at
`saifctl/features/_phases-example/` — read its `_README.md` for the
annotated tour.

### 5.2 The single structural change to the loop

Per-subtask test scope. The legacy `runStagingTestVerification` runs
the feature's whole `tests/` dir for every subtask. Phases need each
subtask's gate to be its phase's tests + cumulative prior tests. This
is the only loop edit; everything else (subtasks shape, agent script
overrides, gate script, fresh LLM per round) already exists.

Files touched:

- `src/runs/types.ts` — `testScope?: { include?: string[];
  cumulative?: boolean }` on `RunSubtaskInput`.
- `src/orchestrator/loop.ts` — `prepareTestRunnerOpts` honors
  `activeRow.testScope`.
- `src/orchestrator/resolve-subtasks.ts` — "compile from phases" path
  alongside the legacy `subtasks.json` / plan.md paths.
- `src/specs/discover.ts` — recognise and resolve `phases/<id>/` as
  feature-internal phase dirs.
- `src/specs/phases/load.ts` — read `feature.yml` / `phase.yml`,
  validate, expand into typed phase records.
- `src/specs/phases/compile.ts` — phase records → subtasks.
- `src/specs/phases/critic-prompt.ts` — mustache rendering for critic
  templates.

## 6. Decisions made (short list, with rationale)

- **Filesystem encodes structure; config files encode behavior.**
  Settings like "rounds=2" never live in filenames. Folders carry
  identity (phase id, critic id) and ordering, not flags.
- **`feature.yml` is the canonical name** (not `phases.yml`). One file
  per scope (feature, phase). `.yml`/`.yaml`/`.json` accepted.
- **Critic = coding agent + different prompt.** No reviewer-profile
  abstraction. No critic-specific success criterion. The same coder
  CLI runs both implementer and critic subtasks.
- **Each critic round = two subtasks: discover + fix.** Mirrors the
  user's actual workflow (a "reviewer" run that writes findings,
  followed by a "fixer" run that applies them). Discover writes to
  `/workspace/.saifctl/critic-findings/<phase>--<critic>--r<n>.md`;
  fix reads, applies, deletes. `rounds: N` ⇒ N discover-fix cycles
  (2N subtasks per critic per phase). User authors only the discover
  template (`critics/<id>.md`); fix uses a built-in template owned by
  saifctl.
- **No `independent` flag for critics.** Fresh LLM per round + the
  fix-step deletion of the findings file mean nothing leaks between
  rounds.
- **No `tests.cumulative: false` on phases.** Phases are always
  cumulative. The non-cumulative case did not surface a real
  use-case; remove the footgun.
- **Critics list = list of objects** (`[{id, rounds}]`), not a list of
  strings. Per-critic `rounds` is the natural place for it.
- **Default critic `rounds: 1`.**
- **Missing critic file referenced in config ⇒ loud error** at
  validate time.
- **Critics omitted in all configs ⇒ run all critic files in
  `critics/`**, alphabetical, `rounds: 1` each. Conservative default.
- **Critic ordering is positional from the resolved list.** Alphabetical
  only as the fallback when no list is provided.
- **No key-level merge across resolution layers.** A `phase.yml`
  `critics:` declaration replaces the inherited list entirely.
- **Mustache template engine** for critic prompts. Closed set of
  variables. `{{> file <path>}}` partial for the rare inline case.
- **Plan-doc remains freeform prose.** No headings parsing, no
  embedded directives, no notebook-style execution. Structured data
  goes in yaml/json, never markdown.
- **The agent should update plan.md with deviations during each
  step.** This is part of the implementer/critic prompt template
  (one-line directive). Saifctl warns (not fails) if a step produced
  a commit touching plan.md / spec.md / a test file.
- **Drop `type: e2e` phase tag.** Phases are uniform. The "e2e
  phase" use-case decomposes into orthogonal mutability/fail2pass
  knobs.
- **Test mutability is a first-class config axis** with three layers:
  - `saifctl/tests/` — project-level, **always immutable, never
    overridable**, runs as part of every feature run. Holds 3rd-party
    integration contracts, customer-promised behavior, etc.
  - `saifctl/features/<feat>/tests/` and
    `saifctl/features/<feat>/phases/<id>/tests/` — feature- and
    phase-level. Mutable iff `tests.mutable: true` is declared at
    that scope or inherited (see §2.3 resolution order), or iff
    `--no-strict` is set globally.
  - Per-file glob escape hatch via `feature.yml.tests.immutable-files`.
- **`--strict` (default) / `--no-strict` CLI flag** flips the
  project-wide default for `tests.mutable`. Applies across **all**
  features' tests in the repo (refactors often touch tests in other
  features). `saifctl/tests/` stays immutable regardless.
- **Mutability enforcement = post-round diff inspection** (default).
  After each round, saifctl inspects the git diff and fails the gate
  if any test path resolved as immutable was touched. Failure message
  names the offending paths. Read-only mount is available as an
  opt-in `tests.enforce: read-only` for paranoid cases (deferred to
  v2; the schema parses it but the validator currently rejects it).
- **`tests.mutable: true` implies `tests.fail2pass: false`** by
  default. Cannot evaluate "tests must initially fail" when the agent
  is the one writing them. Explicit `tests.fail2pass: true` overrides.
- **Critic prompts reference paths, do not inline content.** The
  workspace is bind-mounted at `/workspace` in the container; the
  agent has filesystem access to all of `saifctl/features/<feat>/`.
  Inlining bloats every fresh-LLM round.
- **Implementer prompt also switches to link-only** for plan.md, for
  symmetry with critics and to save tokens across the many
  implementer rounds per phase. Note: this is a behavior change for
  existing users; the prompt must include a strong directive ("MUST
  read plan.md before starting any work").
- **Plan/spec deviation handling = inverted from initial proposal.**
  Not all rounds will deviate from the plan, so saifctl does **not**
  enforce or warn when plan.md is *unchanged*. Instead:
  - Implementer/critic prompts include a directive: *"If your
    implementation deviates from the original plan or spec, update
    `plan.md` / `spec.md` to reflect the actual implementation."*
    Soft directive; not enforced.
  - **After each round, saifctl prints an informational warning if
    the agent's commits modified `plan.md`, any `spec.md`, or any
    test file** — naming the modified paths. Non-fatal; surfaces the
    change in the run log so the user notices it during overnight
    review. Independent of mutability enforcement (which fails the
    gate when *immutable* tests are touched; the warning surfaces
    *all* such modifications regardless of mutability).
- **Feature-level `tests/` and phase-level `tests/` both supported,
  but with different gating semantics.** When `phases/` exists,
  `saifctl/features/<feat>/tests/` continues to be valid for tests
  that span the entire feature (cross-phase e2e, end-state
  contracts); `saifctl/features/<feat>/phases/<id>/tests/` holds
  tests specific to that phase. **Phase-level tests are cumulative
  across phases; feature-level and project-level tests run only at
  the end** (gating only the last phase). Rationale: in a multi-phase
  migration (e.g. mongo→postgres in 4 phases), feature-level tests
  describe the *terminal* state of the feature and cannot pass at
  intermediate phases by design. Mutability rules apply per-dir.
- **Inline-phases-in-feature.yml syntax: `phases.phases.<id>: {...}`**
  for projects that prefer a single config file over scattered
  `phase.yml` files. When both `feature.yml.phases.phases.<id>` and
  `phases/<id>/phase.yml` exist, the per-phase file wins.

## 7. Out of scope for the first cut

- **Pipeline-of-runs** (chaining multiple `runStart` invocations across
  phases). Considered and rejected as wasteful.
- **Goal-tree / declarative "done-when" predicates.** Considered and
  rejected as a magic-vs-predictable tradeoff that loses determinism.
- **TS-DSL / algebraic combinators for phase composition.** Power users
  can hand-write `subtasks.json` if they need that level of control.
- **Plan-doc-as-notebook** (parsing `## Phase N` headings as
  executable). Rejected; markdown stays freeform.
- **Reviewer-kind abstraction** (Argus vs Claude vs custom-script as
  alternative reviewer backends). Argus stays as the reviewer gate;
  critics are coding agents; we don't need a third backend dimension.

---

## Appendix A — Future considerations (post-first-cut)

These are not blocking the first implementation. Captured for later
deliberation.

### A.1 Promoting agent-written tests to project-level contracts

After an "agent writes the e2e tests" phase completes successfully,
the user may want to elevate those tests to `saifctl/tests/`
(project-level, always-immutable) so they become durable contracts.
Today this is a manual `git mv`. Worth a `saifctl tests promote` CLI
command later if the pattern proves common.

### A.2 Per-phase plan-deviation log files

The "warn on plan.md / spec.md modification" decision (§6) prints to
the run log. A nice-to-have: also keep a structured per-phase log of
which files the agent touched outside the expected scope, e.g.
`.saifctl/runs/<runId>/deviations.json`. Useful for post-hoc review
of long overnight runs without scrolling through full logs.

### A.3 Reviewer-gate (Argus) per-phase configuration

The existing reviewer gate runs with one config across the whole run.
With phases, it might be useful to scope reviewer-gate config
per-phase (different model, focus areas, or skip entirely for spike
phases). Out of scope for the first cut.

### A.4 "Always-on" project-level tests

The §6 decision is that `saifctl/tests/` (project-level) and
`features/<feat>/tests/` (feature-level) only gate the *last* phase —
matching the mongo→postgres rationale where end-state tests can't pass
mid-migration. But a real use case exists for *invariants* that should
hold at every phase: e.g. a security scan, a "no secrets in code"
check, or a "build still compiles" smoke test.

Possible later approaches:
- Subdivide `saifctl/tests/` into `saifctl/tests/always/` (every
  phase) and `saifctl/tests/end/` (last phase only).
- A `saifctl/tests.yml` listing per-glob gating policy.
- A `tests.gates: ['always' | 'end']` field per feature/phase.

Defer until someone hits the limitation in practice. For now: if
something needs to gate every phase, put it in `phases/01-X/tests/`
(it'll be cumulative from there forward).

### A.5 Phase-aware Reviewer (Argus) diff base

**Status as shipped:** the Reviewer gate (`reviewer.sh`) always diffs
from the run's root commit ("Base state") to HEAD. This was correct
for single-phase runs but is not phase-aware. For a multi-phase run,
the Reviewer sees the cumulative diff every phase — including all
already-passed prior phases — instead of just the work the current
phase added.

Critics ARE phase-scoped via `{{phase.baseRef}}`. The Reviewer is not.

**Sketch of a fix:** thread the active subtask's `phaseBaseRef`
(already captured by the loop and present on critic-prompt vars) into
the Reviewer's environment, e.g. `REVIEWER_BASE_REF`. `reviewer.sh`
would prefer the env var when set and fall back to the root commit
when not. No schema change, no API surface change.

Defer until someone hits the noise in practice or §A.3 is being built
out anyway.
