import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunCommit } from '../runs/types.js';
import { git, gitAdd, gitApply, gitCommit } from '../utils/git.js';
import { writeUtf8 } from '../utils/io.js';

/** Default `Name <email>` author string used for saifctl-authored commits when {@link RunCommit.author} is unset. */
export const SAIFCTL_DEFAULT_AUTHOR = 'saifctl <saifctl@safeaifactory.com>';

/** Returns the commit's explicit author or {@link SAIFCTL_DEFAULT_AUTHOR}. */
export function resolveRunCommitAuthor(commit: RunCommit): string {
  return commit.author?.trim() || SAIFCTL_DEFAULT_AUTHOR;
}

/**
 * Applies one run commit's unified diff, stages (excluding `.saifctl/`), and commits with message + author.
 */
export async function applyRunCommitInRepo(opts: {
  cwd: string;
  commit: RunCommit;
  gitEnv?: NodeJS.ProcessEnv;
  verbose?: boolean;
}): Promise<void> {
  const { cwd, commit, gitEnv = process.env, verbose = false } = opts;
  if (!commit.diff.trim()) return;

  const tmpPath = join(cwd, '.saifctl-commit.patch');
  const safeDiff = commit.diff.endsWith('\n') ? commit.diff : `${commit.diff}\n`;
  await writeUtf8(tmpPath, safeDiff);
  await gitApply({ cwd, env: gitEnv, patchFile: tmpPath });
  await unlink(tmpPath).catch(() => {});

  await gitAdd({ cwd, env: gitEnv });
  try {
    await git({ cwd, env: gitEnv, args: ['reset', 'HEAD', '--', '.saifctl'] });
  } catch {
    /* .saifctl may be absent */
  }

  const stagedOut = (
    await git({ cwd, env: gitEnv, args: ['diff', '--cached', '--name-only'] })
  ).trim();
  if (!stagedOut) return;

  await gitCommit({
    cwd,
    env: gitEnv,
    message: commit.message,
    author: resolveRunCommitAuthor(commit),
    verbose,
  });
}

/**
 * Applies each run commit in order (incremental diffs on top of the current tree).
 */
export async function replayRunCommits(opts: {
  cwd: string;
  commits: RunCommit[];
  gitEnv?: NodeJS.ProcessEnv;
  verbose?: boolean;
}): Promise<void> {
  const { cwd, commits, gitEnv = process.env, verbose = false } = opts;
  for (const commit of commits) {
    await applyRunCommitInRepo({ cwd, commit, gitEnv, verbose });
  }
}
