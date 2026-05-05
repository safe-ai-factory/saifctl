/**
 * Findings-file lifecycle helpers for the critic discover/fix split (Block 4b).
 *
 * The discover step writes a markdown checklist of issues to a path under
 * `/workspace/.saifctl/critic-findings/<phase>--<critic>--r<round>.md`; the
 * matching fix step reads + applies and the orchestrator removes the file on
 * a successful fix gate. Path construction lives in `compile.ts`
 * (`buildFindingsPath`); this module owns the runtime side-effects:
 *
 * - {@link ensureCriticFindingsParentDir} — `mkdir -p` the parent dir before
 *   discover is activated, so an agent that does `cat > path` (no implicit
 *   `mkdir`) can still write the file.
 * - {@link cleanupFindingsForFixRow} — `rm -f` after a fix subtask passes
 *   its gate. **Saifctl owns this lifecycle, not the fix prompt** — earlier
 *   drafts had the BUILTIN_FIX_TEMPLATE delete the file as a step before
 *   verifying tests, which caused silent data loss: a test-failure-then-
 *   reset path wiped the findings before the retry could re-read them, and
 *   the next attempt no-op'd while the implementer's bugs stayed unfixed.
 *   See the BUILTIN_FIX_TEMPLATE docstring in `critic-prompt.ts`.
 *
 * Both helpers are best-effort: they swallow filesystem errors with a `null`
 * return so a stale-file or missing-dir hiccup never fails the run. The
 * caller can inspect the return to log if useful.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RunSubtask } from '../../runs/types.js';

/** Sentinel returned when a row doesn't carry a findings path or it isn't workspace-rooted. */
export type CriticFindingsAction = { kind: 'skipped' } | { kind: 'ok'; hostPath: string };

/** Container `/workspace/...` prefix — paths emitted by the compiler always start with this. */
const WORKSPACE_PREFIX = '/workspace/';

/**
 * Translate the container-side findings path (e.g.
 * `/workspace/.saifctl/critic-findings/01-core--strict--r1.md`) into a
 * host-side path under the sandbox bind-mount. Returns `null` when the row
 * has no findings path, isn't a critic subtask, or carries a path that
 * doesn't start with `/workspace/` (defensive — should never happen with
 * the compiler we ship, but a manually edited subtasks.json could).
 */
export function findingsHostPath(opts: { codePath: string; row: RunSubtask }): string | null {
  const containerPath = opts.row.criticPrompt?.findingsPath;
  if (!containerPath) return null;
  if (!containerPath.startsWith(WORKSPACE_PREFIX)) return null;
  return join(opts.codePath, containerPath.slice(WORKSPACE_PREFIX.length));
}

/**
 * `mkdir -p` the parent directory of the row's findings file. No-op for
 * rows without a findings path. Idempotent — safe to call on every critic
 * subtask activation, including discover and fix.
 *
 * @returns `{ kind: 'skipped' }` if the row has no findings path / isn't a
 *   critic; `{ kind: 'ok', hostPath }` after a successful mkdir.
 */
export async function ensureCriticFindingsParentDir(opts: {
  codePath: string;
  row: RunSubtask;
}): Promise<CriticFindingsAction> {
  const hostPath = findingsHostPath(opts);
  if (hostPath === null) return { kind: 'skipped' };
  await mkdir(dirname(hostPath), { recursive: true });
  return { kind: 'ok', hostPath };
}

/**
 * Best-effort delete the findings file when `row` is a `fix` subtask that
 * just succeeded. No-op for any other shape (discover rows, impl rows,
 * non-critic rows, missing path).
 *
 * Uses `rm -f`-style semantics — a missing file is not an error. Other I/O
 * failures (permission, etc.) are swallowed so the run doesn't fail on a
 * cleanup hiccup; the caller can read the returned `error` if it cares.
 */
export async function cleanupFindingsForFixRow(opts: {
  codePath: string;
  row: RunSubtask;
}): Promise<CriticFindingsAction & { error?: Error }> {
  if (opts.row.criticPrompt?.step !== 'fix') return { kind: 'skipped' };
  const hostPath = findingsHostPath(opts);
  if (hostPath === null) return { kind: 'skipped' };
  try {
    await rm(hostPath, { force: true });
    return { kind: 'ok', hostPath };
  } catch (err) {
    return { kind: 'ok', hostPath, error: err as Error };
  }
}
