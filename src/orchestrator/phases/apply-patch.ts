/**
 * Phase: apply-patch — apply sandbox patch to host via git worktree.
 */

import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { generatePRSummary } from '../../git/agents/pr-summarizer.js';
import type { GitProvider } from '../../git/types.js';
import type { LlmOverrides } from '../../llm-config.js';
import { consola } from '../../logger.js';
import type { RunCommit } from '../../runs/types.js';
import type { Feature } from '../../specs/discover.js';
import {
  gitAdd,
  gitApply,
  gitBranchShowCurrent,
  gitCommit,
  gitPush,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
} from '../../utils/git.js';
import { readUtf8, writeUtf8 } from '../../utils/io.js';
import { resolveRunCommitAuthor } from '../patch.js';

export type { OrchestratorOutcomeStatus, OrchestratorResult } from '../loop.js';

/** Count of hex digits taken from SHA-256 for the branch suffix (`saifctl/...-<diffHash>`). */
export const HOST_APPLY_DIFF_HASH_LEN = 6;

/**
 * Stable short hash over the concatenated agent commit diffs.
 */
export function computeRunCommitsDiffHash(commits: RunCommit[]): string {
  const body = commits.map((c) => c.diff).join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, HOST_APPLY_DIFF_HASH_LEN);
}

export interface HostApplyBranchNameOpts {
  featureName: string;
  runId: string;
  commits: RunCommit[];
}

/**
 * Default local branch for host apply: `saifctl/<feature>-<runId>-<diffHash>`.
 */
export function defaultHostApplyBranchName(opts: HostApplyBranchNameOpts): string {
  const { featureName, runId, commits } = opts;
  const h = computeRunCommitsDiffHash(commits);
  return `saifctl/${featureName}-${runId}-${h}`;
}

export interface ResolveHostApplyBranchNameOpts extends HostApplyBranchNameOpts {
  targetBranch?: string | null;
}

/** Use explicit `--branch` when set; otherwise {@link defaultHostApplyBranchName}. */
export function resolveHostApplyBranchName(opts: ResolveHostApplyBranchNameOpts): string {
  const { featureName, runId, commits, targetBranch } = opts;
  const trimmed = targetBranch?.trim();
  if (trimmed) return trimmed;
  return defaultHostApplyBranchName({ featureName, runId, commits });
}

/**
 * Throws if combined diffs touch `.git/hooks/`.
 *
 * A hook injected here would run on the host machine the next time any git operation triggers it.
 * */
export function assertRunCommitsSafeForHost(commits: RunCommit[]): void {
  const patchContent = commits.map((c) => c.diff).join('\n');
  if (/^diff --git.*\.git\/hooks\//m.test(patchContent)) {
    throw new Error(
      '[orchestrator] Patch rejected: contains changes to .git/hooks/. ' +
        'This is a security violation — the agent attempted to install a git hook on the host.',
    );
  }
}

