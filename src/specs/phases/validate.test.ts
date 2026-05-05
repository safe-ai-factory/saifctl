/**
 * Tests for {@link validatePhasedFeature} (Block 6 — standalone validator).
 *
 * The validator unifies what compile.ts used to do inline (load + discover +
 * cross-validate) and adds Block 6's spec-existence check on top. It must:
 *
 * - Return {@link ValidationReport} with both `errors` and `warnings`.
 * - Fold parse / multi-variant errors into `errors` (don't throw — the CLI
 *   prints all problems at once).
 * - Detect `phases/` ⊕ `subtasks.json` mutual exclusion (no caller-supplied
 *   flag — the validator stats the disk itself).
 * - Reject phases whose resolved spec file is missing.
 * - Return `context: null` when there are errors so callers can't use stale data.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validatePhasedFeature } from './validate.js';

let featureDir: string;

beforeEach(async () => {
  featureDir = await mkdtemp(join(tmpdir(), 'saifctl-validate-'));
});

afterEach(async () => {
  await rm(featureDir, { recursive: true, force: true });
});

async function makePhase(id: string, opts: { spec?: string } = {}): Promise<void> {
  const phaseDir = join(featureDir, 'phases', id);
  await mkdir(phaseDir, { recursive: true });
  await writeFile(join(phaseDir, opts.spec ?? 'spec.md'), `# ${id} spec\n`, 'utf8');
}

describe('validatePhasedFeature', () => {
  it('returns a clean report and a non-null context for a valid feature', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(context).not.toBeNull();
    expect(context?.phases.map((p) => p.id)).toEqual(['01-core', '02-trigger']);
    expect(context?.subtasksJsonPresent).toBe(false);
  });

  it('reports an error when a phase is missing its resolved spec file (Block 6 file-existence check)', async () => {
    // No spec.md inside the phase dir.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(context).toBeNull();
    expect(
      report.errors.some(
        (e) => /phase '01-core'/.test(e) && /missing/.test(e) && /spec\.md/.test(e),
      ),
    ).toBe(true);
  });

  it('honours phase.yml `spec:` override when checking spec existence', async () => {
    // Phase resolves spec to design.md but only ships spec.md ⇒ should error
    // about design.md (not the default spec.md). Use distinct names rather
    // than a case-only difference because macOS APFS is case-insensitive by
    // default — `spec.md` and `SPEC.md` would map to the same inode.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });
    await writeFile(join(featureDir, 'phases', '01-core', 'spec.md'), '# default', 'utf8');
    await writeFile(
      join(featureDir, 'phases', '01-core', 'phase.yml'),
      `spec: design.md\n`,
      'utf8',
    );

    const { report } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(report.errors.some((e) => /design\.md/.test(e))).toBe(true);
    // The default name should NOT appear in any error — we resolved away from it.
    expect(report.errors.some((e) => /missing.*'spec\.md'/.test(e))).toBe(false);
  });

  it('detects subtasks.json + phases/ mutual exclusion without caller-supplied flag', async () => {
    await makePhase('01-core');
    await writeFile(join(featureDir, 'subtasks.json'), '[]', 'utf8');

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(context).toBeNull();
    expect(report.errors.some((e) => /mutually exclusive/.test(e))).toBe(true);
  });

  it('folds feature.yml parse errors into report.errors instead of throwing', async () => {
    await makePhase('01-core');
    // Invalid yaml — unclosed bracket.
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id:\n`, 'utf8');

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(context).toBeNull();
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.some((e) => /feature\.yml/.test(e) || /YAML/i.test(e))).toBe(true);
  });

  it('continues across phase.yml parse errors so all problems surface in one pass', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');
    // Break only 02-trigger's phase.yml — 01-core stays clean.
    await writeFile(
      join(featureDir, 'phases', '02-trigger', 'phase.yml'),
      `critics: { not-a-list }\n`,
      'utf8',
    );

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    expect(context).toBeNull();
    expect(report.errors.length).toBeGreaterThan(0);
    // The 02-trigger error must mention that file — defends against the
    // validator silently swallowing per-phase errors.
    expect(report.errors.some((e) => /02-trigger/.test(e) || /phase\.yml/.test(e))).toBe(true);
  });

  it('returns context: null when ANY error is present, even if cross-file checks pass', async () => {
    // Valid graph but missing spec ⇒ context must be null so compile can't
    // proceed on partial data.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });
    expect(report.errors.length).toBeGreaterThan(0);
    expect(context).toBeNull();
  });

  it('always returns a warnings array (empty in v1) so callers can iterate without branching', async () => {
    await makePhase('01-core');
    const { report } = await validatePhasedFeature({ featureAbsolutePath: featureDir });
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  // Block 7 (§5.5): immutable-files globs that match no on-disk file are
  // **warnings**, not errors — the glob may anticipate a file an upcoming
  // phase will write. The error path is reserved for "..-segment / absolute
  // path" globs (rejected in the schema). We assert both: a glob that
  // matches a real file produces no warning; a glob that matches nothing
  // produces a warning naming that exact glob.
  it('warns (does NOT error) for immutable-files globs that match zero files on disk', async () => {
    await makePhase('01-core');
    const featTestsDir = join(featureDir, 'tests');
    await mkdir(featTestsDir, { recursive: true });
    await writeFile(join(featTestsDir, 'real.spec.ts'), 'test', 'utf8');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `tests:\n  mutable: true\n  immutable-files:\n    - "tests/real.spec.ts"\n    - "tests/ghost.spec.ts"\n`,
      'utf8',
    );

    const { report, context } = await validatePhasedFeature({ featureAbsolutePath: featureDir });

    // No errors — feature is otherwise valid.
    expect(report.errors).toEqual([]);
    expect(context).not.toBeNull();
    // Exactly one unused glob warning, naming the unused glob.
    const ghostWarnings = report.warnings.filter(
      (w) => /immutable-files/.test(w) && /ghost\.spec\.ts/.test(w),
    );
    expect(ghostWarnings).toHaveLength(1);
    // The matched glob must NOT be warned about.
    expect(report.warnings.some((w) => /'tests\/real\.spec\.ts'/.test(w))).toBe(false);
  });

  it('immutable-files glob that matches a phase-level test file does not warn', async () => {
    await makePhase('01-core');
    const phaseTestsDir = join(featureDir, 'phases', '01-core', 'tests');
    await mkdir(phaseTestsDir, { recursive: true });
    await writeFile(join(phaseTestsDir, 'phase.spec.ts'), 'test', 'utf8');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `tests:\n  mutable: true\n  immutable-files:\n    - "phases/01-core/tests/phase.spec.ts"\n`,
      'utf8',
    );

    const { report } = await validatePhasedFeature({ featureAbsolutePath: featureDir });
    expect(report.warnings.filter((w) => /immutable-files/.test(w))).toEqual([]);
  });

  it('non-existent featureDir is reported as an error, not a throw', async () => {
    // Validator must be safe to call even if the feature dir is gone — the
    // CLI may invoke it from a stale slug. Either an empty/successful report
    // (no phases ⇒ trivially valid) OR a structured error is acceptable; what
    // we forbid is an unhandled exception bubbling up.
    const ghost = join(featureDir, 'does-not-exist');
    await expect(validatePhasedFeature({ featureAbsolutePath: ghost })).resolves.not.toThrow();
  });
});
