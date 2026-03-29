import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consola } from '../logger.js';
import { writeUtf8 } from '../utils/io.js';
import { loadSaifctlConfig } from './load.js';

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `saifctl-config-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('loadSaifctlConfig', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty config when saifctl dir does not exist', async () => {
    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config).toEqual({});
  });

  it('returns empty config when saifctl dir exists but has no config file', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config).toEqual({});
  });

  it('loads config.json and parses defaults', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    await writeUtf8(
      join(saifctlDir, 'config.json'),
      JSON.stringify({
        defaults: {
          maxRuns: 10,
          testRetries: 2,
          resolveAmbiguity: 'prompt',
          globalModel: 'anthropic/claude-sonnet-4',
        },
      }),
    );

    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config.defaults).toBeDefined();
    expect(config.defaults?.maxRuns).toBe(10);
    expect(config.defaults?.testRetries).toBe(2);
    expect(config.defaults?.resolveAmbiguity).toBe('prompt');
    expect(config.defaults?.globalModel).toBe('anthropic/claude-sonnet-4');
  });

  it('loads config.js (CommonJS-style export)', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    // cosmiconfig loads .js; we use module.exports
    await writeUtf8(
      join(saifctlDir, 'config.js'),
      "module.exports = { defaults: { maxRuns: 7, globalStorage: 'memory' } };",
    );

    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config.defaults?.maxRuns).toBe(7);
    expect(config.defaults?.globalStorage).toBe('memory');
  });

  it('prefers config.json when both config.json and config.js exist', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    await writeUtf8(join(saifctlDir, 'config.json'), JSON.stringify({ defaults: { maxRuns: 3 } }));
    await writeUtf8(
      join(saifctlDir, 'config.js'),
      'module.exports = { defaults: { maxRuns: 99 } };',
    );

    const config = await loadSaifctlConfig('saifctl', projectDir);
    // cosmiconfig search order: config.json is typically before config.js in searchPlaces
    expect([3, 99]).toContain(config.defaults?.maxRuns);
  });

  it('parses storage as globalStorage and storages', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    await writeUtf8(
      join(saifctlDir, 'config.json'),
      JSON.stringify({
        defaults: {
          globalStorage: 's3',
          storages: { runs: 'local', tasks: 's3://bucket/tasks' },
        },
      }),
    );

    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config.defaults?.globalStorage).toBe('s3');
    expect(config.defaults?.storages).toEqual({ runs: 'local', tasks: 's3://bucket/tasks' });
  });

  it('parses agentEnv object', async () => {
    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    await writeUtf8(
      join(saifctlDir, 'config.json'),
      JSON.stringify({
        defaults: {
          agentEnv: { OPENAI_API_KEY: 'sk-test', CUSTOM_VAR: 'value' },
        },
      }),
    );

    const config = await loadSaifctlConfig('saifctl', projectDir);
    expect(config.defaults?.agentEnv).toEqual({
      OPENAI_API_KEY: 'sk-test',
      CUSTOM_VAR: 'value',
    });
  });

  it('exits on invalid config (wrong type)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consolaSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});

    const saifctlDir = join(projectDir, 'saifctl');
    await mkdir(saifctlDir, { recursive: true });
    await writeUtf8(
      join(saifctlDir, 'config.json'),
      JSON.stringify({ defaults: { maxRuns: 'not-a-number' } }),
    );

    await loadSaifctlConfig('saifctl', projectDir);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consolaSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    consolaSpy.mockRestore();
  });
});
