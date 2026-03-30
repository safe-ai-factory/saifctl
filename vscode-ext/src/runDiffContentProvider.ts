/**
 * Virtual documents for vscode.diff: full file before vs after the run.
 *
 * 1. Read file at {@link baseCommitSha} from the real repo (`git show`).
 * 2. Apply this file's slice of {@link basePatchDiff} in a temp git repo.
 * 3. That content is the left side (workspace state when the run started, incl. dirty).
 * 4. Apply each run commit's patch for this file in order → right side.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { logger } from './logger';
import type { DiffFileStat } from './runDiffParser';
import { spawnUserCmdCapture } from './userCmdCapture.js';

/** Safe single-token quoting for `git show` / `git apply` arguments passed through the shell. */
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_/@.:+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** True if any of the patch slices is a Git binary diff (no line-by-line reconstruction). */
function hasBinaryMarker(text: string): boolean {
  return text.includes('Binary files ');
}

/**
 * Read blob text from the real repo at `commitSha:path`, trying each relative path in order
 * (e.g. rename source then target). Returns null if the commit is missing or no path resolves.
 */
async function gitShowAtCommit(opts: {
  repoRoot: string;
  commitSha: string;
  tryPaths: string[];
}): Promise<{ content: string; usedPath: string } | null> {
  const { repoRoot, commitSha, tryPaths } = opts;
  if (!commitSha.trim()) return null;

  for (const rel of tryPaths) {
    const ref = `${commitSha}:${rel}`;
    try {
      const out = await spawnUserCmdCapture(`git show ${shellEscape(ref)}`, { cwd: repoRoot });
      return { content: out, usedPath: rel };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read UTF-8 from the temp worktree for this file, preferring `stat.path` then `fromPath` (renames).
 */
async function readWorktreeFile(tmpDir: string, stat: DiffFileStat): Promise<string> {
  const candidates = stat.fromPath ? [stat.path, stat.fromPath] : [stat.path];
  const uniq = [...new Set(candidates)];
  for (const p of uniq) {
    try {
      return await fs.promises.readFile(path.join(tmpDir, p), 'utf8');
    } catch {
      continue;
    }
  }
  return '';
}

/**
 * Write one patch file, `git apply` it in `tmpDir`, then commit so the next apply is not blocked
 * by untracked files (e.g. consecutive `new file` hunks for the same path).
 */
async function gitApplyInRepo(opts: {
  tmpDir: string;
  patchBody: string;
  label: string;
}): Promise<void> {
  const { tmpDir, patchBody, label } = opts;
  const trimmed = patchBody.trim();
  if (!trimmed) return;
  const patchFile = path.join(tmpDir, `apply-${label}.patch`);
  const body = patchBody.endsWith('\n') ? patchBody : `${patchBody}\n`;
  await fs.promises.writeFile(patchFile, body, 'utf8');
  await spawnUserCmdCapture(`git apply --whitespace=nowarn ${shellEscape(patchFile)}`, {
    cwd: tmpDir,
  });
  // Commit after each apply so the next patch has a clean working tree to apply against.
  await spawnUserCmdCapture('git add -A', { cwd: tmpDir });
  await spawnUserCmdCapture(`git commit -m ${shellEscape(label)}`, { cwd: tmpDir });
}

/** Fresh `git init` in `tmpDir` with a local identity (required before any commit). */
async function initTempRepo(tmpDir: string): Promise<void> {
  await spawnUserCmdCapture('git init', { cwd: tmpDir });
  await spawnUserCmdCapture('git config user.email "saifctl@localhost"', { cwd: tmpDir });
  await spawnUserCmdCapture('git config user.name "saifctl"', { cwd: tmpDir });
}

/**
 * Create the first commit in the temp repo: either an empty tree (new file at run start)
 * or the blob from `git show` at `usedPath`.
 */
async function seedTempRepo(opts: {
  tmpDir: string;
  /** null = file did not exist at baseCommitSha (new file); don't pre-create it. */
  shown: { content: string; usedPath: string } | null;
}): Promise<void> {
  const { tmpDir, shown } = opts;
  await initTempRepo(tmpDir);
  if (shown === null) {
    // New file: nothing to seed, initial commit must be empty so git apply can create it.
    await spawnUserCmdCapture('git commit --allow-empty -m "seed-empty"', { cwd: tmpDir });
    return;
  }
  const full = path.join(tmpDir, shown.usedPath);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, shown.content, 'utf8');
  await spawnUserCmdCapture('git add -A', { cwd: tmpDir });
  await spawnUserCmdCapture('git commit -m "seed"', { cwd: tmpDir });
}

/**
 * Reconstruct full-file **before** (base commit + `basePatchDiff` for this path) and **after**
 * (plus each run commit’s hunk for this path) using a disposable temp Git repo. On failure,
 * returns placeholder `// …` strings for the diff editor.
 */
export async function fullFileSidesFromGit(opts: {
  projectPath: string;
  baseCommitSha: string;
  basePatchSection: string;
  runCommitSections: string[];
  stat: DiffFileStat;
}): Promise<{ before: string; after: string }> {
  const { projectPath, baseCommitSha, basePatchSection, runCommitSections, stat } = opts;

  // Any slice may be a binary diff — skip git apply and show a short message in both panes.
  const patchBlob = stat.section + basePatchSection + runCommitSections.join('');
  if (hasBinaryMarker(patchBlob)) {
    const msg = 'Binary file (no text preview)\n';
    return { before: msg, after: msg };
  }

  // Order matters for `git show`: prefer rename source (`fromPath`) then final path.
  const tryPaths = [...new Set([stat.fromPath, stat.path].filter(Boolean) as string[])];
  if (tryPaths.length === 0) {
    return { before: '', after: '' };
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'saifctl-diff-'));

  try {
    // Resolve starting blob from the user’s real checkout; `shown === null` ⇒ new file.
    const shown = await gitShowAtCommit({
      repoRoot: projectPath,
      commitSha: baseCommitSha,
      tryPaths,
    });

    await seedTempRepo({ tmpDir, shown });

    // Dirty workspace at run start (`--includeDirty` / basePatchDiff).
    try {
      await gitApplyInRepo({ tmpDir, patchBody: basePatchSection, label: 'basePatch' });
    } catch (e) {
      logger.warn(`git apply basePatch failed for ${stat.path}: ${String(e)}`);
      return {
        before: `// Could not apply basePatchDiff for ${stat.path}\n// ${String(e)}\n`,
        after: '',
      };
    }

    // Left side of vscode.diff: state when the run started (including local edits).
    const before = await readWorktreeFile(tmpDir, stat);

    let after = before;
    // Right side: apply sandbox commits in order; re-read after each successful apply.
    for (let i = 0; i < runCommitSections.length; i += 1) {
      const sec = runCommitSections[i] ?? '';
      if (!sec.trim()) continue;
      try {
        await gitApplyInRepo({ tmpDir, patchBody: sec, label: `commit-${i}` });
      } catch (e) {
        logger.warn(`git apply run commit ${i} failed for ${stat.path}: ${String(e)}`);
        return {
          before,
          after: `// Could not apply run commit ${i + 1} for ${stat.path}\n// ${String(e)}\n`,
        };
      }
      after = await readWorktreeFile(tmpDir, stat);
    }

    return { before, after };
  } finally {
    // Temp repo is only for apply; never leave it on disk (paths may contain user data).
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Stable map key for `prepareSides` / `provideTextDocumentContent` (per run, path, and side). */
function diffCacheKey(opts: { runId: string; filePath: string; side: string }): string {
  return `${opts.runId}::${opts.filePath}::${opts.side}`;
}

/**
 * Serves `saifctl-diff:` document URIs for {@link vscode.diff}. Content is filled by
 * {@link prepareSides}; {@link provideTextDocumentContent} is synchronous and read-only.
 */
export class RunDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contentCache = new Map<string, string>();

  /**
   * Run `fullFileSidesFromGit` once and store both strings; must complete before `vscode.diff`
   * opens so both virtual documents resolve immediately.
   */
  async prepareSides(opts: {
    runId: string;
    projectPath: string;
    baseCommitSha: string;
    basePatchSection: string;
    runCommitSections: string[];
    stat: DiffFileStat;
  }): Promise<void> {
    const { runId, stat } = opts;
    const baseKey = diffCacheKey({ runId, filePath: stat.path, side: 'base' });
    const changedKey = diffCacheKey({ runId, filePath: stat.path, side: 'changed' });
    if (this.contentCache.has(baseKey) && this.contentCache.has(changedKey)) return;

    const { before, after } = await fullFileSidesFromGit({
      projectPath: opts.projectPath,
      baseCommitSha: opts.baseCommitSha,
      basePatchSection: opts.basePatchSection,
      runCommitSections: opts.runCommitSections,
      stat: opts.stat,
    });
    this.contentCache.set(baseKey, before);
    this.contentCache.set(changedKey, after);
  }

  /** VS Code calls this when rendering a `saifctl-diff:` URI; returns cached text or empty. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const runId = uri.authority;
    const filePath = decodeURIComponent(uri.path.replace(/^\//, ''));
    const params = new URLSearchParams(uri.query);
    const side = params.get('side') === 'changed' ? 'changed' : 'base';
    return this.contentCache.get(diffCacheKey({ runId, filePath, side })) ?? '';
  }
}

/** Build the virtual URI passed to `vscode.diff` (authority = run id, path = encoded file path). */
export function runDiffUri(opts: {
  runId: string;
  filePath: string;
  side: 'base' | 'changed';
}): vscode.Uri {
  const enc = encodeURIComponent(opts.filePath);
  return vscode.Uri.from({
    scheme: 'saifctl-diff',
    authority: opts.runId,
    path: `/${enc}`,
    query: `side=${opts.side}`,
  });
}
