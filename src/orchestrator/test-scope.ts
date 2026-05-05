/**
 * Per-subtask test scope resolution + merged-tests-dir synthesis.
 *
 * Background: today's gate runs the feature's whole `tests/` dir against every
 * subtask. Block 2 of TODO_phases_and_critics adds per-subtask scoping so
 * phase N gates on `phases/01..N/tests/` cumulatively (and the last phase
 * also on the feature- and project-level tests). Block 3's compiler emits the
 * `testScope` field on each subtask; this module is the loop-side consumer.
 *
 * Two responsibilities:
 *
 * 1. {@link resolveSubtaskTestScope} — given the subtask list and the active
 *    cursor, walk the cumulative chain and produce the de-duplicated list of
 *    test-source directories that should gate this subtask.
 *
 * 2. {@link synthesizeMergedTestsDir} — given that list, produce a single
 *    "tests dir" path that the existing test runner contract
 *    ({@link RunTestsOpts#testsDir}) can consume. Single-source resolves to
 *    the source path itself (zero-cost short-circuit). Multi-source builds a
 *    fresh self-contained dir under the sandbox by hardlinking (with copy
 *    fallback) every file so the Docker test runner's bind-mount sees a real
 *    `public/`/`hidden/` tree — symlinks would dangle inside the container
 *    because their absolute host targets are not in the test runner's mount
 *    namespace.
 *
 * No legacy behavior change for unscoped runs: when neither the active subtask
 * nor any prior subtask declares `testScope`, `sources` is empty and the loop
 * falls back to the feature's `tests/` dir. When the active subtask omits
 * `testScope` but priors declare it (e.g. a critic compiled without an
 * explicit scope sandwiched between scoped implementer phases), the
 * cumulative chain of priors is used — the active subtask does NOT silently
 * expand to feature-wide tests.
 */

import { copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import type { RunSubtask, RunSubtaskInput } from '../runs/types.js';
import type { TestProfile } from '../test-profiles/index.js';
import { pathExists } from '../utils/io.js';

/** Subset of subtask shape this module needs — accepts both runtime + manifest rows. */
export type SubtaskWithTestScope = Pick<RunSubtask | RunSubtaskInput, 'testScope'>;

/** Result of {@link resolveSubtaskTestScope}: deduplicated per-source `tests/` directories for the active subtask. */
export interface ResolvedSubtaskTestScope {
  /**
   * Absolute paths to per-source `tests/` directories, in walk order.
   * Empty when neither the active subtask nor any prior subtask declares
   * `testScope` (caller falls back to the feature's default tests dir).
   */
  sources: string[];
}

/**
 * Resolve the cumulative include list for the active subtask.
 *
 * - Active subtask with `testScope.cumulative !== false` (default true) ⇒
 *   prepend prior subtasks' `include` paths in subtask order. Subtasks
 *   without `testScope` contribute nothing — they're skipped entirely, not
 *   treated as "the whole feature tests/".
 * - Active subtask with `testScope.cumulative === false` ⇒ start fresh; only
 *   the active subtask's `include` is used.
 * - Active subtask without any `testScope` ⇒ inherit the cumulative chain of
 *   priors (same as `cumulative: true` with no own `include`). Falls back to
 *   the legacy feature-wide tests dir only when no prior is scoped either.
 *
 * Duplicate paths are de-duplicated, first occurrence wins.
 */
export function resolveSubtaskTestScope(opts: {
  subtasks: readonly SubtaskWithTestScope[];
  currentSubtaskIndex: number;
}): ResolvedSubtaskTestScope {
  const active = opts.subtasks[opts.currentSubtaskIndex];

  // `cumulative` is per-subtask; an absent `testScope` is treated as
  // `cumulative: true` so unscoped sandwich subtasks (e.g. a critic) inherit
  // the surrounding phases' scope rather than escalating to feature-wide.
  const cumulative = active?.testScope?.cumulative !== false;

  const accumulator: string[] = [];
  if (cumulative) {
    for (let i = 0; i < opts.currentSubtaskIndex; i++) {
      const prior = opts.subtasks[i];
      if (prior?.testScope?.include) accumulator.push(...prior.testScope.include);
    }
  }
  if (active?.testScope?.include) accumulator.push(...active.testScope.include);

  const seen = new Set<string>();
  const sources = accumulator.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  return { sources };
}

/**
 * Build a self-contained merged tests/ directory composed of hardlinks (with
 * copy fallback) back to `sources`.
 *
 * Layout produced (label-rooted, per-source isolation):
 *
 *   <destDir>/
 *     <source-label>/
 *       public/<file>                 ← hardlink/copy of <source>/public/<file>
 *       hidden/<file>                 ← hardlink/copy of <source>/hidden/<file>
 *       <profile.helpersFilename>     ← hardlink/copy of <source>/<helpers>
 *       <profile.infraFilename>       ← (when set) hardlink/copy of <source>/<infra>
 *       <profile.exampleFilename>     ← hardlink/copy of <source>/<example>
 *
 * The set of top-level files is driven by `testProfile` so non-vitest profiles
 * (python: helpers.py + test_infra.py + test_example.py; go: helpers.go +
 * infra_test.go + example_test.go; rust: helpers.rs + infra_test.rs +
 * example_test.rs) actually carry their helpers/infra/example into the merged
 * tree. Earlier versions hardcoded vitest filenames and silently dropped the
 * other profiles' files.
 *
 * Each source becomes a self-contained subtree under its label so that:
 * (a) filename collisions between sources cannot happen (e.g. two phases each
 *     defining `public/foo.spec.ts`), and (b) relative imports in spec files
 *     such as `import '../helpers.js'` keep resolving — helpers sit at depth-1
 *     from `public/<spec>` exactly as in the unmerged single-source layout, so
 *     spec authors don't need a different import path under merge. Each source
 *     carries its own helpers/infra/example; there is no shared singleton
 *     (callers that need shared utilities should depend on a real package,
 *     not on cross-source merging).
 *
 * Test runners glob recursively, so the layout change is invisible to them.
 *
 * **Why hardlink/copy and not symlink?** The merged dir gets bind-mounted
 * into the Docker test runner. Absolute symlinks (the only kind we could
 * produce — sources live in different parent dirs) would dangle inside the
 * container because the host target paths are not present in the container's
 * mount namespace. Hardlinks are real directory entries that bind-mount
 * cleanly; we fall back to `copyFile` across filesystems (EXDEV).
 *
 * Single-source short-circuit: when `sources.length === 1`, returns that
 * source path directly. No filesystem work — the existing rsync layout is
 * already the right shape and gets bind-mounted as-is.
 *
 * @throws when `sources` is empty (caller's bug — should fall back before
 *   calling).
 */
export async function synthesizeMergedTestsDir(opts: {
  sources: readonly string[];
  destDir: string;
  testProfile: TestProfile;
}): Promise<string> {
  const { sources, destDir, testProfile } = opts;
  if (sources.length === 0) {
    throw new Error('synthesizeMergedTestsDir: empty sources list');
  }
  if (sources.length === 1) return sources[0]!;

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  // Per-profile top-level files. infraFilename is nullable; helpers and
  // example are always set.
  const topLevelFiles = [
    testProfile.helpersFilename,
    testProfile.infraFilename,
    testProfile.exampleFilename,
  ].filter((f): f is string => f !== null && f.length > 0);

  for (const source of sources) {
    const label = sanitizeLabel(source);
    const labelDir = join(destDir, label);
    const publicSrc = join(source, 'public');
    const hiddenSrc = join(source, 'hidden');

    if (await pathExists(publicSrc)) {
      await materializeTreeAt(publicSrc, join(labelDir, 'public'));
    }
    if (await pathExists(hiddenSrc)) {
      await materializeTreeAt(hiddenSrc, join(labelDir, 'hidden'));
    }
    for (const filename of topLevelFiles) {
      const src = join(source, filename);
      if (await pathExists(src)) {
        await materializeFileAt(src, join(labelDir, filename));
      }
    }
  }

  return destDir;
}

/**
 * Recursively recreate `srcDir` at `destDir` using real directory entries —
 * mkdir for directories, hardlink (or copy on EXDEV) for files. Symlinks in
 * the source tree are resolved and their target's contents are materialized.
 */
async function materializeTreeAt(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await materializeTreeAt(src, dest);
    } else if (entry.isSymbolicLink()) {
      // Resolve the symlink and materialize what it points at, so the merged
      // dir is self-contained and bind-mountable.
      const resolved = await stat(src);
      if (resolved.isDirectory()) {
        await materializeTreeAt(src, dest);
      } else {
        await materializeFileAt(src, dest);
      }
    } else if (entry.isFile()) {
      await materializeFileAt(src, dest);
    }
    // Sockets/devices/etc. are intentionally skipped — tests/ should not
    // contain them.
  }
}

async function materializeFileAt(srcFile: string, destFile: string): Promise<void> {
  await mkdir(dirname(destFile), { recursive: true });
  try {
    await link(srcFile, destFile);
  } catch (err: unknown) {
    // EXDEV (cross-device link) and EPERM (some filesystems forbid hardlinks)
    // are the realistic failure modes. Fall back to a real copy so the merged
    // dir always works inside the Docker bind-mount.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
      await copyFile(srcFile, destFile);
    } else {
      throw err;
    }
  }
}

/**
 * Build a stable, collision-resistant label from a tests-dir path.
 *
 * Uses the last two path segments (e.g. `phases/01-core/tests` → `01-core_tests`)
 * so that two sources whose final segment is `tests` don't collide. Non-alnum
 * characters are replaced with `_` to keep the label safe as a directory name.
 */
function sanitizeLabel(p: string): string {
  const parts = p.split(sep).filter(Boolean);
  const tail = parts.slice(-2).join('_') || parts.join('_') || 'src';
  return tail.replace(/[^a-zA-Z0-9_-]/g, '_');
}
