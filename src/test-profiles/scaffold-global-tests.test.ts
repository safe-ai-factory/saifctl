/**
 * Unit tests for scaffoldGlobalTests — the project-level scaffolder backing
 * `saifctl init` and `saifctl init tests`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathExists, readUtf8 } from '../utils/io.js';
import { SUPPORTED_PROFILES } from './index.js';
import { CrossLanguageScaffoldError, scaffoldGlobalTests } from './scaffold-global-tests.js';
import { readProfileTemplate } from './templates.js';

let TEST_BASE: string;

beforeEach(async () => {
  TEST_BASE = join(
    tmpdir(),
    `scaffold-global-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_BASE, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_BASE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('scaffoldGlobalTests (node-vitest)', () => {
  const profile = SUPPORTED_PROFILES['node-vitest'];

  it('writes helpers, infra, and example into <saifctl>/tests/ on first run', async () => {
    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: profile,
      force: false,
    });

    expect(result.testsDir).toBe(join(TEST_BASE, 'saifctl', 'tests'));
    expect(result.files).toHaveLength(3);

    for (const f of result.files) {
      expect(f.action).toBe('created');
      expect(await pathExists(f.path)).toBe(true);
    }
    // Sanity: pick a known string from each template to confirm the right
    // template was read (and not, say, a previous scaffold's output).
    expect(await readFile(join(result.testsDir, 'helpers.ts'), 'utf8')).toContain('execSidecar');
    expect(await readFile(join(result.testsDir, 'infra.spec.ts'), 'utf8')).toContain(
      'sidecar:health',
    );
    expect(await readFile(join(result.testsDir, 'example.spec.ts'), 'utf8')).toContain(
      'EDIT IN PLACE',
    );
  });

  it('skips files that already exist (default behavior)', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'helpers.ts'), '// user helpers');
    await writeFile(join(testsDir, 'example.spec.ts'), '// user example');

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: profile,
      force: false,
    });

    const helpersResult = result.files.find((f) => f.path.endsWith('helpers.ts'));
    const exampleResult = result.files.find((f) => f.path.endsWith('example.spec.ts'));
    const infraResult = result.files.find((f) => f.path.endsWith('infra.spec.ts'));

    expect(helpersResult?.action).toBe('skipped');
    expect(exampleResult?.action).toBe('skipped');
    expect(infraResult?.action).toBe('created');

    expect(await readFile(join(testsDir, 'helpers.ts'), 'utf8')).toBe('// user helpers');
    expect(await readFile(join(testsDir, 'example.spec.ts'), 'utf8')).toBe('// user example');
  });

  it('overwrites existing files when force=true', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'helpers.ts'), '// user helpers');

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: profile,
      force: true,
    });

    const helpersResult = result.files.find((f) => f.path.endsWith('helpers.ts'));
    expect(helpersResult?.action).toBe('overwritten');
    expect(await readFile(join(testsDir, 'helpers.ts'), 'utf8')).toContain('execSidecar');
  });

  it('creates the tests dir when it does not exist', async () => {
    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: profile,
      force: false,
    });
    expect(await pathExists(result.testsDir)).toBe(true);
  });
});

describe('scaffoldGlobalTests cross-language guard', () => {
  it('refuses to scaffold node-vitest into a dir holding python helpers', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'helpers.py'), '# python helpers from a prior scaffold');

    await expect(
      scaffoldGlobalTests({
        saifctlDir: 'saifctl',
        projectDir: TEST_BASE,
        testProfile: SUPPORTED_PROFILES['node-vitest'],
        force: false,
      }),
    ).rejects.toBeInstanceOf(CrossLanguageScaffoldError);
  });

  it('switches profiles when --force is passed (overrides the guard)', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'helpers.py'), '# python helpers');

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: SUPPORTED_PROFILES['node-vitest'],
      force: true,
    });

    // helpers.ts created; the orphaned helpers.py is left in place (force
    // overwrites the new profile's targets, doesn't sweep the dir).
    expect(await pathExists(join(testsDir, 'helpers.ts'))).toBe(true);
    expect(await pathExists(join(testsDir, 'helpers.py'))).toBe(true);
    expect(result.files.find((f) => f.path.endsWith('helpers.ts'))?.action).toBe('created');
  });

  it('treats same-helpers-filename profiles as compatible (no guard fire)', async () => {
    // node-vitest and node-playwright both use helpers.ts. Switching between
    // them must not require --force.
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'helpers.ts'), '// shared helpers shape');

    await expect(
      scaffoldGlobalTests({
        saifctlDir: 'saifctl',
        projectDir: TEST_BASE,
        testProfile: SUPPORTED_PROFILES['node-playwright'],
        force: false,
      }),
    ).resolves.not.toThrow();
  });
});

describe('scaffoldGlobalTests content-based profile switch', () => {
  // node-vitest and node-playwright share filenames (helpers.ts,
  // example.spec.ts, infra.spec.ts) but ship different template content.
  // Switching profiles must overwrite the unmodified content (the user
  // never edited it) but preserve any handcrafted edits.

  it('silently swaps unmodified template content when switching profiles', async () => {
    // Plant the *exact* node-vitest templates, then scaffold node-playwright.
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    const vitestHelpers = await readProfileTemplate('node-vitest', 'helpers.ts');
    const vitestExample = await readProfileTemplate('node-vitest', 'example.spec.ts');
    const vitestInfra = await readProfileTemplate('node-vitest', 'infra.spec.ts');
    await writeFile(join(testsDir, 'helpers.ts'), vitestHelpers);
    await writeFile(join(testsDir, 'example.spec.ts'), vitestExample);
    await writeFile(join(testsDir, 'infra.spec.ts'), vitestInfra);

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: SUPPORTED_PROFILES['node-playwright'],
      force: false,
    });

    const helpersResult = result.files.find((f) => f.path.endsWith('helpers.ts'));
    const exampleResult = result.files.find((f) => f.path.endsWith('example.spec.ts'));
    const infraResult = result.files.find((f) => f.path.endsWith('infra.spec.ts'));

    expect(helpersResult?.action).toBe('switched');
    expect(helpersResult?.switchedFrom).toBe('node-vitest');
    expect(exampleResult?.action).toBe('switched');
    expect(exampleResult?.switchedFrom).toBe('node-vitest');
    expect(infraResult?.action).toBe('switched');
    expect(infraResult?.switchedFrom).toBe('node-vitest');

    // Files now hold node-playwright content.
    const playwrightHelpers = await readProfileTemplate('node-playwright', 'helpers.ts');
    const playwrightExample = await readProfileTemplate('node-playwright', 'example.spec.ts');
    expect(await readUtf8(join(testsDir, 'helpers.ts'))).toBe(playwrightHelpers);
    expect(await readUtf8(join(testsDir, 'example.spec.ts'))).toBe(playwrightExample);
  });

  it('preserves user-edited files when switching profiles without --force', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    // Plant the canonical vitest helpers but a hand-edited example.
    const vitestHelpers = await readProfileTemplate('node-vitest', 'helpers.ts');
    await writeFile(join(testsDir, 'helpers.ts'), vitestHelpers);
    await writeFile(join(testsDir, 'example.spec.ts'), '// my custom example test');

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: SUPPORTED_PROFILES['node-playwright'],
      force: false,
    });

    const helpersResult = result.files.find((f) => f.path.endsWith('helpers.ts'));
    const exampleResult = result.files.find((f) => f.path.endsWith('example.spec.ts'));

    // helpers.ts: matched node-vitest template → silent swap.
    expect(helpersResult?.action).toBe('switched');
    expect(helpersResult?.switchedFrom).toBe('node-vitest');
    // example.spec.ts: matches no template → preserved.
    expect(exampleResult?.action).toBe('skipped');
    expect(await readUtf8(join(testsDir, 'example.spec.ts'))).toBe('// my custom example test');
  });

  it('--force overwrites user-edited files even when switching profiles', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    await writeFile(join(testsDir, 'example.spec.ts'), '// my custom example test');

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: SUPPORTED_PROFILES['node-playwright'],
      force: true,
    });

    const exampleResult = result.files.find((f) => f.path.endsWith('example.spec.ts'));
    expect(exampleResult?.action).toBe('overwritten');
    const playwrightExample = await readProfileTemplate('node-playwright', 'example.spec.ts');
    expect(await readUtf8(join(testsDir, 'example.spec.ts'))).toBe(playwrightExample);
  });

  it('skips (true noop) when existing content already matches requested profile', async () => {
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await mkdir(testsDir, { recursive: true });
    const vitestExample = await readProfileTemplate('node-vitest', 'example.spec.ts');
    await writeFile(join(testsDir, 'example.spec.ts'), vitestExample);

    const result = await scaffoldGlobalTests({
      saifctlDir: 'saifctl',
      projectDir: TEST_BASE,
      testProfile: SUPPORTED_PROFILES['node-vitest'],
      force: false,
    });

    const exampleResult = result.files.find((f) => f.path.endsWith('example.spec.ts'));
    expect(exampleResult?.action).toBe('skipped');
    expect(exampleResult?.switchedFrom).toBeUndefined();
  });
});

describe('scaffoldGlobalTests across all profiles', () => {
  // Smoke test that every profile's templates resolve and write correctly —
  // catches a missing or mis-named template file (e.g. forgetting to add
  // example_test.go for go-gotest) at unit-test time, not in production.
  it.each(Object.values(SUPPORTED_PROFILES).map((p) => p.id))(
    'scaffolds %s without throwing',
    async (profileId) => {
      const profile = SUPPORTED_PROFILES[profileId];
      const projectDir = join(TEST_BASE, profileId);
      await mkdir(projectDir, { recursive: true });

      const result = await scaffoldGlobalTests({
        saifctlDir: 'saifctl',
        projectDir,
        testProfile: profile,
        force: false,
      });

      const helpersFile = result.files.find((f) => f.path.endsWith(profile.helpersFilename));
      const exampleFile = result.files.find((f) => f.path.endsWith(profile.exampleFilename));
      expect(helpersFile?.action).toBe('created');
      expect(exampleFile?.action).toBe('created');
    },
  );
});
