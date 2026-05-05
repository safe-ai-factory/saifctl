import type { StdioOptions } from 'node:child_process';

import { spawnAsync, spawnCapture } from './io.js';

const GIT = 'git';

/** Options for {@link git}: arbitrary `git` invocation captured to stdout. */
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

/** Options for {@link gitAdd} — `git add -- <paths>`. */
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
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['add', '--', ...paths],
  });
}

/** Options for {@link gitApply} — `git apply -- <patchFile>`. */
export interface GitApplyOpts {
  cwd: string;
  /** Path to a unified diff file (absolute or relative to `cwd`). */
  patchFile: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git apply` for a patch file. Uses `--` so the path is never parsed as a flag. */
export async function gitApply(opts: GitApplyOpts): Promise<void> {
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['apply', '--', opts.patchFile],
  });
}

/** Options for {@link gitBranchDelete} — `git branch -d` (or `-D` when `force`). */
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
    stdio: opts.stdio ?? 'inherit',
    args: ['branch', flag, opts.branch],
  });
}

/** Options for {@link gitBranchShowCurrent} — `git branch --show-current`. */
export interface GitBranchShowCurrentOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Current branch name from `git branch --show-current` (trimmed; may be empty in detached HEAD). */
export async function gitBranchShowCurrent(opts: GitBranchShowCurrentOpts): Promise<string> {
  return (await spawnCapture({ command: GIT, ...opts, args: ['branch', '--show-current'] })).trim();
}

/** Options for {@link gitClean} — `git clean -fd`. */
export interface GitCleanOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git clean -fd` (untracked files and directories). */
export async function gitClean(opts: GitCleanOpts): Promise<void> {
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['clean', '-fd'],
  });
}

/** Options for {@link gitCommit} — `git commit -m <message>` (with optional `--author` and `-q`). */
export interface GitCommitOpts {
  cwd: string;
  message: string;
  env?: NodeJS.ProcessEnv;
  /**
   * `git commit --author=...` (e.g. `Name <email>`). When omitted, git uses env author/committer.
   */
  author?: string;
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
  if (opts.author?.trim()) {
    args.push('--author', opts.author.trim());
  }
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args,
  });
}

/** Options for {@link gitDiff} — `git diff [--staged] [...args]`. */
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

/** Options for {@link gitInit} — `git init` in `cwd`. */
export interface GitInitOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git init` in `cwd`. */
export async function gitInit(opts: GitInitOpts): Promise<void> {
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['init'],
  });
}

/** Options for {@link gitPush} — `git push <remote> <branch>`. */
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
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['push', opts.remote, opts.branch],
  });
}

/** Options for {@link gitRemoteGetUrl} — `git remote get-url <remote>`. */
export interface GitRemoteGetUrlOpts {
  cwd: string;
  /** Named remote (e.g. `origin`). */
  remote: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolves `git remote get-url <remote>` (trimmed). Rejects if git fails. */
export async function gitRemoteGetUrl(opts: GitRemoteGetUrlOpts): Promise<string> {
  const out = await spawnCapture({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    args: ['remote', 'get-url', opts.remote],
  });
  return out.trim();
}

/** Options for {@link gitResetHard} — `git reset --hard <ref>` (defaults to `HEAD`). */
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
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['reset', '--hard', ref],
  });
}

/** Options for {@link gitWorktreeAdd} — `git worktree add -b <branch> <path> [startCommit]`. */
export interface GitWorktreeAddOpts {
  /** Main repository (the worktree is registered here). */
  cwd: string;
  /** Filesystem path for the new linked worktree. */
  path: string;
  /** New branch name (`git worktree add -b …`). */
  branch: string;
  /**
   * Start the new branch at this commit/ref. When omitted, Git uses the current `HEAD`
   * of `cwd` (same as `git worktree add -b <branch> <path>` with no extra arg).
   */
  startCommit?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree add` with `-b` for a new branch. */
export async function gitWorktreeAdd(opts: GitWorktreeAddOpts): Promise<void> {
  // Synopsis: git worktree add [(-b | -B) <new-branch>] <path> [<commit-ish>]
  const args = ['worktree', 'add', '-b', opts.branch, opts.path];
  if (opts.startCommit) {
    args.push(opts.startCommit);
  }
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args,
  });
}

/** Options for {@link gitWorktreeRemove} — `git worktree remove --force <path>`. */
export interface GitWorktreeRemoveOpts {
  cwd: string;
  /** Path of the worktree directory to remove. */
  path: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree remove --force` for `path`. */
export async function gitWorktreeRemove(opts: GitWorktreeRemoveOpts): Promise<void> {
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['worktree', 'remove', '--force', opts.path],
  });
}

/** Options for {@link gitWorktreePrune} — `git worktree prune`. */
export interface GitWorktreePruneOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Run `git worktree prune`. */
export async function gitWorktreePrune(opts: GitWorktreePruneOpts): Promise<void> {
  await spawnAsync({
    command: GIT,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'inherit',
    args: ['worktree', 'prune'],
  });
}
