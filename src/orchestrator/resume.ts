/**
 * Resume-specific logic for the Software Factory.
 *
 * Handles git state capture, worktree creation for resuming failed runs,
 * save-on-Ctrl+C artifact persistence.
 */

import { createHash } from 'node:crypto';
import { mkdir, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { consola } from '../logger.js';
import { type RunStorage } from '../runs/storage.js';
import { type RunCommit, type RunSaveOptions, StaleArtifactError } from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import {
  git,
  gitAdd,
  gitApply,
  gitBranchDelete,
  gitCommit,
  gitDiff,
  gitWorktreeAdd,
  gitWorktreeRemove,
} from '../utils/git.js';
import { pathExists, readUtf8, spawnAsync, writeUtf8 } from '../utils/io.js';
import { type RunStorageContext } from './loop.js';
import { applyRunCommitInRepo } from './patch.js';
import { diffUntrackedFilesVersusDevNull, SAIFAC_TEMP_ROOT, type Sandbox } from './sandbox.js';

// ---------------------------------------------------------------------------
// Base git state capture (for run storage on start)
// ---------------------------------------------------------------------------

/**
 * Captures the current git state so we can reconstruct it when resuming.
 * Returns baseCommitSha and basePatchDiff: tracked changes (`git diff --binary HEAD`) plus untracked
 * files (`git diff --no-index --binary …`) so binary files round-trip through `git apply` on resume.
 */
export async function captureBaseGitState(projectDir: string): Promise<RunStorageContext> {
  let baseCommitSha: string;
  let basePatchDiff: string | undefined;

  try {
    // Resume always replays from a known commit; anything not in that commit must be captured as a patch.
    baseCommitSha = (await git({ cwd: projectDir, args: ['rev-parse', 'HEAD'] })).trim();
    const status = (await git({ cwd: projectDir, args: ['status', '--porcelain'] })).trim();
    if (status) {
      // Tracked: diff vs index/HEAD
      // Untracked: synthetic "add file" hunks so `git apply` can recreate them later.
      const tracked = await gitDiff({ cwd: projectDir, args: ['--binary', 'HEAD'] });
      const untracked = await diffUntrackedFilesVersusDevNull(projectDir);

      const hasTracked = tracked.trim().length > 0;
      const hasUntracked = untracked.trim().length > 0;
      if (!hasTracked && !hasUntracked) {
        basePatchDiff = undefined;
      } else {
        const parts: string[] = [];
        if (hasTracked) {
          parts.push(tracked.endsWith('\n') ? tracked : `${tracked}\n`);
        }
        if (hasUntracked) {
          parts.push(untracked.endsWith('\n') ? untracked : `${untracked}\n`);
        }
        const combined = parts.join('');
        // Empty check only — do not trim the diff body (trailing newline matters for git apply).
        basePatchDiff = combined.trim() === '' ? undefined : combined;
      }
    }
  } catch (err) {
    consola.warn('[orchestrator] Could not capture base git state for run storage:', err);
    baseCommitSha = '';
  }
  return { baseCommitSha, basePatchDiff, rules: [] };
}

// ---------------------------------------------------------------------------
// Create resume worktree
// ---------------------------------------------------------------------------

export interface CreateResumeWorktreeParams {
  projectDir: string;
  runId: string;
  baseCommitSha: string;
  basePatchDiff: string | undefined;
  runCommits: RunCommit[];
  /**
   * Git branch for the worktree. Defaults to `saifac-resume-${runId}` (ephemeral resume/test).
   * For `run apply` we set this to `saifac/<feature>-<runId>-<hash>`.
   */
  outputBranchName?: string;
}

export interface CreateResumeWorktreeResult {
  worktreePath: string;
  branchName: string;
  /** Directory tree (no `.git`) at base + base patch — before any `runCommits`; used to build sandbox "Base state". */
  baseSnapshotPath: string;
}

async function gitWorktreeListForDebug(cwd: string): Promise<string> {
  try {
    return (await git({ cwd, args: ['worktree', 'list'] })).trimEnd();
  } catch {
    return '(git worktree list failed)';
  }
}

/**
 * Materializes a **fresh** git worktree from the stored run artifact (always from scratch).
 * The worktree lives under `{@link SAIFAC_TEMP_ROOT}/resume-worktrees/` so it is ephemeral
 * like sandboxes — not under `.saifac/worktrees/` inside the repo (linked worktrees there
 * often break or confuse git). `runStartCore` then builds a new rsync sandbox from this path.
 *
 * Layers applied on top of `baseCommitSha`:
 * - Base patch diff — uncommitted host changes at run start (optional).
 * - Dedicated **saifac: base patch** commit (always, including empty when there was no base patch).
 * - Each {@link RunCommit} applied and committed in order.
 *
 * Also writes {@link CreateResumeWorktreeResult#baseSnapshotPath}: a copy of the tree after the
 * base patch (before run commits) for sandbox `rsync` + replayed `runCommits`.
 */
export async function createResumeWorktree(
  params: CreateResumeWorktreeParams,
): Promise<CreateResumeWorktreeResult> {
  const { projectDir, runId, baseCommitSha, basePatchDiff, runCommits, outputBranchName } = params;

  try {
    await git({ cwd: projectDir, args: ['rev-parse', baseCommitSha] });
  } catch {
    throw new Error(
      `baseCommitSha ${baseCommitSha} not found. Ensure you have pulled the latest changes or are on the correct machine.`,
    );
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'saifac',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'saifac@safeaifactory.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'saifac',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'saifac@safeaifactory.com',
  };

  const resumeWorktreesBase = join(SAIFAC_TEMP_ROOT, 'resume-worktrees');
  await mkdir(resumeWorktreesBase, { recursive: true });
  const dirKey = createHash('sha256').update(projectDir).digest('hex').slice(0, 16);
  const worktreePath = join(resumeWorktreesBase, `${dirKey}-${runId}`);
  const baseSnapshotPath = join(resumeWorktreesBase, `${dirKey}-${runId}-base`);
  const branchName = outputBranchName ?? `saifac-resume-${runId}`;

  // Same runId may have left a broken worktree dir / branch from a prior attempt; git would
  // otherwise leave us with no usable path and Node reports spawn ENOENT when cwd is missing.
  try {
    await gitWorktreeRemove({ cwd: projectDir, path: worktreePath, stdio: 'pipe' });
  } catch {
    /* not registered */
  }
  if (await pathExists(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
  }
  if (await pathExists(baseSnapshotPath)) {
    await rm(baseSnapshotPath, { recursive: true, force: true });
  }
  try {
    await gitBranchDelete({ cwd: projectDir, branch: branchName, force: true, stdio: 'pipe' });
  } catch {
    /* branch may not exist */
  }

  consola.log(`[orchestrator] Preparing workspace from storage...`);

  await gitWorktreeAdd({
    cwd: projectDir,
    path: worktreePath,
    branch: branchName,
    startCommit: baseCommitSha,
    env: gitEnv,
    stdio: 'inherit',
  });

  if (!(await pathExists(worktreePath))) {
    throw new Error(
      `[orchestrator] git worktree add exited 0 but worktree path is missing: ${worktreePath}\n` +
        `git worktree list:\n${await gitWorktreeListForDebug(projectDir)}`,
    );
  }

  const applyPatchFromString = async (diff: string) => {
    const tmpPath = join(worktreePath, '.saifac-apply.patch');
    // Ensure the patch string ends with a newline, otherwise git apply will fail with "corrupt patch".
    // Needed because older runs may have saved trimmed diffs into the JSON artifact.
    const safeDiff = diff.endsWith('\n') ? diff : diff + '\n';
    await writeUtf8(tmpPath, safeDiff);
    await gitApply({ cwd: worktreePath, env: gitEnv, patchFile: tmpPath });
    await unlink(tmpPath);
  };

  try {
    // Anchor commit for "what the host looked like when the run started": either apply the saved
    // dirty-tree diff then commit, or an empty commit so later steps always sit on top of a named base.
    if (basePatchDiff?.trim()) {
      await applyPatchFromString(basePatchDiff);
      await gitAdd({ cwd: worktreePath, env: gitEnv });
      await gitCommit({
        cwd: worktreePath,
        env: gitEnv,
        message: 'saifac: base patch',
        verbose: false,
        stdio: 'inherit',
      });
    } else {
      await git({
        cwd: worktreePath,
        env: gitEnv,
        args: ['commit', '--allow-empty', '-q', '-m', 'saifac: base patch'],
      });
    }

    // Plain directory tree (no .git) right after the base patch — rsync source for the sandbox
    // "Base state" before replaying runCommits inside code/.
    await mkdir(baseSnapshotPath, { recursive: true });
    await spawnAsync({
      command: 'rsync',
      args: ['-a', '--exclude=.git', `${worktreePath}/`, `${baseSnapshotPath}/`],
      cwd: projectDir,
      stdio: 'inherit',
    });

    // Stored run commits from the artifact, replayed on the worktree the user will inspect / link from.
    for (const commit of runCommits) {
      await applyRunCommitInRepo({ cwd: worktreePath, commit, gitEnv });
    }
  } catch (err: unknown) {
    // Remove worktree on failure. cleanupResumeWorkspace only invokes onError when *cleanup*
    // throws — not when apply failed — so we must rethrow the apply error here.
    await cleanupResumeWorkspace({ worktreePath, projectDir, branchName }, () => {});
    throw new Error(
      `[orchestrator] Failed to apply stored diffs. The run state may be incompatible with the current tree.\n${err}`,
    );
  }

  if (!(await pathExists(worktreePath))) {
    throw new Error(
      `[orchestrator] Resume worktree path missing after applying stored patches: ${worktreePath}\n` +
        `git worktree list:\n${await gitWorktreeListForDebug(projectDir)}`,
    );
  }

  let canonicalWorktreePath: string;
  try {
    canonicalWorktreePath = await realpath(worktreePath);
  } catch (err) {
    throw new Error(
      `[orchestrator] Could not realpath resume worktree ${worktreePath}: ${String(err)}`,
    );
  }

  let canonicalBaseSnapshotPath: string;
  try {
    canonicalBaseSnapshotPath = await realpath(baseSnapshotPath);
  } catch (err) {
    throw new Error(
      `[orchestrator] Could not realpath base snapshot ${baseSnapshotPath}: ${String(err)}`,
    );
  }

  return {
    worktreePath: canonicalWorktreePath,
    branchName,
    baseSnapshotPath: canonicalBaseSnapshotPath,
  };
}

// ---------------------------------------------------------------------------
// Cleanup resume worktree
// ---------------------------------------------------------------------------

export interface CleanupResumeWorkspaceParams {
  worktreePath: string;
  projectDir: string;
  branchName: string;
  deleteBranch?: boolean;
}

/**
 * Removes the resume worktree and optionally deletes the branch.
 * `onError` runs only if cleanup itself throws (e.g. git worktree remove failed); it does not
 * run on success. Callers that need to propagate a prior error must throw after awaiting this.
 */
export async function cleanupResumeWorkspace(
  params: CleanupResumeWorkspaceParams,
  onError: () => void,
): Promise<void> {
  const { worktreePath, projectDir, branchName, deleteBranch } = params;
  try {
    await gitWorktreeRemove({ cwd: projectDir, path: worktreePath });
    // `run apply` sets this to false so the branch is kept and made available to the user.
    if (deleteBranch) {
      await gitBranchDelete({ cwd: projectDir, branch: branchName, force: true });
    }
  } catch {
    onError();
  }
}

// ---------------------------------------------------------------------------
// Save run artifact (on Ctrl+C / failure)
// ---------------------------------------------------------------------------

export interface CreateSaveRunHandlerParams {
  sandbox: Sandbox;
  runContext: RunStorageContext;
  opts: BuildRunArtifactOpts;
  runStorage: RunStorage;
  /** Optimistic lock for the next save (from `runContext.expectedArtifactRevision`). */
  saveRunOptions?: RunSaveOptions;
}

/**
 * Returns an async handler for registry.setBeforeCleanup.
 * When the user hits Ctrl+C before the loop finishes, persists a failed run artifact (patch may be empty).
 */
export async function saveRunOnError(params: CreateSaveRunHandlerParams): Promise<void> {
  const { sandbox, runContext, opts, runStorage, saveRunOptions } = params;
  const runId = sandbox.runId;

  const existingArtifact = await runStorage.getRun(runId);

  // Interrupt path: reuse commits the loop already flushed to disk so resume isn’t blind;
  // bad/missing JSON → empty array.
  const commitsPath = join(sandbox.sandboxBasePath, 'run-commits.json');
  let runCommits: RunCommit[] = [];
  if (await pathExists(commitsPath)) {
    try {
      const raw = JSON.parse(await readUtf8(commitsPath)) as unknown;
      if (Array.isArray(raw)) {
        runCommits = raw as RunCommit[];
      }
    } catch {
      runCommits = [];
    }
  }

  const artifact = buildRunArtifact({
    runId,
    baseCommitSha: runContext.baseCommitSha,
    basePatchDiff: runContext.basePatchDiff,
    runCommits,
    specRef: opts.feature.relativePath,
    lastFeedback: runContext.lastErrorFeedback,
    rules: runContext.rules,
    roundSummaries: existingArtifact?.roundSummaries,
    status: 'failed',
    opts,
  });

  try {
    await runStorage.saveRun(runId, artifact, saveRunOptions);
    consola.log(
      `[orchestrator] Run artifact saved (interrupted). Resume with: saifac run resume ${runId}`,
    );
  } catch (err) {
    if (err instanceof StaleArtifactError) {
      consola.warn(`[orchestrator] ${err.message}`);
      return;
    }
    throw err;
  }
}
