/**
 * Resume-specific logic for the Software Factory.
 *
 * Handles git state capture, worktree creation for resuming failed runs,
 * save-on-Ctrl+C artifact persistence, and merging restored config with CLI overrides.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRunArtifact } from '../run-storage/build-artifact.js';
import { deserializeOpts } from '../run-storage/serialize.js';
import type { RunArtifact, RunStorage } from '../run-storage/types.js';
import { resolveFeature } from '../specs/discover.js';
import { type IterativeLoopOpts, type RunStorageContext } from './loop.js';
import type { OrchestratorOpts } from './modes.js';
import type { SandboxPaths } from './sandbox.js';

// ---------------------------------------------------------------------------
// Base git state capture (for run storage on start)
// ---------------------------------------------------------------------------

/**
 * Captures the current git state so we can reconstruct it when resuming.
 * Returns baseCommitSha and basePatchDiff (unstaged + staged) for RunStorageContext.
 */
export function captureBaseGitState(projectDir: string): RunStorageContext {
  let baseCommitSha: string;
  let basePatchDiff: string | undefined;

  const gitCommand = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr ?? '');
    return result.stdout ?? '';
  };

  try {
    baseCommitSha = gitCommand(['rev-parse', 'HEAD']).trim();
    const status = gitCommand(['status', '--porcelain']).trim();
    if (status) {
      const unstaged = gitCommand(['diff']).trim();
      const staged = gitCommand(['diff', '--cached']).trim();
      basePatchDiff = [unstaged, staged].filter(Boolean).join('\n').trim() || undefined;
    }
  } catch (err) {
    console.warn('[orchestrator] Could not capture base git state for run storage:', err);
    baseCommitSha = '';
  }
  return { baseCommitSha, basePatchDiff };
}

// ---------------------------------------------------------------------------
// Create resume worktree
// ---------------------------------------------------------------------------

export interface CreateResumeWorktreeParams {
  projectDir: string;
  runId: string;
  baseCommitSha: string;
  basePatchDiff: string | undefined;
  runPatchDiff: string;
}

export interface CreateResumeWorktreeResult {
  worktreePath: string;
  branchName: string;
}

/**
 * Re-creates a workspace to the state as it was when the coding agent ended.
 *
 * Combines 3 layers:
 * - Base commit - The last available commit in the user's workspace before the run started.
 * - Base patch diff - Any user-made uncommitted changes before the run started.
 * - Run patch diff - The diff that the coding agent generated during the run.
 *
 * base commit + base patch diff -> state of the workspace at the time of starting the run.
 * (base commit + base patch diff) + run patch diff -> state when the coding agent ended.
 */
export function createResumeWorktree(
  params: CreateResumeWorktreeParams,
): CreateResumeWorktreeResult {
  const { projectDir, runId, baseCommitSha, basePatchDiff, runPatchDiff } = params;

  try {
    const r = spawnSync('git', ['rev-parse', baseCommitSha], { cwd: projectDir });
    if (r.status !== 0) throw new Error(r.stderr?.toString() ?? '');
  } catch {
    throw new Error(
      `baseCommitSha ${baseCommitSha} not found. Ensure you have pulled the latest changes or are on the correct machine.`,
    );
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'factory',
    GIT_AUTHOR_EMAIL: 'factory@localhost',
    GIT_COMMITTER_NAME: 'factory',
    GIT_COMMITTER_EMAIL: 'factory@localhost',
  };

  const worktreeDir = join(projectDir, '.saif', 'worktrees');
  mkdirSync(worktreeDir, { recursive: true });
  const worktreePath = join(worktreeDir, `resume-${runId}`);
  const branchName = `factory-resume-${runId}`;

  console.log(`[orchestrator] Preparing workspace from storage...`);

  const addResult = spawnSync(
    'git',
    ['worktree', 'add', worktreePath, '-b', branchName, baseCommitSha],
    { cwd: projectDir, env: gitEnv },
  );
  if (addResult.status !== 0) {
    throw new Error(
      addResult.stderr?.toString() ?? `git worktree add failed with status ${addResult.status}`,
    );
  }

  const applyPatchFromString = (diff: string) => {
    const tmpPath = join(worktreePath, '.saif-apply.patch');
    writeFileSync(tmpPath, diff, 'utf8');
    const applyResult = spawnSync('git', ['apply', tmpPath], { cwd: worktreePath, env: gitEnv });
    if (applyResult.status !== 0) {
      throw new Error(
        applyResult.stderr?.toString() ?? `git apply failed with status ${applyResult.status}`,
      );
    }
    unlinkSync(tmpPath);
  };

  try {
    if (basePatchDiff?.trim()) {
      applyPatchFromString(basePatchDiff);
    }
    applyPatchFromString(runPatchDiff);
  } catch (err: unknown) {
    cleanupResumeWorkspace({ worktreePath, projectDir, branchName }, () => {
      throw new Error(
        `Failed to apply stored diffs. The run state may be incompatible with the current tree.\n${err}`,
      );
    });
  }

  return { worktreePath, branchName };
}

