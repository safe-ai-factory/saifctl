/**
 * Unit tests for orchestrator option merge and model override parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaifctlConfig } from '../config/schema.js';
import { consola } from '../logger.js';
import type { OrchestratorOpts } from './modes.js';
import {
  applyEngineCliToOrchestratorOpts,
  normalizeStagingEnvironmentRaw,
  parseEngineCliSpec,
  parseModelOverridesCliDelta,
} from './options.js';

describe('parseModelOverridesCliDelta', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consolaErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // @ts-expect-error allow mock implementation of exit
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    consolaErrorSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consolaErrorSpy.mockRestore();
  });

  it('rejects unknown agent in --model', () => {
    parseModelOverridesCliDelta({ model: 'bad-agent=openai/gpt-4o' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consolaErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown agent "bad-agent"'),
    );
  });

  it('rejects unknown agent in --base-url', () => {
    // KEY_EQ_PATTERN (\w+=) only matches keys without hyphens; use badagent so it's parsed as key=value
    parseModelOverridesCliDelta({ 'base-url': 'badagent=https://api.example.com/v1' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consolaErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown agent "badagent"'),
    );
  });

  it('accepts valid agent names', () => {
    const overrides = parseModelOverridesCliDelta({
      model: 'coder=openai/gpt-4o,vague-specs-check=openai/gpt-4o-mini',
    });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(overrides).toBeDefined();
    expect(overrides!.agentModels).toEqual({
      coder: 'openai/gpt-4o',
      'vague-specs-check': 'openai/gpt-4o-mini',
    });
  });
});

describe('parseEngineCliSpec', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consolaErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // @ts-expect-error allow mock implementation of exit
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    consolaErrorSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consolaErrorSpy.mockRestore();
  });

  it('parses global docker for both phases', () => {
    expect(parseEngineCliSpec('docker')).toEqual({ coding: 'docker', staging: 'docker' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parses global local as coding=local and staging=docker', () => {
    expect(parseEngineCliSpec('local')).toEqual({ coding: 'local', staging: 'docker' });
  });

  it('parses coding=staging pair', () => {
    expect(parseEngineCliSpec('coding=docker,staging=helm')).toEqual({
      coding: 'docker',
      staging: 'helm',
    });
  });

  it('rejects staging=local', () => {
    parseEngineCliSpec('staging=local');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('applyEngineCliToOrchestratorOpts', () => {
  it('reuses staging from file when engine matches docker', () => {
    const config = {
      environments: {
        staging: { engine: 'docker' as const, file: 'ops/compose.yml' },
      },
    } as SaifctlConfig;

    const merged = {
      codingEnvironment: { engine: 'docker' as const },
      stagingEnvironment: normalizeStagingEnvironmentRaw({
        engine: 'helm',
        chart: 'other',
      }),
    } as unknown as OrchestratorOpts;

    applyEngineCliToOrchestratorOpts(merged, config, 'staging=docker');

    expect(merged.stagingEnvironment).toEqual(
      normalizeStagingEnvironmentRaw({
        engine: 'docker',
        file: 'ops/compose.yml',
      }),
    );
  });

  it('drops incompatible staging fields when switching to docker from helm-only file', () => {
    const config = {
      environments: {
        staging: { engine: 'helm' as const, chart: './chart' },
      },
    } as SaifctlConfig;

    const merged = {
      codingEnvironment: { engine: 'docker' as const },
      stagingEnvironment: normalizeStagingEnvironmentRaw({ engine: 'helm', chart: './chart' }),
    } as unknown as OrchestratorOpts;

    applyEngineCliToOrchestratorOpts(merged, config, 'staging=docker');

    expect(merged.stagingEnvironment).toEqual(normalizeStagingEnvironmentRaw({ engine: 'docker' }));
  });
});