export interface PushHostApplyBranchOpts {
  cwd: string;
  projectDir: string;
  branchName: string;
  feature: Feature;
  /** Run id (for PR footer). */
  runId: string;
  /** File path passed to the PR summarizer (unified diff). */
  patchFile: string;
  push: string | null;
  pr: boolean;
  gitProvider: GitProvider;
  llm: LlmOverrides;
  /** Forwarded to `git push` (e.g. GIT_* author vars). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Push `branchName` from the given repo (`cwd`) and optionally open a PR.
 * Used after the branch exists on the host repo (e.g. after host apply or `run apply`).
 */
export async function pushHostApplyBranch(opts: PushHostApplyBranchOpts): Promise<void> {
  const {
    cwd,
    projectDir,
    branchName,
    feature,
    runId,
    patchFile,
    push,
    pr,
    gitProvider,
    llm,
    env,
  } = opts;

  let baseBranch = 'main';
  try {
    const current = await gitBranchShowCurrent({ cwd: projectDir });
    baseBranch = current || 'main';
  } catch {
    // fall back to 'main'
  }

  if (push) {
    const pushUrl = await gitProvider.resolvePushUrl(push, projectDir);
    consola.log(`[orchestrator] Pushing ${branchName} to remote...`);
    await gitPush({ cwd, env, remote: pushUrl, branch: branchName });
    consola.log(`[orchestrator] Branch ${branchName} pushed.`);

    // Create a PR if requested
    if (pr) {
      const repoSlug = await gitProvider.extractRepoSlug(push, projectDir);

      // Generate AI title + body; fall back to generic strings on any error.
      let prTitle = `feat(${feature.name}): auto-generated implementation`;
      let prBody = `Automated implementation produced by the [SaifCTL](https://github.com/safe-ai-factory/saifctl) for feature \`${feature.name}\`.\n\nRun ID: \`${runId}\``;
      try {
        consola.log(`[orchestrator] Generating AI PR summary for ${feature.name}...`);
        const summary = await generatePRSummary({
          feature,
          patchFile,
          llm,
        });
        prTitle = summary.title;
        prBody = summary.body + `\n\n---\n_Run ID: \`${runId}\`_`;
        consola.log(`[orchestrator] AI PR title: ${prTitle}`);
      } catch (err) {
        consola.warn(
          `[orchestrator] PR summarizer failed (using generic title/body): ${String(err)}`,
        );
      }

      // Actually create the PR
      consola.log(`[orchestrator] Creating Pull Request on ${repoSlug}...`);
      const prUrl = await gitProvider.createPullRequest({
        repoSlug,
        head: branchName,
        base: baseBranch,
        title: prTitle,
        body: prBody,
      });
      consola.log(`[orchestrator] Pull Request created: ${prUrl}`);
    }
  } else {
    consola.log(
      `[orchestrator] Branch "${branchName}" is ready locally. ` +
        `Use --push <target> to push it upstream.`,
    );
  }
}

export interface ApplyPatchOpts {
  /** Absolute path to the sandbox code directory (sandboxBasePath/code) */
  codePath: string;
  /** Absolute path to the project directory */
  projectDir: string;
  feature: Feature;
  /**
   * Persisted sandbox / storage run id (used in the default branch name).
   */
  runId: string;
  /** Run commits to apply on the host worktree (same source as run-commits.json). */
  commits: RunCommit[];
  /**
   * Path to host-base.patch (sandboxBasePath/host-base.patch).
   *
   * Applied to the worktree *before* the agent's patch so the worktree's base state
   * matches the exact host state captured when the sandbox was created. This ensures
   * the agent's patch applies cleanly even if the user switched branches or made
   * further working-tree changes while the agent was running.
   *
   * When the file is empty (host was clean at sandbox creation time) this step is skipped.
   */
  hostBasePatchPath: string;
  /** Remote push target (URL, owner/repo slug, or named remote). Optional. */
  push: string | null;
  /** When true, open a Pull Request after pushing. Requires push + provider token env var. */
  pr: boolean;
  /** Git hosting provider. Default: GitHubProvider. */
  gitProvider: GitProvider;
  /** Effective LLM config forwarded to the PR summarizer agent. */
  llm: LlmOverrides;
  /** When true, verbose logs are enabled. */
  verbose?: boolean;
  /** Target branch name (`--branch`); when null/undefined, use default `saifctl/...-<diffHash>`. */
  targetBranch?: string | null;
  /**
   * When set, `git worktree add` starts the new branch at this commit instead of `HEAD`.
   * Should match the run's captured {@link RunArtifact#baseCommitSha} when available.
   */
  startCommit?: string;
}

/**
 * Applies the winning patch to the host repository using a git worktree so that
 * the main working tree's checked-out branch is never modified — safe for parallel runs.
 *
 * Flow:
 *   1. Create a temporary worktree at <sandboxBasePath>/worktree on branch saifctl/<feature>-<runId>-<diffHash>
 *   2. Apply each run commit inside the worktree
 *   3. Optionally push the branch to the remote target
 *   4. Optionally open a Pull Request via the configured git provider
 *   5. Remove the worktree (branch remains in the main repo's git history)
 *
 * The worktree lives inside sandboxBasePath so it is cleaned up by destroySandbox after
 * this function returns. The worktree must be deregistered (step 6) before the directory
 * is deleted, otherwise git's internal worktree registry gets stale entries.
 */
export async function applyPatchToHost(opts: ApplyPatchOpts): Promise<void> {
  const {
    codePath,
    projectDir,
    feature,
    runId,
    commits,
    hostBasePatchPath,
    push,
    pr,
    gitProvider,
    llm,
    verbose,
    targetBranch,
    startCommit,
  } = opts;

  // patch.diff is written to sandboxBasePath (parent of codePath) by extractPatch,
  // deliberately outside the git working tree so `git clean -fd` cannot delete it.
  const sandboxBasePath = join(codePath, '..');

  if (!Array.isArray(commits) || commits.length === 0) {
    consola.warn('[orchestrator] No run commits; skipping host apply');
    return;
  }

  assertRunCommitsSafeForHost(commits);

  const patchContent = commits.map((c) => c.diff).join('\n');
  const patchFile = join(sandboxBasePath, 'patch.diff');
  await writeUtf8(patchFile, patchContent.endsWith('\n') ? patchContent : `${patchContent}\n`);

  const branchName = resolveHostApplyBranchName({
    featureName: feature.name,
    runId,
    commits,
    targetBranch: targetBranch ?? null,
  });
  const wtPath = join(sandboxBasePath, 'worktree');

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'saifctl',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'saifctl@safeaifactory.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'saifctl',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'saifctl@safeaifactory.com',
  };

