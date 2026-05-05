/**
 * Tests for {@link inspectImmutableTestChanges} and
 * {@link formatImmutableViolations} (Block 7 — diff inspection).
 *
 * Uses a real git repo per test (mkdtemp + git init + commits) so we exercise
 * the actual `git diff --name-only` shape — mocking git would defeat the
 * purpose. Tests are fast (~20ms each) because the repos are tiny.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatImmutableViolations, inspectImmutableTestChanges } from './mutability-check.js';

const exec = promisify(execFile);

let projectDir: string;
let featureDir: string;
const FEATURE_NAME = 'auth';
const FEATURE_REL = `saifctl/features/${FEATURE_NAME}`;

async function gitInit(): Promise<void> {
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: projectDir });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir });
  await exec('git', ['config', 'user.name', 'test'], { cwd: projectDir });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectDir });
}
async function gitCommitAll(message: string): Promise<string> {
  await exec('git', ['add', '-A'], { cwd: projectDir });
  await exec('git', ['commit', '-q', '-m', message], { cwd: projectDir });
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
  return stdout.trim();
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'saifctl-mutability-check-'));
  featureDir = join(projectDir, 'saifctl', 'features', FEATURE_NAME);
  await mkdir(featureDir, { recursive: true });
  // Seed an initial commit so HEAD exists.
  await writeFile(join(projectDir, 'README.md'), '# seed', 'utf8');
  await gitInit();
  await gitCommitAll('seed');
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('inspectImmutableTestChanges', () => {
  it('returns no violations when the agent only modifies application code', async () => {
    const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: projectDir })).stdout.trim();
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(join(projectDir, 'src', 'index.ts'), 'export const x = 1;', 'utf8');
    await gitCommitAll('add src');

    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: true,
      preRoundHead: baseSha,
    });

    expect(result.changedPaths).toEqual(['src/index.ts']);
    expect(result.violations).toEqual([]);
  });

  it('flags any change under saifctl/tests/ as a violation regardless of strict flag', async () => {
    const projTestsDir = join(projectDir, 'saifctl', 'tests');
    await mkdir(projTestsDir, { recursive: true });
    await writeFile(join(projTestsDir, 'contract.spec.ts'), 'orig', 'utf8');
    const baseSha = await gitCommitAll('seed contract');

    await writeFile(join(projTestsDir, 'contract.spec.ts'), 'tampered', 'utf8');
    await gitCommitAll('agent tampered');

    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: false, // even with --no-strict, project tests stay locked
      preRoundHead: baseSha,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.path).toBe('saifctl/tests/contract.spec.ts');
    expect(result.violations[0]?.layer).toBe('project');
  });

  it('respects feature.yml tests.mutable: true (no violation on feature-test edit)', async () => {
    const featTestsDir = join(featureDir, 'tests');
    await mkdir(featTestsDir, { recursive: true });
    await writeFile(join(featTestsDir, 'login.spec.ts'), 'orig', 'utf8');
    await writeFile(join(featureDir, 'feature.yml'), `tests:\n  mutable: true\n`, 'utf8');
    const baseSha = await gitCommitAll('seed');

    await writeFile(join(featTestsDir, 'login.spec.ts'), 'agent edited', 'utf8');
    await gitCommitAll('agent edit');

    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: true,
      preRoundHead: baseSha,
    });

    expect(result.violations).toEqual([]);
    expect(result.classifiedTestPaths).toHaveLength(1);
    expect(result.classifiedTestPaths[0]?.mutable).toBe(true);
  });

  it('flags an immutable-files glob match even when surrounding scope is mutable', async () => {
    const featTestsDir = join(featureDir, 'tests');
    await mkdir(featTestsDir, { recursive: true });
    await writeFile(join(featTestsDir, 'api-contract.test.ts'), 'orig', 'utf8');
    await writeFile(join(featTestsDir, 'login.spec.ts'), 'orig', 'utf8');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `tests:\n  mutable: true\n  immutable-files:\n    - "tests/api-contract.test.ts"\n`,
      'utf8',
    );
    const baseSha = await gitCommitAll('seed');

    await writeFile(join(featTestsDir, 'api-contract.test.ts'), 'tampered', 'utf8');
    await writeFile(join(featTestsDir, 'login.spec.ts'), 'agent edited', 'utf8');
    await gitCommitAll('agent edits');

    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: true,
      preRoundHead: baseSha,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.path).toBe(`${FEATURE_REL}/tests/api-contract.test.ts`);
  });

  it('returns empty result when preRoundHead is unknown (does not throw)', async () => {
    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: true,
      preRoundHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(result.violations).toEqual([]);
    expect(result.changedPaths).toEqual([]);
  });

  it('uses preLoadedConfig instead of re-reading feature.yml when supplied', async () => {
    // Author no feature.yml on disk to prove the inspector trusts the supplied config.
    const featTestsDir = join(featureDir, 'tests');
    await mkdir(featTestsDir, { recursive: true });
    await writeFile(join(featTestsDir, 'login.spec.ts'), 'orig', 'utf8');
    const baseSha = await gitCommitAll('seed');

    await writeFile(join(featTestsDir, 'login.spec.ts'), 'agent edited', 'utf8');
    await gitCommitAll('edit');

    const result = await inspectImmutableTestChanges({
      codePath: projectDir,
      projectDir,
      saifctlDir: 'saifctl',
      featureAbsolutePath: featureDir,
      projectDefaultStrict: true,
      preRoundHead: baseSha,
      // Inject a config that says tests are mutable — would not match disk.
      preLoadedConfig: { featureConfig: { tests: { mutable: true } }, phaseConfigs: new Map() },
    });
    // No violation because the supplied config marks tests mutable.
    expect(result.violations).toEqual([]);
  });
});

describe('formatImmutableViolations', () => {
  it('returns empty string when no violations', () => {
    expect(formatImmutableViolations([])).toBe('');
  });

  it('names every violating path on its own line', () => {
    const msg = formatImmutableViolations([
      {
        path: 'saifctl/tests/a.spec.ts',
        mutable: false,
        reason: 'always immutable',
        layer: 'project',
      },
      {
        path: `${FEATURE_REL}/tests/b.spec.ts`,
        mutable: false,
        reason: 'phase resolved as immutable',
        layer: 'feature',
      },
    ]);
    expect(msg).toMatch(/2 immutable test files/);
    expect(msg).toContain('saifctl/tests/a.spec.ts');
    expect(msg).toContain(`${FEATURE_REL}/tests/b.spec.ts`);
    // Operator hint must point at the recovery path so the gate failure is actionable.
    expect(msg).toMatch(/tests\.mutable: true/);
  });

  it('uses singular wording when there is exactly one violation', () => {
    const msg = formatImmutableViolations([
      {
        path: 'saifctl/tests/a.spec.ts',
        mutable: false,
        reason: 'always immutable',
        layer: 'project',
      },
    ]);
    expect(msg).toMatch(/1 immutable test file:/);
  });
});
