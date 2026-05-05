/**
 * Unit tests for the tests writer orchestrator.
 *
 * Tests the scaffolding path without touching the LLM — the tests writer agent is mocked
 * to return a deterministic TypeScript stub. Real filesystem is used via temp dirs.
 */

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveFeature } from '../specs/discover.js';
import { DEFAULT_TEST_PROFILE } from '../test-profiles/index.js';
import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { generateTests } from './write.js';

// ---------------------------------------------------------------------------
// Mock the coder agent so tests don't hit the LLM
// ---------------------------------------------------------------------------
vi.mock('../design-tests/agents/tests-writer.js', () => ({
  runTestsWriterAgent: vi
    .fn()
    .mockResolvedValue(
      `/* eslint-disable */\n// @ts-nocheck\nimport { describe, it, expect } from 'vitest';\ndescribe('mock', () => { it('placeholder', () => { expect(true).toBe(true); }); });\n`,
    ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `blackbox-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Build a TestCatalog JSON string with entrypoints */
function imperativeCatalog(extra: object = {}): string {
  return JSON.stringify({
    version: '1.0',
    featureName: 'test-feature',
    featureDir: 'saifctl/features/test-feature',
    testCases: [
      {
        id: 'tc-001',
        title: 'Happy path',
        description: 'Does the thing',
        tracesTo: [],
        category: 'happy_path',
        visibility: 'public',
        entrypoint: 'public/happy.spec.ts',
      },
      {
        id: 'tc-002',
        title: 'Holdout boundary',
        description: 'Boundary case',
        tracesTo: [],
        category: 'boundary',
        visibility: 'hidden',
        entrypoint: 'hidden/boundary.spec.ts',
      },
    ],
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// generateTests — main path
// ---------------------------------------------------------------------------

describe('generateTests', () => {
  let projectDir: string;
  let feature: Awaited<ReturnType<typeof resolveFeature>>;
  const saifctlDir = 'saifctl';
  const featureName = 'test-feature';

  beforeEach(async () => {
    projectDir = await makeTempDir();
    const featureDir = join(projectDir, saifctlDir, 'features', featureName);
    await mkdir(featureDir, { recursive: true });
    const testsDir = join(featureDir, 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeUtf8(join(testsDir, 'tests.json'), imperativeCatalog());
    feature = await resolveFeature({ input: featureName, projectDir, saifctlDir });
  });

  it('writes helpers.ts', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    const helpersPath = join(result.testsDir, 'helpers.ts');
    expect(await pathExists(helpersPath)).toBe(true);
    const content = await readUtf8(helpersPath);
    expect(content).toContain('execSidecar');
    expect(content).toContain('baseUrl');
  });

  it('writes infra.spec.ts', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    const infraPath = join(result.testsDir, 'infra.spec.ts');
    expect(await pathExists(infraPath)).toBe(true);
    const content = await readUtf8(infraPath);
    expect(content).toContain('sidecar:health');
  });

  it('writes the example seed test from the profile template', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    const examplePath = join(result.testsDir, 'example.spec.ts');
    expect(await pathExists(examplePath)).toBe(true);
    const content = await readUtf8(examplePath);
    // Contract: header signals "edit-in-place" so users don't think it's auto-regenerated,
    // and the body uses the same execSidecar transport as helpers.ts so it actually runs.
    expect(content).toContain('EDIT IN PLACE');
    expect(content).toContain('execSidecar');
  });

  it('does not overwrite example.spec.ts when it already exists', async () => {
    const testsDir = join(feature.absolutePath, 'tests');
    const examplePath = join(testsDir, 'example.spec.ts');
    await writeUtf8(examplePath, '// custom example, edited by user');

    await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });

    expect(await readUtf8(examplePath)).toBe('// custom example, edited by user');
  });

  it('generates spec files for each unique entrypoint', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });

    const publicSpec = join(result.testsDir, 'public', 'happy.spec.ts');
    const hiddenSpec = join(result.testsDir, 'hidden', 'boundary.spec.ts');

    expect(await pathExists(publicSpec)).toBe(true);
    expect(await pathExists(hiddenSpec)).toBe(true);
  });

  it('reports generated and skipped files', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    expect(result.generatedFiles).toContain('public/happy.spec.ts');
    expect(result.generatedFiles).toContain('hidden/boundary.spec.ts');
    expect(result.skippedFiles).toHaveLength(0);
  });

  it('does not overwrite an existing spec file', async () => {
    const testsDir = join(feature.absolutePath, 'tests');
    const existingPath = join(testsDir, 'public', 'happy.spec.ts');
    await mkdir(join(testsDir, 'public'), { recursive: true });
    await writeUtf8(existingPath, '// custom content');

    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });

    expect(await readUtf8(existingPath)).toBe('// custom content');
    expect(result.skippedFiles).toContain('public/happy.spec.ts');
    expect(result.generatedFiles).not.toContain('public/happy.spec.ts');
  });

  it('does not overwrite helpers.ts when it already exists', async () => {
    const testsDir = join(feature.absolutePath, 'tests');
    const helpersPath = join(testsDir, 'helpers.ts');
    await writeUtf8(helpersPath, '// custom helpers');

    await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });

    expect(await readUtf8(helpersPath)).toBe('// custom helpers');
  });

  it('returns correct testCaseCount', async () => {
    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    expect(result.testCaseCount).toBe(2);
  });

  it('always writes infra.spec.ts (even for web-only containers)', async () => {
    const testsDir = join(feature.absolutePath, 'tests');
    const webCatalog = JSON.stringify({
      version: '1.0',
      featureName: 'test-feature',
      featureDir: 'saifctl/features/test-feature',
      testCases: [
        {
          id: 'tc-001',
          title: 'API test',
          description: 'Hits API',
          tracesTo: [],
          category: 'happy_path',
          visibility: 'public',
          entrypoint: 'public/api.spec.ts',
        },
      ],
    });
    await writeUtf8(join(testsDir, 'tests.json'), webCatalog);

    const result = await generateTests({
      feature,
      testProfile: DEFAULT_TEST_PROFILE,
    });
    expect(await pathExists(join(result.testsDir, 'infra.spec.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateTests — error cases
// ---------------------------------------------------------------------------

describe('generateTests (error cases)', () => {
  it('throws when tests.json does not exist', async () => {
    const projectDir = await makeTempDir();
    const featureDir = join(projectDir, 'saifctl', 'features', 'missing');
    await mkdir(featureDir, { recursive: true });
    const feature = await resolveFeature({ input: 'missing', projectDir, saifctlDir: 'saifctl' });
    await expect(
      generateTests({
        feature,
        testProfile: DEFAULT_TEST_PROFILE,
      }),
    ).rejects.toThrow(/tests.json not found/);
  });

  it('throws when tests.json fails schema validation', async () => {
    const projectDir = await makeTempDir();
    const featureDir = join(projectDir, 'saifctl', 'features', 'bad-feature');
    await mkdir(featureDir, { recursive: true });
    const testsDir = join(featureDir, 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeUtf8(join(testsDir, 'tests.json'), '{"invalid": true}');
    const feature = await resolveFeature({
      input: 'bad-feature',
      projectDir,
      saifctlDir: 'saifctl',
    });
    await expect(
      generateTests({
        feature,
        testProfile: DEFAULT_TEST_PROFILE,
      }),
    ).rejects.toThrow(/schema validation/);
  });
});
