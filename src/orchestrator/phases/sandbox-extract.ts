/**
 * Apply sandbox run commits to the host working tree (git apply), used by
 * `skipStagingTests` / `saifctl sandbox` and the POC designer.
 */

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { consola } from '../../logger.js';
import type { RunCommit } from '../../runs/types.js';
import { git } from '../../utils/git.js';
import { writeUtf8 } from '../../utils/io.js';
import { assertRunCommitsSafeForHost } from './apply-patch.js';

export type SandboxExtractMode = 'none' | 'host-apply' | 'host-apply-filtered';

export interface FilterUnifiedDiffByPrefixOpts {
  patch: string;
  /** Repo-relative prefix to keep (e.g. `saifctl/features/`). */
  includePrefix: string;
  /** Repo-relative prefix to drop; optional. */
  excludePrefix?: string;
}

/**
 * Keeps unified-diff file sections that touch `includePrefix` on the host,
 * excluding paths under `excludePrefix` when set.
 */
export function filterUnifiedDiffByPrefix(opts: FilterUnifiedDiffByPrefixOpts): string {
  const { patch, includePrefix, excludePrefix } = opts;
  const sections = patch.split(/(?=^diff --git )/m);
  const kept: string[] = [];

  for (const section of sections) {
    const headerLine = section.split('\n')[0] ?? '';
    if (!headerLine.startsWith('diff --git ')) {
      if (section.trim()) kept.push(section);
      continue;
    }
    if (
      sectionTouchesIncludeExclude({
        line: headerLine,
        includePrefix,
        excludePrefix: excludePrefix?.trim() ? excludePrefix : undefined,
      })
    ) {
      kept.push(section);
    }
  }

  return kept.join('');
}

function sectionTouchesIncludeExclude(spec: {
  line: string;
  includePrefix: string;
  excludePrefix?: string;
}): boolean {
  const paths = parseDiffGitHeaderPaths(spec.line);
  if (paths.length === 0) return false;

  for (const p of paths) {
    if (!p.startsWith(spec.includePrefix)) continue;
    if (spec.excludePrefix && p.startsWith(spec.excludePrefix)) continue;
    return true;
  }
  return false;
}

/** Paths from a single `diff --git ...` line (both sides when present). */
function parseDiffGitHeaderPaths(line: string): string[] {
  const trimmed = line.trim();
  const newFile = /^diff --git a\/dev\/null b\/(.+)$/.exec(trimmed);
  if (newFile) return [newFile[1]];

  const deleted = /^diff --git a\/(.+?) b\/dev\/null$/.exec(trimmed);
  if (deleted) return [deleted[1]];

  const ab = /^diff --git a\/(.+?) b\/(.+)$/.exec(trimmed);
  if (ab) {
    const [, aPath, bPath] = ab;
    if (aPath === 'dev/null' && bPath !== 'dev/null') return [bPath];
    if (bPath === 'dev/null' && aPath !== 'dev/null') return [aPath];
    if (aPath !== 'dev/null' && bPath !== 'dev/null') return [aPath, bPath];
  }

  return [];
}

export interface ApplySandboxExtractToHostOpts {
  runCommits: RunCommit[];
  projectDir: string;
  runId: string;
  mode: 'host-apply' | 'host-apply-filtered';
  /** Required when mode is `host-apply-filtered`. */
  includePrefix?: string;
  excludePrefix?: string;
}

/**
 * Writes patch to a temp file, runs `git apply`, then removes the file (best-effort).
 *
 * @returns `true` when the host is in sync with the given commits for extract purposes (applied,
 *   nothing to apply, or filtered diff empty). `false` only when `git apply` fails.
 */
export async function applySandboxExtractToHost(
  opts: ApplySandboxExtractToHostOpts,
): Promise<boolean> {
  const { runCommits, projectDir, runId, mode, includePrefix, excludePrefix } = opts;

  if (runCommits.length === 0) {
    consola.warn('[sandbox] No commits to extract — nothing to apply to host.');
    return true;
  }

  assertRunCommitsSafeForHost(runCommits);

  const fullDiff = runCommits.map((c) => c.diff).join('\n');

  let diff: string;
  if (mode === 'host-apply-filtered') {
    const inc = includePrefix?.trim();
    if (!inc) {
      throw new Error('[sandbox] sandboxExtractInclude is required for host-apply-filtered mode.');
    }
    diff = filterUnifiedDiffByPrefix({
      patch: fullDiff,
      includePrefix: inc,
      excludePrefix: excludePrefix?.trim() || undefined,
    });
    if (!diff.trim()) {
      consola.warn(`[sandbox] No changes under "${inc}" — nothing to apply.`);
      return true;
    }
  } else {
    diff = fullDiff;
  }

  const patchPath = join(projectDir, `.saifctl-sandbox-${runId}.patch`);
  try {
    const normalized = diff.endsWith('\n') ? diff : `${diff}\n`;
    await writeUtf8(patchPath, normalized);
    consola.log('[sandbox] Applying extracted changes to host working tree…');
    await git({
      cwd: projectDir,
      args: ['apply', '--allow-empty', patchPath],
    });
    consola.log('[sandbox] Host working tree updated.');
  } catch (err) {
    consola.error('[sandbox] Failed to apply patch to host:', err);
    consola.warn(`[sandbox] Raw patch written to: ${patchPath} — apply manually.`);
    return false;
  }

  try {
    await unlink(patchPath);
  } catch {
    // best-effort
  }
  return true;
}
