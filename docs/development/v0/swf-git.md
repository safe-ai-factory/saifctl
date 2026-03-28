# Git Usage in the Software Factory

This document describes all the ways Git is used throughout the AI-Driven Software Factory workflow. It serves as the authoritative reference for developers maintaining the orchestrator and for anyone who needs to understand how patches flow from agent output to the host repository.

## Table of Contents

1. [Overview](#1-overview)
   - [Working tree contract](#working-tree-contract)
2. [Sandbox Creation](#2-sandbox-creation)
3. [Patch extraction (incremental rounds)](#3-patch-extraction-incremental-rounds)
4. [Patch Exclude Rules (Reward-Hacking Prevention)](#4-patch-exclude-rules-reward-hacking-prevention)
5. [Sandbox Reset Between Attempts](#5-sandbox-reset-between-attempts)
6. [Patch Application for Tests](#6-patch-application-for-tests)
7. [Iterative loop: commit, then verify](#7-iterative-loop-commit-then-verify)
8. [Success Path: Apply Patch to Host via Worktree](#8-success-path-apply-patch-to-host-via-worktree)
   - [Sandbox vs. worktree source asymmetry](#sandbox-vs-worktree-source-asymmetry)
9. [Push Target Resolution and GITHUB_TOKEN](#9-push-target-resolution-and-github_token)
10. [Security Considerations](#10-security-considerations)

---

## 1. Overview

The Software Factory uses Git in three distinct phases:

| Phase       | Where                                                     | Purpose                                                                                                                                                                |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox** | Isolated `code/` directory inside `/tmp/saifctl/sandboxes/` | A _fresh_ Git repo (not a clone) used solely for diffing agent changes against a baseline. The host's `.git` is never mounted or copied, to avoid exposing git history |
| **Tests**   | Same sandbox                                              | **`feat run` / `run start`:** after each round, `extractIncrementalRoundPatch` leaves `code/` at a new commit — staging/tests run on that tree (no extra `git apply` of the round diff). **`run test`:** same sandbox layout as resume (base snapshot + replayed `runCommits`); **`runIterativeLoop`** runs in **test-only** mode (no coding agent) and reuses the same staging / test-retry / vague-specs path. |
| **Success** | Host repository                                           | A Git worktree is used to create a feature branch, apply the patch, commit, and optionally push/PR—_without ever changing the main working tree's checked-out branch_. |

The host repository's working directory is **never** modified during the loop. All agent edits happen in the sandbox. Only after tests pass does the orchestrator create a separate worktree, apply the patch there, commit it, and optionally push. The user's current branch and uncommitted work remain untouched—enabling safe parallel runs of multiple agents.

### Working tree contract

**Primary workflow:** SaifCTL assumes the project you run against is in a **clean, committed** state at **`HEAD`**. By default the sandbox is filled with **`git archive HEAD`** (the tree recorded in Git at the tip commit), not whatever happens to be on disk. That keeps the baseline aligned with Git: what the agent sees is what is committed. **[`saifctl run apply`](../../commands/run-apply.md)** and merging the resulting `saifctl/…` branch into your line of work are straightforward in that mode.

**Edge case — dirty working tree:** **`--include-dirty`** on **`feat run`** (or **`defaults.includeDirty`** in config) switches the sandbox copy to an **rsync** of the working tree (committed + staged + unstaged + untracked, still respecting `.gitignore`). That is intentionally **opt-in**: local reminders, WIP files, and parallel edits are easier to model, but host apply can bake those paths into the feature branch history. For that situation, prefer **[`saifctl run export`](../../commands/run-export.md)** and apply the unified diff with **`git apply`** (or review via staged apply) so you control what gets committed. Distributed / CI runs should stay on the default (committed-only) contract.

---

## 2. Sandbox Creation

**Location:** `src/orchestrator/sandbox.ts` → `createSandbox()`

**Directory structure produced:**

```
{sandboxBaseDir}/{projectName}-{featureName}-{runId}/
  tests.full.json     ← Full test catalog (public + hidden) for the Test Runner
  host-base.patch     ← Empty when sandbox matches HEAD; else delta for host apply (see below)
  code/               ← Default: tree at HEAD via git archive; optional: rsync working tree
    .git/             ← Fresh git repo (git init), NOT a clone of the host
    saifctl/features/
      (all hidden/ dirs removed — agent cannot see holdout tests from any feature)
      {featureName}/tests/tests.json  ← Public-only tests
    ...rest of repo...
```

### Key Git-related steps

1. **`host-base.patch`** is written **before** the tree copy. When the sandbox will match **`HEAD`** exactly (default **`feat run`**: `git archive` only), the file is **empty** — no host replay is needed before applying agent diffs. When the sandbox is populated from a **working tree** (**`--include-dirty`**, or **`codeSourceDir`** for resume / base snapshot), **`host-base.patch`** holds **`git diff HEAD`** (tracked changes) plus synthetic diffs for **untracked** files so the host worktree can be brought in sync with the sandbox baseline before **`git apply`** of the agent's commits.

2. **Populate `code/`** — one of:

   - **Default (`includeDirty` false, no `codeSourceDir`):** committed tree only, via `git archive HEAD` piped into `tar`:

     ```bash
     git -C "${projectDir}" archive HEAD | tar -x -C "${codePath}"
     ```

     Respects Git's index for tracked paths at **`HEAD`** (and usual `git archive` export rules).

   - **`--include-dirty` or `codeSourceDir` (resume snapshot):** **rsync** from the source directory, honoring `.gitignore` and excluding `.git`:

     ```bash
     rsync -a --filter=:- .gitignore --exclude=.git "${codeRsyncSource}/" "${codePath}/"
     ```

   The sandbox still has **no** Git history from the host after this step.

3. **Remove all `hidden/` dirs** under `saifctl/features/` from the code copy. This strips holdout tests from _every_ feature (not just the current one), so the agent cannot read or infer them. The Test Runner later mounts the real `hidden/` dirs from the host when verifying the patch.

4. **Fresh Git repo inside `code/`:**

   ```bash
   git init
   git add .
   git commit -m "Base state"
   ```

   Uses fixed author/committer (`saifctl`, `saifctl@safeaifactory.com`) for reproducibility. Untracked files from an rsync copy become **tracked** in this commit; that is why the dirty-workflow and **`run apply`** interact awkwardly unless you use **`run export`**.

5. **Why a fresh repo?** The sandbox is a _snapshot_ used for diffing. The agent (OpenHands) writes files; we need a clean baseline to compute per-round diffs. Cloning the host repo would bring along its history and remotes—unnecessary and potentially confusing when we later apply the patch to a different branch.

**Resume / `run test`:** `createSandbox()` may set `codeSourceDir` to a **base snapshot** directory (tree before `runCommits`) and pass `runCommits` to **replay** each recorded commit after `"Base state"`. The tree is copied from that snapshot with **rsync** (not `git clone --local`).

---

## 3. Patch extraction (incremental rounds)

**Location:** `src/orchestrator/sandbox.ts` → `extractIncrementalRoundPatch()`

After each agent round, the orchestrator walks the **first-parent** chain from `preRoundHeadSha` to `HEAD` and emits **one `RunCommit` per commit** (message and author from that commit; diff `parent..commit`, with exclude rules applied). Any **leftover staged** work (including “only uncommitted” rounds) gets **one** extra commit with `saifctl: coding attempt <n>` and a matching `RunCommit` record.

### Sequence

1. **`git rev-list --reverse --first-parent preRoundHead..HEAD`** — ordered commit SHAs for this round.

2. **Per commit:** `git diff parent..sha`, `%B` / `%an <%ae>` for message and author, then **filter** excluded paths (see [§4](#4-patch-exclude-rules-reward-hacking-prevention)). Empty diffs after filtering are skipped.

3. **`git add`**, unstage `.saifctl/`. If the index is non-empty, **commit** with the round default message/author, then append the WIP step (`git diff` from tip-before-WIP to `HEAD`). If the filtered WIP diff is empty, the capture commit is undone with `git reset --soft HEAD~1` so excluded-only staging does not advance `HEAD` without a recorded step.

4. **Write** combined **`patch.diff`** beside `code/` and append all new round commits to **`run-commits.json`** (callers merge into the accumulator).

The sandbox **is not** reset before tests: staging runs against `code/` at `HEAD`. On test failure, the loop **pops every commit from this round** from the accumulator, updates `run-commits.json`, and **resets** to `preRoundHeadSha` (see [§5](#5-sandbox-reset-between-attempts)).

---

## 4. Patch Exclude Rules (Reward-Hacking Prevention)

**Location:** `src/orchestrator/modes.ts` (patchExclude), `sandbox.ts` (filterPatchHunks)

The agent must not be able to "cheat" by modifying tests or specs to fake a pass. Before any patch is applied to the host, certain file sections are stripped from the unified diff.

### Always-excluded paths

| Pattern         | Purpose                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `saifctl/**`     | The agent must not modify its own test specifications or test cases.             |
| `.git/hooks/**` | A malicious patch could install a git hook that runs arbitrary code on the host. |

### How filtering works

- A unified diff consists of file sections, each starting with `diff --git a/<path> b/<path>`.
- The patch is split on those headers; each section is tested against the exclude rules (glob or regex).
- Matching sections are dropped. A warning is logged listing dropped files.

---

## 5. Sandbox reset between attempts

**Location:** `loop.ts` → iterative loop failure path (`gitResetHard` / `gitClean`)

After **failed** tests (or when the agent must retry), the orchestrator **drops the whole outer attempt** from the artifact: it removes **all** `runCommits` entries recorded for that attempt (one entry per sandbox commit on the first-parent chain, plus an optional WIP `RunCommit` — see [§3](#3-patch-extraction-incremental-rounds)), then resets `code/` to **`preRoundHeadSha`**, the commit that was `HEAD` at the **start** of that attempt (includes any commits from earlier successful rounds in the same run, and seed commits when resuming).

### Commands

```bash
git reset --hard "${preRoundHeadSha}"
git clean -fd
```

- `git reset --hard`: Restores the tree to the state before **this attempt’s** commits (all of them), i.e. back to `preRoundHeadSha`.
- `git clean -fd`: Removes untracked files and directories.

**Ralph Wiggum technique:** Each OpenHands run starts from this clean state. The agent has no memory of previous attempts beyond what we explicitly feed back (e.g., sanitized error hints). State is persisted via the file system and **`runCommits`** — not via chat history.

---

## 6. Patch application for tests

**`saifctl feat run` / `run start` (inner loop):** **Location:** `loop.ts` — after `extractIncrementalRoundPatch`, `code/` is already at the round commit; staging mounts that tree. There is **no** `git apply` of `patch.diff` for verification in this path.

**`saifctl run test`:** **Location:** `modes.ts` → `fromArtifactCore({ testOnly: true })` → `runStartCore` → `loop.ts` → `runIterativeLoop` with **`OrchestratorOpts.testOnly`**. Worktree and sandbox setup match **`run start`**: `worktree.ts` → `createArtifactRunWorktree()`, then `sandbox.ts` → `createSandbox()` with the artifact worktree as **`sandboxSourceDir`**, **base snapshot** as **`codeSourceDir`**, and **`seedRunCommits`** replayed into `code/`.

The stored `basePatchDiff` (tracked/staged vs `HEAD` **plus untracked files**) is applied in the **temporary resume worktree**, then **`saifctl: base patch`** is committed, then each stored **`RunCommit`** is applied and committed in order (**same reconstruction as `run start`**). The sandbox is built by **rsync** from a **base snapshot** (before run commits) plus **replay** of `runCommits` inside `code/` — not via `git clone --local`. There is **no** second code path such as a separate `runTestsCore`: the orchestrator writes **`run-commits.json`** in the sandbox from the stored commits, runs **`runStagingTestVerification`** (staging + test retries + optional vague-specs handling), and persists outcomes through the same **`cleanupAndSaveRun`** path as **`run start`**.

**Host apply:** **`applyPatchToHost`** is called with **`projectDir`** set to the **CLI project directory** (the user’s repo root), **not** the ephemeral resume worktree. The caller passes **`commits`** in memory (the same `RunCommit[]` as written to **`run-commits.json`** in the sandbox) so the apply step does not re-read JSON from disk inside `applyPatchToHost`. `git worktree add` uses **`startCommit`** = the run’s **`baseCommitSha`** when available so the new branch roots at the same commit the sandbox was based on, not necessarily the user’s current `HEAD`. Using the resume worktree as `projectDir` here would replay commits onto a tree that already contains them and can produce errors such as *already exists in working directory* (see [§8](#8-success-path-apply-patch-to-host-via-worktree)).

---

## 7. Iterative loop: commit, then verify

**Location:** `modes.ts` → `runStartCore` → `runIterativeLoop()` (`loop.ts`)

In **saifctl feat run** and **saifctl run start**, the flow is:

1. Remember `preRoundHeadSha` (current `HEAD` in `code/` before the agent runs).
2. OpenHands runs and modifies files in the sandbox.
3. `extractIncrementalRoundPatch` records **one `RunCommit` per agent commit** (first-parent chain) plus an optional WIP `RunCommit`, and appends them to **`run-commits.json`** (see [§3](#3-patch-extraction-incremental-rounds)).
4. The Staging container uses the **`code/`** tree **as committed** — no separate `git apply` phase before tests.
5. If tests fail, that attempt’s run commits are dropped from the artifact, `code/` is reset to `preRoundHeadSha`, feedback is sent to OpenHands, and the loop repeats.

**`saifctl run test`** enters the same `runIterativeLoop` with **`testOnly`**: steps 1–2 and 5 are skipped (no agent, no reset-and-retry outer loop). The sandbox already reflects replayed **`runCommits`**; the loop writes **`run-commits.json`**, runs **`runStagingTestVerification`** once, then success/failure handling matches the normal path (including **`applyPatchToHost`** when tests pass). **Hatchet:** `feat-run` → `convergence-loop` branches the same way when **`testOnly`** is set on serialized opts.

---

## 8. Success Path: Apply Patch to Host via Worktree

**Location:** `src/orchestrator/phases/apply-patch.ts` → `applyPatchToHost()` (invoked from `loop.ts` / Hatchet `apply-patch` task)

When all tests pass, the orchestrator applies the winning patch to the **host** repository. To avoid mutating the user's checked-out branch (and to support parallel agent runs), we use **Git worktrees**.

### Design goals

- **Never touch the main working tree.** The user may have multiple agents running; each must be able to create its own branch without conflicting.
- **Branch visibility.** The default branch name ends with a **short hash of the combined patch** so retries and parallel runs are less likely to collide: `saifctl/<featureName>-<runId>-<diffHash>` where `<diffHash>` is the first **6** hex digits of SHA-256 over the concatenated `RunCommit` diffs. Override with **`--branch`** on `feat run`, `run start`, `run test`, or **`saifctl run apply`**.
- **Optional push and PR.** The user can supply `--push` and `--pr` to push the branch and open a Pull Request (provider-specific API).

### Flow

1. The loop (or Hatchet `apply-patch` task) builds **`commits: RunCommit[]`** from the in-memory accumulator (same data as **`run-commits.json`** on disk) and passes them into **`applyPatchToHost`**. A combined **`patch.diff`** is written under `sandboxBasePath` for the PR summarizer.

2. **Security check:** Reject patches that touch `.git/hooks/` (see [§10](#10-security-considerations)).

3. **Create a worktree** at `{sandboxBasePath}/worktree` on a new branch, starting at **`baseCommitSha`** when the run captured it:

   ```bash
   git worktree add -b "saifctl/${featureName}-${runId}-${diffHash}" "${sandboxBasePath}/worktree" "${baseCommitSha}"
   ```

   - When `baseCommitSha` is missing or invalid, the implementation may fall back to `HEAD`-anchored behavior; normal runs always persist `baseCommitSha` on the artifact.
   - The worktree lives inside the sandbox so it is removed when `destroySandbox` runs.
   - The main repo's checked-out branch is never changed.

4. **Apply host-base snapshot** (if any) so the worktree matches the sandbox baseline, then **for each run commit**: `git apply` the diff, `git add .`, `git commit` with that entry’s **message** and **author** (see `applyPatchToHost` in `phases/apply-patch.ts`).

5. **Optional push:** If `--push` is set, resolve the push target (see [§9](#9-push-target-resolution-and-github_token)) and:

   ```bash
   git push "${pushUrl}" "${branchName}"
   ```

6. **Optional PR:** If `--pr` is set (and `--push` was provided), call the GitHub REST API to create a Pull Request. Base branch is the branch the user had checked out when the command started.

7. **Remove the worktree:**
   ```bash
   git worktree remove --force "${wtPath}"
   ```
   This deregisters the worktree from Git's internal registry. The branch remains in the repo. The sandbox directory (including the worktree path) is then deleted by `destroySandbox`.

### Sandbox vs. worktree source asymmetry

The sandbox and the worktree are populated from different sources. This asymmetry has important consequences.

| Location            | How it is created                  | What it contains                                                 |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| **Sandbox `code/`** | Default: `git archive HEAD` into `code/`; optional `rsync` | Default: **committed** tree at `HEAD` only. With **`--include-dirty`** (or `defaults.includeDirty` in config): same as before — full working tree (committed + uncommitted + untracked, respecting `.gitignore`). Resume with a **base snapshot** always uses **rsync** from that snapshot. |
| **Worktree**        | `git worktree add` at **`baseCommitSha`** when set (else `HEAD`) | Only **COMMITTED** files at that commit until **`host-base.patch`** |

- **Sandbox:** By default `createSandbox()` runs `git archive HEAD` (via `sh` + `tar`) so the agent sees only committed files; `host-base.patch` is empty. With **`--include-dirty`**, it **rsync**s the working tree (`-a --filter=:- .gitignore --exclude=.git`) so uncommitted and untracked paths are visible; `host-base.patch` captures the delta for host apply. To land those runs without merging a branch that bakes in untracked files, use **`saifctl run export`** and `git apply`. See [run-export.md](../../commands/run-export.md).

- **Worktree:** For host apply, `git worktree add` creates the branch at **`baseCommitSha`** when set (stored run start), so the tree matches the sandbox’s git baseline even if the user has moved `HEAD` since. Untracked and uncommitted files from the main working tree are not present until **`host-base.patch`** is applied.

### CLI options

| Option            | Description                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--push <target>` | Push the feature branch after success. Accepts a Git URL, provider slug (`owner/repo`), or remote name.                              |
| `--pr`            | Create a Pull Request after pushing. Requires `--push` and the provider token env var.                                               |
| `--branch`        | Override the local branch name for host apply (default: `saifctl/<feature>-<runId>-<diffHash>`). Persisted in the run artifact when saved. |
| `--git-provider`  | Git hosting provider: `github` (default), `gitlab`, `bitbucket`, `azure`, `gitea`. See [swf-git-provider.md](./swf-git-provider.md). |

### `saifctl run apply`

When tests have already passed (or you accept the stored patch) but host apply failed or you deferred push/PR, **[`run apply`](../../commands/run-apply.md)** rebuilds the branch via **`createArtifactRunWorktree()`** under the same **`/tmp/worktrees/`** path as `run start`, using **`outputBranchName`** = the final host branch, then drops only the worktree registration so the branch remains. No sandbox tests or agent loop.

---

## 9. Push Target Resolution and GITHUB_TOKEN

**Location:** `src/git/` — see [swf-git-provider.md](./swf-git-provider.md) for the provider abstraction. Push resolution and PR creation are implemented by pluggable providers (e.g. `GitHubProvider`).

### Push target formats

| Format       | Example                             | How it is resolved                               |
| ------------ | ----------------------------------- | ------------------------------------------------ |
| Full Git URL | `https://github.com/owner/repo.git` | Used as-is (with token injection for github.com) |
| GitHub slug  | `owner/repo`                        | Expanded to `https://github.com/owner/repo.git`  |
| Remote name  | `origin`                            | Resolved via `git remote get-url origin`         |

### Provider tokens

Each git provider reads its token from an environment variable. For GitHub:

```
https://x-access-token:${GITHUB_TOKEN}@github.com/owner/repo.git
```

- Required for: `--push` via HTTPS to the provider's host, and for `--pr`.
- Not required for: SSH URLs, or remotes that use other auth (deploy keys, credential helpers).

See [swf-git-provider.md](./swf-git-provider.md) for provider-specific env vars.

### Repo slug extraction

When creating a PR, we derive the repository identifier from:

- The push target (if it is already a slug).
- The push URL (resolved from a remote name or full URL).

Each provider defines its own slug format (e.g. `owner/repo` for GitHub).

---

## 10. Security Considerations

### .git/hooks rejection

Patches that modify `.git/hooks/` are **rejected** before application. A malicious agent could otherwise inject a hook that runs arbitrary code on the host (e.g. on `git commit`). The check is a regex over the patch content:

```
/^diff --git.*\.git\/hooks\//m
```

### Parallel-run safety

- **Worktree:** The main working tree is never checked out to a different branch. Multiple agents can run simultaneously; each creates its own worktree and branch.
- **Branch naming:** `saifctl/<featureName>-<runId>-<diffHash>` (first **6** hex chars of the run-commit diff hash) avoids collisions when the same run id is reused or parallel runs overlap; **`--branch`** overrides when you need a fixed name.
- **Sandbox isolation:** Each run has its own sandbox directory. Canonical run commits live in `sandboxBasePath/run-commits.json` (and a combined `patch.diff` may be written for summarization), not in a shared location.

### Patch exclude rules

By stripping `saifctl/**` and `.git/hooks/**` from every patch, we prevent:

- **Reward hacking:** The agent cannot modify tests to force a pass.
- **Hook injection:** The agent cannot install git hooks on the host.

---

## Summary: Git Command Reference

| Phase             | Command                                           | Context      |
| ----------------- | ------------------------------------------------- | ------------ |
| Sandbox creation  | `git init`                                        | `codePath`   |
| Sandbox creation  | `git add .`                                       | `codePath`   |
| Sandbox creation  | `git commit -m "Base state"`                      | `codePath`   |
| Patch extraction  | `git add` / commit (one round)                     | `codePath`   |
| Patch extraction  | `git diff "${preRoundHeadSha}" HEAD`              | `codePath`   |
| Failure reset     | `git reset --hard "${preRoundHeadSha}"`           | `codePath`   |
| Failure reset     | `git clean -fd`                                   | `codePath`   |
| Success: worktree | `git branch --show-current`                       | `projectDir` |
| Success: worktree | `git worktree add "${wtPath}" -b "${branchName}"` | `projectDir` |
| Success: commit   | per–run-commit `git apply` + `git commit` (from JSON) | `wtPath`     |
| Success: push     | `git push "${pushUrl}" "${branchName}"`           | `wtPath`     |
| Success: cleanup  | `git worktree remove --force "${wtPath}"`         | `projectDir` |
| Success: fallback | `git worktree prune`                              | `projectDir` |
| Push resolution   | `git remote get-url ${remote}`                    | `projectDir` |
