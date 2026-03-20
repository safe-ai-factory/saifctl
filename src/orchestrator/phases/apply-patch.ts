/**
 * Phase: apply-patch — apply sandbox patch to host via git worktree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generatePRSummary } from '../../git/agents/pr-summarizer.js';
import type { GitProvider } from '../../git/types.js';
import type { ModelOverrides } from '../../llm-config.js';
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

export type { OrchestratorResult } from '../loop.js';

export interface ApplyPatchOpts {
  /** Absolute path to the sandbox code directory (sandboxBasePath/code) */
  codePath: string;
  /** Absolute path to the project directory */
  projectDir: string;
  feature: Feature;
  /**
   * Unique run id used to construct the branch name (factory/<featureName>-<runId>),
   * ensuring parallel runs for different attempts never collide.
   */
  runId: string;
  /** Remote push target (URL, owner/repo slug, or named remote). Optional. */
  push: string | null;
  /** When true, open a Pull Request after pushing. Requires push + provider token env var. */
  pr: boolean;
  /** Git hosting provider. Default: GitHubProvider. */
  gitProvider: GitProvider;
  /** CLI-level model overrides forwarded to the PR summarizer agent. */
  overrides: ModelOverrides;
  /** When true, verbose logs are enabled. */
  verbose?: boolean;
}

/**
 * Applies the winning patch to the host repository using a git worktree so that
 * the main working tree's checked-out branch is never modified — safe for parallel runs.
 *
 * Flow:
 *   1. Create a temporary worktree at <sandboxBasePath>/worktree on branch factory/<featureName>-<runId>
 *   2. Apply patch.diff and commit inside the worktree
 *   3. Optionally push the branch to the remote target
 *   4. Optionally open a Pull Request via the configured git provider
 *   5. Remove the worktree (branch remains in the main repo's git history)
 *
 * The worktree lives inside sandboxBasePath so it is cleaned up by destroySandbox after
 * this function returns. The worktree must be deregistered (step 6) before the directory
 * is deleted, otherwise git's internal worktree registry gets stale entries.
 */
export async function applyPatchToHost(opts: ApplyPatchOpts): Promise<void> {
  const { codePath, projectDir, feature, runId, push, pr, gitProvider, overrides, verbose } = opts;

  // patch.diff is written to sandboxBasePath (parent of codePath) by extractPatch,
  // deliberately outside the git working tree so `git clean -fd` cannot delete it.
  const sandboxBasePath = join(codePath, '..');
  const patchFile = join(sandboxBasePath, 'patch.diff');

  if (!existsSync(patchFile)) {
    console.warn('[orchestrator] No patch.diff found in sandbox; skipping host apply');
    return;
  }

  // Reject patches that touch .git/hooks/ — a hook injected here would run on the
  // host machine the next time any git operation triggers it.
  const patchContent = readFileSync(patchFile, 'utf8');
  if (/^diff --git.*\.git\/hooks\//m.test(patchContent)) {
    throw new Error(
      '[orchestrator] Patch rejected: contains changes to .git/hooks/. ' +
        'This is a security violation — the agent attempted to install a git hook on the host.',
    );
  }

  const branchName = `factory/${feature.name}-${runId}`;
  const wtPath = join(sandboxBasePath, 'worktree');

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'factory',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'factory@localhost',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'factory',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'factory@localhost',
  };

  // Capture the current branch for the PR base *before* touching anything
  let baseBranch = 'main';
  try {
    const current = await gitBranchShowCurrent({ cwd: projectDir });
    baseBranch = current || 'main';
  } catch {
    // fall back to 'main'
  }

  console.log(`[orchestrator] Creating worktree at ${wtPath} on branch ${branchName}...`);

  // 1. Create worktree + branch — main worktree HEAD is never touched
  await gitWorktreeAdd({ cwd: projectDir, path: wtPath, branch: branchName, env: gitEnv });

  try {
    // 2. Apply patch inside the worktree
    await gitApply({ cwd: wtPath, env: gitEnv, patchFile: patchFile });
    await gitAdd({ cwd: wtPath, env: gitEnv });
    await gitCommit({
      cwd: wtPath,
      env: gitEnv,
      message: `feat(${feature.name}): auto-generated implementation`,
      verbose,
    });
    console.log(`[orchestrator] Committed patch on branch ${branchName}`);

    // 4. Push
    if (push) {
      const pushUrl = gitProvider.resolvePushUrl(push, projectDir);
      console.log(`[orchestrator] Pushing ${branchName} to remote...`);
      await gitPush({ cwd: wtPath, env: gitEnv, remote: pushUrl, branch: branchName });
      console.log(`[orchestrator] Branch ${branchName} pushed.`);

      // 5. Create PR
      if (pr) {
        const repoSlug = gitProvider.extractRepoSlug(push, projectDir);

        // 5a. Generate AI title + body; fall back to generic strings on any error.
        let prTitle = `feat(${feature.name}): auto-generated implementation`;
        let prBody = `Automated implementation produced by the [SAIFAC](https://github.com/JuroOravec/safe-ai-factory) for feature \`${feature.name}\`.\n\nRun ID: \`${runId}\``;
        try {
          console.log(`[orchestrator] Generating AI PR summary for ${feature.name}...`);
          const summary = await generatePRSummary({
            feature,
            patchFile,
            overrides,
          });
          prTitle = summary.title;
          prBody = summary.body + `\n\n---\n_Run ID: \`${runId}\`_`;
          console.log(`[orchestrator] AI PR title: ${prTitle}`);
        } catch (err) {
          console.warn(
            `[orchestrator] PR summarizer failed (using generic title/body): ${String(err)}`,
          );
        }

        console.log(`[orchestrator] Creating Pull Request on ${repoSlug}...`);
        const prUrl = await gitProvider.createPullRequest({
          repoSlug,
          head: branchName,
          base: baseBranch,
          title: prTitle,
          body: prBody,
        });
        console.log(`[orchestrator] Pull Request created: ${prUrl}`);
      }
    } else {
      console.log(
        `[orchestrator] Branch "${branchName}" is ready locally. ` +
          `Use --push <target> to push it upstream.`,
      );
    }
  } finally {
    // 6. Deregister the worktree from git's registry before destroySandbox deletes the dir
    try {
      await gitWorktreeRemove({ cwd: projectDir, path: wtPath });
    } catch (err) {
      // If the directory is already gone somehow, prune stale entries
      try {
        await gitWorktreePrune({ cwd: projectDir });
      } catch {
        // best-effort
      }
      console.warn(`[orchestrator] git worktree remove warning: ${String(err)}`);
    }
  }
}
