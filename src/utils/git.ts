import type { StdioOptions } from 'node:child_process';

import { spawnAsync, spawnCapture } from './io.js';

const GIT = 'git';

export interface GitCommandOpts {
  cwd: string;
  /** Arguments after `git` (e.g. `['rev-parse', 'HEAD']`). */
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Run an arbitrary `git …` command and return stdout as UTF-8.
 * Rejects if git exits with a non-zero status.
 */
export async function git(opts: GitCommandOpts): Promise<string> {
  return spawnCapture({ command: GIT, cwd: opts.cwd, env: opts.env, args: opts.args });
}

export interface GitAddOpts {
  cwd: string;
  /** Paths relative to `cwd`. Default: `['.']` (stage entire tree). */
  paths?: string[];
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/**
 * Run `git add` for the given paths (default: everything under `.`).
 * Uses `--` so paths starting with `-` are not parsed as flags.
 */
export async function gitAdd(opts: GitAddOpts): Promise<void> {
  const paths = opts.paths?.length ? opts.paths : ['.'];
  await spawnAsync({ command: GIT, ...opts, args: ['add', '--', ...paths] });
}

export interface GitApplyOpts {
  cwd: string;
  /** Path to a unified diff file (absolute or relative to `cwd`). */
  patchFile: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git apply` for a patch file. Uses `--` so the path is never parsed as a flag. */
export async function gitApply(opts: GitApplyOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['apply', '--', opts.patchFile] });
}

export interface GitBranchDeleteOpts {
  cwd: string;
  branch: string;
  /**
   * When true, run `git branch -D` (delete even if not merged).
   * When false or omitted, run `git branch -d` (refuses if the branch is not fully merged).
   */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git branch -d` or `git branch -D` depending on `force`. */
export async function gitBranchDelete(opts: GitBranchDeleteOpts): Promise<void> {
  const flag = opts.force === true ? '-D' : '-d';
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio,
    args: ['branch', flag, opts.branch],
  });
}

export interface GitBranchShowCurrentOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Current branch name from `git branch --show-current` (trimmed; may be empty in detached HEAD). */
export async function gitBranchShowCurrent(opts: GitBranchShowCurrentOpts): Promise<string> {
  return (await spawnCapture({ command: GIT, ...opts, args: ['branch', '--show-current'] })).trim();
}

export interface GitCleanOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git clean -fd` (untracked files and directories). */
export async function gitClean(opts: GitCleanOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['clean', '-fd'] });
}

export interface GitCommitOpts {
  cwd: string;
  message: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When true, omit `-q` so git prints per-file summaries.
   * When false or omitted, pass `-q` for quieter output.
   */
  verbose?: boolean;
  stdio?: StdioOptions;
}

/**
 * Run `git commit -m <message>`, optionally with `-q` unless `verbose` is true.
 */
export async function gitCommit(opts: GitCommitOpts): Promise<void> {
  const args = ['commit'];
  if (opts.verbose !== true) {
    args.push('-q');
  }
  args.push('-m', opts.message);
  await spawnAsync({ command: GIT, ...opts, args });
}

export interface GitDiffOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When true, include `--staged` (staged/index changes only).
   */
  staged?: boolean;
  /**
   * Extra arguments after `git diff` / optional `--staged`.
   * - Omit or `[]` — default range (unstaged vs index, or index vs HEAD when `staged` is set).
   * - `['HEAD']` — e.g. `git diff HEAD` (all working-tree changes vs `HEAD` when not using `staged`).
   */
  args?: string[];
}

/** Run `git diff` and return stdout as UTF-8 text. */
export async function gitDiff(opts: GitDiffOpts): Promise<string> {
  const { cwd, env, staged, args: tail = [] } = opts;
  const args = ['diff', ...(staged === true ? ['--staged'] : []), ...tail];
  return spawnCapture({ command: GIT, cwd, env, args });
}

export interface GitInitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git init` in `cwd`. */
export async function gitInit(opts: GitInitOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['init'] });
}

export interface GitPushOpts {
  cwd: string;
  /** Remote URL or remote name (first argument to `git push`). */
  remote: string;
  /** Branch ref to push (second argument). */
  branch: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git push <remote> <branch>`. */
export async function gitPush(opts: GitPushOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['push', opts.remote, opts.branch] });
}

export interface GitResetHardOpts {
  cwd: string;
  /** Commit or ref to reset to. Default: `HEAD`. */
  ref?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git reset --hard <ref>` (default ref: `HEAD`). */
export async function gitResetHard(opts: GitResetHardOpts): Promise<void> {
  const ref = opts.ref ?? 'HEAD';
  await spawnAsync({ command: GIT, ...opts, args: ['reset', '--hard', ref] });
}

export interface GitWorktreeAddOpts {
  /** Main repository (the worktree is registered here). */
  cwd: string;
  /** Filesystem path for the new linked worktree. */
  path: string;
  /** New branch name (`git worktree add -b …`). */
  branch: string;
  /**
   * Start the new branch at this commit/ref. When omitted, Git uses the current `HEAD`
   * of `cwd` (same as `git worktree add <path> -b <branch>` with no extra arg).
   */
  startCommit?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree add` with `-b` for a new branch. */
export async function gitWorktreeAdd(opts: GitWorktreeAddOpts): Promise<void> {
  const args = ['worktree', 'add', opts.path, '-b', opts.branch];
  if (opts.startCommit) {
    args.push(opts.startCommit);
  }
  await spawnAsync({ command: GIT, ...opts, args });
}

export interface GitWorktreeRemoveOpts {
  cwd: string;
  /** Path of the worktree directory to remove. */
  path: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree remove --force` for `path`. */
export async function gitWorktreeRemove(opts: GitWorktreeRemoveOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['worktree', 'remove', '--force', opts.path] });
}

export interface GitWorktreePruneOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree prune`. */
export async function gitWorktreePrune(opts: GitWorktreePruneOpts): Promise<void> {
  await spawnAsync({ command: GIT, ...opts, args: ['worktree', 'prune'] });
}
