/**
 * Integration tests: create real config files (config.json, config.js) and verify
 * that loadSaifConfig + parse* functions use the config values correctly.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseMaxRuns,
  parseModelOverrides,
  parseResolveAmbiguity,
  parseStorageOverrides,
} from '../cli/utils.js';
import { writeUtf8 } from '../utils/io.js';
import { loadSaifConfig } from './load.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `saifac-config-int-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('config integration', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('config.json', () => {
    it('parseStorageOverrides uses globalStorage and storages from config', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(
        join(saifDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalStorage: 'memory',
            storages: { runs: 'local', tasks: 's3://bucket/tasks' },
          },
        }),
      );

      const config = await loadSaifConfig('saifac', projectDir);
      const overrides = parseStorageOverrides({}, config);

      expect(overrides.globalStorage).toBe('memory');
      expect(overrides.storages).toEqual({ runs: 'local', tasks: 's3://bucket/tasks' });
    });

    it('parseStorageOverrides: CLI overrides config', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(
        join(saifDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalStorage: 'memory',
            storages: { runs: 'local' },
          },
        }),
      );

      const config = await loadSaifConfig('saifac', projectDir);
      const overrides = parseStorageOverrides({ storage: 'runs=s3' }, config);

      expect(overrides.storages?.runs).toBe('s3');
      expect(overrides.globalStorage).toBe('memory'); // CLI didn't override global
    });

    it('parseMaxRuns uses config when CLI has no value', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(join(saifDir, 'config.json'), JSON.stringify({ defaults: { maxRuns: 12 } }));

      const config = await loadSaifConfig('saifac', projectDir);
      const maxRuns = parseMaxRuns({}, config);

      expect(maxRuns).toBe(12);
    });

    it('parseMaxRuns: CLI overrides config', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(join(saifDir, 'config.json'), JSON.stringify({ defaults: { maxRuns: 12 } }));

      const config = await loadSaifConfig('saifac', projectDir);
      const maxRuns = parseMaxRuns({ 'max-runs': '3' }, config);

      expect(maxRuns).toBe(3);
    });

    it('parseResolveAmbiguity uses config when CLI has no value', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(
        join(saifDir, 'config.json'),
        JSON.stringify({ defaults: { resolveAmbiguity: 'off' } }),
      );

      const config = await loadSaifConfig('saifac', projectDir);
      const val = parseResolveAmbiguity({}, config);

      expect(val).toBe('off');
    });

    it('parseModelOverrides uses globalModel and agentModels from config', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(
        join(saifDir, 'config.json'),
        JSON.stringify({
          defaults: {
            globalModel: 'anthropic/claude-sonnet-4',
            agentModels: { coder: 'openai/gpt-4o', 'vague-specs-check': 'openai/gpt-4o-mini' },
          },
        }),
      );

      const config = await loadSaifConfig('saifac', projectDir);
      const overrides = parseModelOverrides({}, config);

      expect(overrides.globalModel).toBe('anthropic/claude-sonnet-4');
      expect(overrides.agentModels).toEqual({
        coder: 'openai/gpt-4o',
        'vague-specs-check': 'openai/gpt-4o-mini',
      });
    });
  });

  describe('config.js', () => {
    it('loads config.js and parseStorageOverrides uses values', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      // Use config.js (no config.json) so cosmiconfig picks .js
      await writeUtf8(
        join(saifDir, 'config.js'),
        "module.exports = { defaults: { globalStorage: 'memory', storages: { runs: 'local' } } };",
      );

      const config = await loadSaifConfig('saifac', projectDir);
      expect(config.defaults?.globalStorage).toBe('memory');

      const overrides = parseStorageOverrides({}, config);
      expect(overrides.globalStorage).toBe('memory');
      expect(overrides.storages?.runs).toBe('local');
    });

    it('loads config.js and parseMaxRuns uses value', async () => {
      const saifDir = join(projectDir, 'saifac');
      mkdirSync(saifDir, { recursive: true });
      await writeUtf8(
        join(saifDir, 'config.js'),
        "module.exports = { defaults: { maxRuns: 8, resolveAmbiguity: 'prompt' } };",
      );

      const config = await loadSaifConfig('saifac', projectDir);
      expect(parseMaxRuns({}, config)).toBe(8);
      expect(parseResolveAmbiguity({}, config)).toBe('prompt');
    });
  });
});
