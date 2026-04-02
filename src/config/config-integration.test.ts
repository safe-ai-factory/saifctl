/**
 * Integration tests: create real config files (config.json, config.js) and verify
 * that loadSaifctlConfig + read/resolve helpers use the config values correctly.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readStorageStringFromCli, resolveStorageOverrides } from '../cli/utils.js';
import {
  llmOverridesFromSaifctlConfig,
  mergeLlmOverridesLayers,
  parseLlmOverridesCliDelta,
} from '../orchestrator/options.js';
import { writeUtf8 } from '../utils/io.js';
import { loadSaifctlConfig } from './load.js';

async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `saifctl-config-int-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('config integration', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await makeTempDir();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  describe('config.json', () => {
    it('resolveStorageOverrides uses globalStorage and storages from config', async () => {
      const saifctlDir = join(projectDir, 'saifctl');
      await mkdir(saifctlDir, { recursive: true });
      await writeUtf8(
        join(saifctlDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalStorage: 'memory',
            storages: { runs: 'local', tasks: 's3://bucket/tasks' },
          },
        }),
      );

      const config = await loadSaifctlConfig('saifctl', projectDir);
      const overrides = resolveStorageOverrides(readStorageStringFromCli({}), config);

      expect(overrides.globalStorage).toBe('memory');
      expect(overrides.storages).toEqual({ runs: 'local', tasks: 's3://bucket/tasks' });
    });

    it('resolveStorageOverrides: CLI overrides config', async () => {
      const saifctlDir = join(projectDir, 'saifctl');
      await mkdir(saifctlDir, { recursive: true });
      await writeUtf8(
        join(saifctlDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalStorage: 'memory',
            storages: { runs: 'local' },
          },
        }),
      );

      const config = await loadSaifctlConfig('saifctl', projectDir);
      const overrides = resolveStorageOverrides(
        readStorageStringFromCli({ storage: 'runs=s3' }),
        config,
      );

      expect(overrides.storages?.runs).toBe('s3');
      expect(overrides.globalStorage).toBe('memory'); // CLI didn't override global
    });

    it('mergeLlmOverridesLayers uses globalModel and agentModels from config', async () => {
      const saifctlDir = join(projectDir, 'saifctl');
      await mkdir(saifctlDir, { recursive: true });
      await writeUtf8(
        join(saifctlDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalModel: 'anthropic/claude-sonnet-4',
            agentModels: { coder: 'openai/gpt-4o', 'vague-specs-check': 'openai/gpt-4o-mini' },
          },
        }),
      );

      const config = await loadSaifctlConfig('saifctl', projectDir);
      const llm = mergeLlmOverridesLayers(
        llmOverridesFromSaifctlConfig(config),
        undefined,
        parseLlmOverridesCliDelta({}),
      );

      expect(llm.globalModel).toBe('anthropic/claude-sonnet-4');
      expect(llm.agentModels).toEqual({
        coder: 'openai/gpt-4o',
        'vague-specs-check': 'openai/gpt-4o-mini',
      });
    });
  });

  describe('config.js', () => {
    it('loads config.js and resolveStorageOverrides uses values', async () => {
      const saifctlDir = join(projectDir, 'saifctl');
      await mkdir(saifctlDir, { recursive: true });
      // Use config.js (no config.json) so cosmiconfig picks .js
      await writeUtf8(
        join(saifctlDir, 'config.js'),
        "module.exports = { defaults: { globalStorage: 'memory', storages: { runs: 'local' } } };",
      );

      const config = await loadSaifctlConfig('saifctl', projectDir);
      expect(config.defaults?.globalStorage).toBe('memory');

      const overrides = resolveStorageOverrides(readStorageStringFromCli({}), config);
      expect(overrides.globalStorage).toBe('memory');
      expect(overrides.storages?.runs).toBe('local');
    });
  });
});
