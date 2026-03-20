# Git Usage in the Software Factory

This document describes all the ways Git is used throughout the AI-Driven Software Factory workflow. It serves as the authoritative reference for developers maintaining the orchestrator and for anyone who needs to understand how patches flow from agent output to the host repository.

## Table of Contents

1. [Overview](#1-overview)
2. [Sandbox Creation](#2-sandbox-creation)
3. [Patch Extraction](#3-patch-extraction)
4. [Patch Exclude Rules (Reward-Hacking Prevention)](#4-patch-exclude-rules-reward-hacking-prevention)
5. [Sandbox Reset Between Attempts](#5-sandbox-reset-between-attempts)
6. [Patch Application for Tests](#6-patch-application-for-tests)
7. [Iterative Loop: Re-Apply Before Verification](#7-iterative-loop-re-apply-before-verification)
8. [Success Path: Apply Patch to Host via Worktree](#8-success-path-apply-patch-to-host-via-worktree)
   - [Sandbox vs. worktree source asymmetry](#sandbox-vs-worktree-source-asymmetry)
9. [Push Target Resolution and GITHUB_TOKEN](#9-push-target-resolution-and-github_token)
10. [Security Considerations](#10-security-considerations)

---

## 1. Overview

The Software Factory uses Git in three distinct phases:

| Phase       | Where                                                     | Purpose                                                                                                                                                                |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox** | Isolated `code/` directory inside `/tmp/saifac/` | A _fresh_ Git repo (not a clone) used solely for diffing agent changes against a baseline. The host's `.git` is never mounted or copied, to avoid exposing git history |
| **Tests**   | Same sandbox                                              | The extracted patch is applied to the sandbox with `git apply` so the staging containers can verify the implementation.                                                |
| **Success** | Host repository                                           | A Git worktree is used to create a feature branch, apply the patch, commit, and optionally push/PR—_without ever changing the main working tree's checked-out branch_. |

The host repository's working directory is **never** modified during the loop. All agent edits happen in the sandbox. Only after tests pass does the orchestrator create a separate worktree, apply the patch there, commit it, and optionally push. The user's current branch and uncommitted work remain untouched—enabling safe parallel runs of multiple agents.

---

## 2. Sandbox Creation

**Location:** `src/orchestrator/sandbox.ts` → `createSandbox()`

**Directory structure produced:**

```
{sandboxBaseDir}/{projectName}-{featureName}-{runId}/
  tests.full.json     ← Full test catalog (public + hidden) for the Test Runner
  code/               ← rsync copy of the repo; workspace for OpenHands
    .git/             ← Fresh git repo (git init), NOT a clone of the host
    saifac/features/
      (all hidden/ dirs removed — agent cannot see holdout tests from any feature)
      {featureName}/tests/tests.json  ← Public-only tests
    ...rest of repo...
```

### Key Git-related steps

1. **rsync** copies the repo into `code/`, honoring `.gitignore` and **excluding** the host's `.git`:

   ```bash
   rsync -a --filter=':- .gitignore' --exclude='.git' "${projectDir}/" "${codePath}/"
   ```

   The sandbox starts with no Git history from the host.

2. **Remove all `hidden/` dirs** under `saifac/features/` from the code copy. This strips holdout tests from _every_ feature (not just the current one), so the agent cannot read or infer them. The Test Runner later mounts the real `hidden/` dirs from the host when verifying the patch.

3. **Fresh Git repo inside `code/`:**

   ```bash
   git init
   git add .
   git commit -m "Base state"
   ```

   Uses fixed author/committer (`saifac`, `saifac@localhost`) for reproducibility.

4. **Why a fresh repo?** The sandbox is a _pure file copy_ used for diffing. The agent (OpenHands) writes files; we need a clean baseline to compute `git diff HEAD` and produce a patch. Cloning the host repo would bring along its history and remotes—unnecessary and potentially confusing when we later apply the patch to a different branch.

---

## 3. Patch Extraction

**Location:** `src/orchestrator/sandbox.ts` → `extractPatch()`

After the agent (OpenHands) finishes an attempt, the orchestrator extracts a unified diff of all changes since the base commit.

### Sequence

1. **Stage all changes:**

   ```bash
   git add .
   ```

2. **Produce the raw patch:**

   ```bash
   git diff HEAD
   ```

   This yields a unified diff of staged changes versus `HEAD` (the "Base state" commit).

3. **Filter out excluded paths** (reward-hacking prevention; see [§4](#4-patch-exclude-rules-reward-hacking-prevention)).

4. **Write `patch.diff`** to `sandboxBasePath` (parent of `code/`):

   ```
   {sandboxBasePath}/patch.diff
   ```

   **Why outside `code/`?** Because the next step resets the working tree with `git clean -fd`. If `patch.diff` were inside `code/`, it would be deleted. Writing it to the sandbox root keeps it safe across the reset.

5. **Reset the sandbox** for the next attempt (see [§5](#5-sandbox-reset-between-attempts)).

---

## 4. Patch Exclude Rules (Reward-Hacking Prevention)

**Location:** `src/orchestrator/modes.ts` (patchExclude), `sandbox.ts` (filterPatchHunks)

The agent must not be able to "cheat" by modifying tests or specs to fake a pass. Before any patch is applied to the host, certain file sections are stripped from the unified diff.

### Always-excluded paths

| Pattern         | Purpose                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `saifac/**`     | The agent must not modify its own test specifications or test cases.             |
| `.git/hooks/**` | A malicious patch could install a git hook that runs arbitrary code on the host. |

### How filtering works

- A unified diff consists of file sections, each starting with `diff --git a/<path> b/<path>`.
- The patch is split on those headers; each section is tested against the exclude rules (glob or regex).
- Matching sections are dropped. A warning is logged listing dropped files.

---

## 5. Sandbox Reset Between Attempts

**Location:** `sandbox.ts` → `extractPatch()`, `modes.ts` → iterative loop failure path

After extracting the patch (or when an tests fail and we are about to retry OpenHands), the sandbox is reset to the baseline so the next attempt starts from a clean slate.

### Commands

```bash
git reset --hard HEAD
git clean -fd
```

- `git reset --hard HEAD`: Discards all uncommitted changes and restores the working tree to the "Base state" commit.
- `git clean -fd`: Removes untracked files and directories.

**Ralph Wiggum technique:** Each OpenHands run starts from this clean state. The agent has no memory of previous attempts beyond what we explicitly feed back (e.g., sanitized error hints). State is persisted via the file system and the patch we extract—not via chat history.

---

## 6. Patch Application for Tests

**Location:** `sandbox.ts` → `applyPatch()`, `modes.ts` → test mode

In **saifac run test** mode, the user supplies a patch file (e.g. from a previous run or a manual edit). Before running the staging containers, we inject that patch into the sandbox:

```bash
git apply "${patchPath}"
```

**Context:** `codePath` is the sandbox's `code/` directory. The patch is applied there so the Staging container (which uses `code/` as its build context or mount) sees the patched implementation. The Test Runner then runs the Black-Box tests against it.

---

## 7. Iterative Loop: Re-Apply Before Verification

**Location:** `modes.ts` → `runIterativeLoop()`

In **saifac feat run** and **saifac run resume**, the flow is:

1. OpenHands runs and modifies files in the sandbox.
2. `extractPatch()` produces `patch.diff` and **resets** the sandbox (see [§3](#3-patch-extraction), [§5](#5-sandbox-reset-between-attempts)).
3. Before starting the Staging and Test Runner containers, we **re-apply** the patch:

   ```bash
   git apply "${patchPath}"
   ```

   `patchPath` points to `sandboxBasePath/patch.diff`, which is outside `code/` and thus survived `git clean -fd`.

4. The Staging container is built from (or mounts) the patched `code/` directory. The Test Runner runs the tests.

5. If tests fail, the loop continues: we reset again, feed feedback to OpenHands, and repeat.

---

## 8. Success Path: Apply Patch to Host via Worktree

**Location:** `src/orchestrator/modes.ts` → `applyPatchToHost()`

When all tests pass, the orchestrator applies the winning patch to the **host** repository. To avoid mutating the user's checked-out branch (and to support parallel agent runs), we use **Git worktrees**.

### Design goals

- **Never touch the main working tree.** The user may have multiple agents running; each must be able to create its own branch without conflicting.
- **Branch visibility.** The new branch `saifac/<featureName>-<runId>` appears in `git branch` immediately and persists after the worktree is removed.
- **Optional push and PR.** The user can supply `--push` and `--pr` to push the branch and open a GitHub Pull Request.

### Flow

1. **Read `patch.diff`** from `sandboxBasePath/patch.diff` (same location as in the iterative loop).

2. **Security check:** Reject patches that touch `.git/hooks/` (see [§10](#10-security-considerations)).

3. **Create a worktree** at `{sandboxBasePath}/worktree` on a new branch:

   ```bash
   git worktree add "${sandboxBasePath}/worktree" -b "saifac/${featureName}-${runId}"
   ```

   - Branch name includes `runId` to avoid collisions when multiple agents run in parallel.
   - The worktree lives inside the sandbox so it is removed when `destroySandbox` runs.
   - The main repo's `HEAD` is never changed.

4. **Apply and commit** inside the worktree:

   ```bash
   git apply "${patchFile}"
   git add .
   git commit -m "feat(${featureName}): auto-generated implementation"
   ```

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
| **Sandbox `code/`** | `rsync` from the main working tree | Full working tree state: committed + UNCOMMITTED + **untracked** |
| **Worktree**        | `git worktree add` from `HEAD`     | Only **COMMITTED** files at `HEAD`                               |

- **Sandbox:** When `createSandbox()` runs, it uses `rsync -a --filter=':- .gitignore' --exclude='.git' "${projectDir}/" "${codePath}/"`. This copies everything from the main working tree that is not gitignored, including untracked files and directories. The agent (OpenHands) therefore sees and can rely on paths like `saifac/features/<featureName>/` even if they have never been committed.

- **Worktree:** When `git worktree add "${wtPath}" -b "${branchName}"` runs, Git creates a new working tree for the branch starting at the current `HEAD` commit. A worktree contains only what is in that commit. Untracked and uncommitted files from the main working tree are not present.

### CLI options

| Option            | Description                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--push <target>` | Push the feature branch after success. Accepts a Git URL, provider slug (`owner/repo`), or remote name.                              |
| `--pr`            | Create a Pull Request after pushing. Requires `--push` and the provider token env var.                                               |
| `--git-provider`  | Git hosting provider: `github` (default), `gitlab`, `bitbucket`, `azure`, `gitea`. See [swf-git-provider.md](./swf-git-provider.md). |

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
- **Branch naming:** `saifac/<featureName>-<runId>` ensures that two runs for the same change (e.g. retries or different attempt numbers) do not collide.
- **Sandbox isolation:** Each run has its own sandbox directory. Patches are written to `sandboxBasePath/patch.diff`, not to a shared location.

### Patch exclude rules

By stripping `saifac/**` and `.git/hooks/**` from every patch, we prevent:

- **Reward hacking:** The agent cannot modify tests to force a pass.
- **Hook injection:** The agent cannot install git hooks on the host.

---

## Summary: Git Command Reference

| Phase             | Command                                           | Context      |
| ----------------- | ------------------------------------------------- | ------------ |
| Sandbox creation  | `git init`                                        | `codePath`   |
| Sandbox creation  | `git add .`                                       | `codePath`   |
| Sandbox creation  | `git commit -m "Base state"`                      | `codePath`   |
| Patch extraction  | `git add .`                                       | `codePath`   |
| Patch extraction  | `git diff HEAD`                                   | `codePath`   |
| Patch extraction  | `git reset --hard HEAD`                           | `codePath`   |
| Patch extraction  | `git clean -fd`                                   | `codePath`   |
| Tests / re-apply  | `git apply "${patchPath}"`                        | `codePath`   |
| Failure reset     | `git reset --hard HEAD`                           | `codePath`   |
| Failure reset     | `git clean -fd`                                   | `codePath`   |
| Success: worktree | `git branch --show-current`                       | `projectDir` |
| Success: worktree | `git worktree add "${wtPath}" -b "${branchName}"` | `projectDir` |
| Success: commit   | `git apply`, `git add .`, `git commit`            | `wtPath`     |
| Success: push     | `git push "${pushUrl}" "${branchName}"`           | `wtPath`     |
| Success: cleanup  | `git worktree remove --force "${wtPath}"`         | `projectDir` |
| Success: fallback | `git worktree prune`                              | `projectDir` |
| Push resolution   | `git remote get-url ${remote}`                    | `projectDir` |