// ---------------------------------------------------------------------------
// Cleanup resume worktree
// ---------------------------------------------------------------------------

export interface CleanupResumeWorkspaceParams {
  worktreePath: string;
  projectDir: string;
  branchName: string;
}

/**
 * Removes the resume worktree and deletes the branch.
 * Calls onError if cleanup throws.
 */
export function cleanupResumeWorkspace(
  params: CleanupResumeWorkspaceParams,
  onError: () => void,
): void {
  const { worktreePath, projectDir, branchName } = params;
  try {
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectDir });
    spawnSync('git', ['branch', '-D', branchName], { cwd: projectDir });
  } catch {
    onError();
  }
}

// ---------------------------------------------------------------------------
// Save run artifact (on Ctrl+C / failure)
// ---------------------------------------------------------------------------

export interface CreateSaveRunHandlerParams {
  sandbox: SandboxPaths;
  runContext: RunStorageContext;
  opts: IterativeLoopOpts & { gitProvider: { id: string }; testProfile: { id: string } };
  runStorage: RunStorage;
  saifDir: string;
}

/**
 * Returns an async handler for registry.setBeforeCleanup.
 * When the user hits Ctrl+C or the loop exits due to failure, the callback persists an artifact
 * if patch.diff exists and is non-empty, so the user can resume with saif run resume.
 */
export async function saveRunOnError(params: CreateSaveRunHandlerParams): Promise<void> {
  const { sandbox, runContext, opts, runStorage, saifDir } = params;

  const runId = sandbox.runId;
  const patchPath = join(sandbox.sandboxBasePath, 'patch.diff');

  if (!existsSync(patchPath)) return;

  const runPatchDiff = readFileSync(patchPath, 'utf8');
  if (!runPatchDiff.trim()) return;

  const artifact = buildRunArtifact({
    runId,
    baseCommitSha: runContext.baseCommitSha,
    basePatchDiff: runContext.basePatchDiff,
    runPatchDiff,
    specRef: `${saifDir}/features/${opts.feature.name}`,
    lastFeedback: runContext.lastErrorFeedback,
    status: 'failed',
    opts,
  });

  // Save the artifact to runStorage so the user can resume later.
  await runStorage.saveRun(runId, artifact);
  console.log(`[orchestrator] Run state saved (Ctrl+C). Resume with: saif run resume ${runId}`);
}

// ---------------------------------------------------------------------------
// Merge resume opts
// ---------------------------------------------------------------------------

export interface MergeResumeOptsParams {
  artifact: RunArtifact;
  opts: OrchestratorOpts & { runId: string };
  overrides: OrchestratorOpts['overrides'];
  worktreePath: string;
}

/**
 * Merges deserialized config from the stored artifact with CLI opts.
 * User gets all original settings by default but can override via CLI.
 */
export function mergeResumeOpts(params: MergeResumeOptsParams): OrchestratorOpts {
  const { artifact, opts, overrides, worktreePath } = params;
  const { baseCommitSha, basePatchDiff } = artifact;
  const deserialized = deserializeOpts(artifact.config);
  const feature = resolveFeature({
    input: deserialized.featureName,
    projectDir: opts.projectDir,
    saifDir: deserialized.saifDir,
  });

  return {
    ...deserialized,
    ...opts,
    feature,
    projectDir: opts.projectDir,
    overrides: { ...deserialized.overrides, ...overrides },
    sandboxProfileId: (deserialized.sandboxProfileId ??
      opts.sandboxProfileId) as OrchestratorOpts['sandboxProfileId'],
    resume: {
      sandboxSourceDir: worktreePath,
      runContext: { baseCommitSha, basePatchDiff },
      initialErrorFeedback: artifact.lastFeedback,
    },
  } satisfies OrchestratorOpts;
}
