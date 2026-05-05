/**
 * Unit tests for `saifctl init` and `saifctl init tests`.
 *
 * Drives the citty `run` handler directly so we don't shell out. Filesystem
 * is real (tmpdir); the indexer hook is not exercised here.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathExists } from '../../utils/io.js';
import initCommand from './init.js';

let TEST_BASE: string;

beforeEach(async () => {
  TEST_BASE = join(tmpdir(), `init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(TEST_BASE, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_BASE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Drive a citty subcommand's `run` directly with a `_: []` arg list. */
async function invokeInit(args: Record<string, unknown>): Promise<void> {
  const cmd = await Promise.resolve(initCommand);
  await cmd.run!({ args: { _: [], ...args } as never, cmd, rawArgs: [], data: undefined });
}

async function invokeInitTests(args: Record<string, unknown>): Promise<void> {
  const parent = await Promise.resolve(initCommand);
  // citty's SubCommandsDef and CommandDef can be literals or factories; we
  // know they're literals here, but narrow for the type checker.
  const subsRaw = parent.subCommands;
  if (typeof subsRaw === 'function') {
    throw new Error('init.subCommands is unexpectedly a factory; update test driver');
  }
  const subs = await Promise.resolve(subsRaw!);
  const subRaw = subs.tests;
  if (typeof subRaw === 'function') {
    throw new Error('init.subCommands.tests is unexpectedly a factory; update test driver');
  }
  const sub = await Promise.resolve(subRaw!);
  await sub.run!({ args: { _: [], ...args } as never, cmd: sub, rawArgs: [], data: undefined });
}

describe('saifctl init', () => {
  it('scaffolds saifctl/config.ts and saifctl/tests/{helpers,infra,example}.ts on a fresh project', async () => {
    await invokeInit({ 'project-dir': TEST_BASE, project: 'init-test' });

    expect(await pathExists(join(TEST_BASE, 'saifctl', 'config.ts'))).toBe(true);
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    expect(await pathExists(join(testsDir, 'helpers.ts'))).toBe(true);
    expect(await pathExists(join(testsDir, 'infra.spec.ts'))).toBe(true);
    expect(await pathExists(join(testsDir, 'example.spec.ts'))).toBe(true);
  });

  it('skips already-present files (idempotent re-run)', async () => {
    await invokeInit({ 'project-dir': TEST_BASE, project: 'init-test' });
    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    await writeFile(join(testsDir, 'example.spec.ts'), '// user edits');

    await invokeInit({ 'project-dir': TEST_BASE, project: 'init-test' });

    expect(await readFile(join(testsDir, 'example.spec.ts'), 'utf8')).toBe('// user edits');
  });
});

describe('saifctl init tests', () => {
  it('scaffolds tests/ when run on a project that already has config.ts', async () => {
    // Simulate a repo where someone hand-rolled config.ts before saifctl
    // grew the tests-scaffolding step. Plain `init` would skip the config
    // (already exists) but `init tests` still scaffolds tests/.
    await mkdir(join(TEST_BASE, 'saifctl'), { recursive: true });
    await writeFile(join(TEST_BASE, 'saifctl', 'config.ts'), '// pre-existing');

    await invokeInitTests({ 'project-dir': TEST_BASE });

    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    expect(await pathExists(join(testsDir, 'helpers.ts'))).toBe(true);
    expect(await pathExists(join(testsDir, 'example.spec.ts'))).toBe(true);
    // Pre-existing config.ts left untouched.
    expect(await readFile(join(TEST_BASE, 'saifctl', 'config.ts'), 'utf8')).toBe('// pre-existing');
  });

  it('honours --test-profile to pick the language', async () => {
    await invokeInitTests({ 'project-dir': TEST_BASE, 'test-profile': 'python-pytest' });

    const testsDir = join(TEST_BASE, 'saifctl', 'tests');
    expect(await pathExists(join(testsDir, 'helpers.py'))).toBe(true);
    expect(await pathExists(join(testsDir, 'test_infra.py'))).toBe(true);
    expect(await pathExists(join(testsDir, 'test_example.py'))).toBe(true);
    // No node-vitest leakage.
    expect(await pathExists(join(testsDir, 'helpers.ts'))).toBe(false);
  });
});
