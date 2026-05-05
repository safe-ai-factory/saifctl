/**
 * Tests for {@link classifyModifiedPaths} and
 * {@link surfaceModifiedPathsAfterRound} (Block 8 of TODO_phases_and_critics).
 *
 * The classifier is pure and exhaustively tested first. The surfacer wraps
 * it with consola + JSONL append; we drive it against a real tmp dir so the
 * filesystem path semantics get exercised end-to-end (mocking fs is the
 * exact "tests pass but prod breaks" failure mode this module is supposed
 * to surface).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyModifiedPaths,
  formatRoundWarning,
  surfaceModifiedPathsAfterRound,
} from './post-round-warnings.js';

const SAIFCTL = 'saifctl';
const FEATURE_REL = 'saifctl/features/auth';

describe('classifyModifiedPaths', () => {
  it('classifies <feature>/plan.md as plan', () => {
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/plan.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([{ path: `${FEATURE_REL}/plan.md`, kind: 'plan' }]);
  });

  it('classifies <feature>/specification.md as spec (Block 5 convention)', () => {
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/specification.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out[0]?.kind).toBe('spec');
  });

  it('classifies <feature>/phases/<id>/spec.md as spec', () => {
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/phases/01-core/spec.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out[0]?.kind).toBe('spec');
  });

  it('classifies tests under saifctl/tests/, <feature>/tests/, and <feature>/phases/<id>/tests/', () => {
    const out = classifyModifiedPaths({
      paths: [
        'saifctl/tests/contract.spec.ts',
        `${FEATURE_REL}/tests/login.spec.ts`,
        `${FEATURE_REL}/phases/01-core/tests/x.spec.ts`,
        `${FEATURE_REL}/phases/01-core/tests/nested/deep.spec.ts`,
      ],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out.map((c) => c.kind)).toEqual(['test', 'test', 'test', 'test']);
  });

  it('excludes critic-findings transient artifacts (workspace-root form)', () => {
    const out = classifyModifiedPaths({
      paths: ['.saifctl/critic-findings/01-core--paranoid--r1.md', `${FEATURE_REL}/plan.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe(`${FEATURE_REL}/plan.md`);
  });

  it('excludes critic-findings even when nested under the feature dir', () => {
    // Belt-and-braces: if a future template version writes findings under the
    // feature dir, the exclusion still applies. (Today the canonical path is
    // workspace-root `.saifctl/critic-findings/`.)
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/.saifctl/critic-findings/x.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([]);
  });

  it('drops src/** and other non-plan/spec/test paths silently', () => {
    const out = classifyModifiedPaths({
      paths: [
        `${FEATURE_REL}/src/index.ts`,
        `${FEATURE_REL}/README.md`,
        'src/orchestrator/loop.ts',
        `${FEATURE_REL}/phases/01-core/notes.md`,
      ],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([]);
  });

  it('only matches saifctl/tests/ when featureRelativePath is null (POC mode)', () => {
    const out = classifyModifiedPaths({
      paths: ['saifctl/tests/contract.spec.ts', `${FEATURE_REL}/plan.md`, 'plan.md'],
      saifctlDir: SAIFCTL,
      featureRelativePath: null,
    });
    expect(out).toEqual([{ path: 'saifctl/tests/contract.spec.ts', kind: 'test' }]);
  });

  it("does not classify a sibling feature's files (boundary check)", () => {
    // The agent shouldn't normally touch another feature, but if it does,
    // the warning should not pretend to know what's plan/spec there — the
    // classifier is feature-scoped and silently drops cross-feature paths.
    const out = classifyModifiedPaths({
      paths: ['saifctl/features/billing/plan.md'],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([]);
  });

  it('does not classify nested phase dirs (strict shape: phases/<id>/spec.md)', () => {
    // `phases/01/02/spec.md` is not a valid phase layout per §4; treat as
    // unclassified rather than incorrectly tagging it as a spec deviation.
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/phases/01-core/sub/spec.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([]);
  });

  it('respects phaseSpecFilenames for projects that override the spec filename', () => {
    // Project sets `phases.defaults.spec: SPEC.md` (e.g. uppercase convention).
    // The classifier must classify the resolved filename as the phase spec,
    // not the built-in default `spec.md`.
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/phases/01-core/SPEC.md`, `${FEATURE_REL}/phases/01-core/spec.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
      phaseSpecFilenames: new Map([['01-core', 'SPEC.md']]),
    });
    expect(out).toEqual([{ path: `${FEATURE_REL}/phases/01-core/SPEC.md`, kind: 'spec' }]);
  });

  it('falls back to spec.md for phases not in phaseSpecFilenames', () => {
    // Mixed feature: `01-core` overrides, `02-extras` uses the default. The
    // map is keyed per-phase, so an absent key keeps the built-in fallback.
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/phases/01-core/SPEC.md`, `${FEATURE_REL}/phases/02-extras/spec.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
      phaseSpecFilenames: new Map([['01-core', 'SPEC.md']]),
    });
    expect(out.map((c) => c.path).sort()).toEqual(
      [`${FEATURE_REL}/phases/01-core/SPEC.md`, `${FEATURE_REL}/phases/02-extras/spec.md`].sort(),
    );
  });

  it('does not classify src/plan.md sub-dirs (only feature-root plan.md)', () => {
    const out = classifyModifiedPaths({
      paths: [`${FEATURE_REL}/docs/plan.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
    });
    expect(out).toEqual([]);
  });
});

describe('formatRoundWarning', () => {
  it('produces the [round N] message named in the spec', () => {
    const msg = formatRoundWarning(3, [
      { path: `${FEATURE_REL}/plan.md`, kind: 'plan' },
      { path: 'saifctl/tests/contract.spec.ts', kind: 'test' },
    ]);
    expect(msg).toBe(
      `[round 3] Agent modified the following plan/spec/test files: ${FEATURE_REL}/plan.md (plan), saifctl/tests/contract.spec.ts (test)`,
    );
  });
});

describe('surfaceModifiedPathsAfterRound', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'saifctl-post-round-'));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('appends one JSONL record per round to .saifctl/runs/<runId>/modifications.log', async () => {
    const runId = 'run-abc123';
    await surfaceModifiedPathsAfterRound({
      round: 1,
      subtaskIndex: 0,
      phaseId: '01-core',
      criticId: null,
      changedPaths: [`${FEATURE_REL}/plan.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
      projectDir,
      runId,
    });
    await surfaceModifiedPathsAfterRound({
      round: 2,
      subtaskIndex: 0,
      phaseId: '01-core',
      criticId: null,
      changedPaths: [`${FEATURE_REL}/plan.md`, `${FEATURE_REL}/phases/01-core/spec.md`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
      projectDir,
      runId,
    });

    const logPath = join(projectDir, '.saifctl', 'runs', runId, 'modifications.log');
    const body = await readFile(logPath, 'utf8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);

    const r1 = JSON.parse(lines[0]!);
    const r2 = JSON.parse(lines[1]!);
    // De-duplication semantics: the same file modified across consecutive
    // rounds appears in both records (one per round). The user wants
    // frequency, not just presence.
    expect(r1.round).toBe(1);
    expect(r2.round).toBe(2);
    expect(r1.files).toEqual([{ path: `${FEATURE_REL}/plan.md`, kind: 'plan' }]);
    expect(r2.files).toContainEqual({ path: `${FEATURE_REL}/plan.md`, kind: 'plan' });
    expect(r2.files).toContainEqual({
      path: `${FEATURE_REL}/phases/01-core/spec.md`,
      kind: 'spec',
    });
    // Timestamp is ISO-8601 (the JSONL is meant to be grep-friendly).
    expect(r1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits no warning and writes nothing when no plan/spec/test files were touched', async () => {
    await surfaceModifiedPathsAfterRound({
      round: 1,
      subtaskIndex: 0,
      phaseId: null,
      criticId: null,
      changedPaths: [`${FEATURE_REL}/src/index.ts`],
      saifctlDir: SAIFCTL,
      featureRelativePath: FEATURE_REL,
      projectDir,
      runId: 'run-xyz',
    });
    // No log file — the parent dir was never created.
    const logPath = join(projectDir, '.saifctl', 'runs', 'run-xyz', 'modifications.log');
    await expect(readFile(logPath, 'utf8')).rejects.toThrow();
  });

  it('does not throw if the JSONL append fails (best-effort breadcrumb only)', async () => {
    // Force the append to fail by making the runs/ directory a regular file.
    // The function must not propagate — a missing breadcrumb is not worth
    // failing a coding round over.
    await writeFile(join(projectDir, '.saifctl'), 'not a directory', 'utf8');
    await expect(
      surfaceModifiedPathsAfterRound({
        round: 1,
        subtaskIndex: 0,
        phaseId: null,
        criticId: null,
        changedPaths: [`${FEATURE_REL}/plan.md`],
        saifctlDir: SAIFCTL,
        featureRelativePath: FEATURE_REL,
        projectDir,
        runId: 'run-xyz',
      }),
    ).resolves.toBeDefined();
  });
});