  consola.log(`[orchestrator] Creating worktree at ${wtPath} on branch ${branchName}...`);

  // 1. Create worktree + branch — main worktree HEAD is never touched
  await gitWorktreeAdd({
    cwd: projectDir,
    path: wtPath,
    branch: branchName,
    startCommit,
    env: gitEnv,
  });

  try {
    // 2a. Re-apply any uncommitted host changes that existed when the sandbox was created.
    //     This brings the worktree's base state in sync with the sandbox's base state so the
    //     agent's patch (which was diffed against the sandbox snapshot) applies cleanly.
    const hostBasePatch = await readUtf8(hostBasePatchPath);
    if (hostBasePatch.trim()) {
      consola.log('[orchestrator] Applying host-base.patch to worktree...');
      await gitApply({ cwd: wtPath, env: gitEnv, patchFile: hostBasePatchPath });
    }

    // 2b. Apply each run commit (preserves messages / authors from storage)
    for (const commit of commits) {
      if (!commit.diff.trim()) continue;
      const tmpPatch = join(sandboxBasePath, '.saifctl-host-commit.patch');
      const safe = commit.diff.endsWith('\n') ? commit.diff : `${commit.diff}\n`;
      await writeUtf8(tmpPatch, safe);
      await gitApply({ cwd: wtPath, env: gitEnv, patchFile: tmpPatch });
      await unlink(tmpPatch).catch(() => {});
      await gitAdd({ cwd: wtPath, env: gitEnv });
      await gitCommit({
        cwd: wtPath,
        env: gitEnv,
        message: commit.message,
        author: resolveRunCommitAuthor(commit),
        verbose,
      });
    }
    consola.log(`[orchestrator] Committed ${commits.length} run commit(s) on branch ${branchName}`);

    // 3. Push and optionally open a PR
    await pushHostApplyBranch({
      cwd: wtPath,
      projectDir,
      branchName,
      feature,
      runId,
      patchFile,
      push,
      pr,
      gitProvider,
      llm,
      env: gitEnv,
    });
  } finally {
    // 4. Deregister the worktree from git's registry before destroySandbox deletes the dir
    try {
      await gitWorktreeRemove({ cwd: projectDir, path: wtPath });
    } catch (err) {
      // If the directory is already gone somehow, prune stale entries
      try {
        await gitWorktreePrune({ cwd: projectDir });
      } catch {
        // best-effort
      }
      consola.warn(`[orchestrator] git worktree remove warning: ${String(err)}`);
    }
  }
}
