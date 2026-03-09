/**
 * Unit tests for agent-runner utilities.
 *
 * Focuses on the pure, side-effect-free helpers that can run without Docker
 * or the filesystem.
 */

import { describe, expect, it, vi } from 'vitest';

import { filterAgentEnv } from './agent-runner.js';

describe('filterAgentEnv', () => {
  it('passes through non-reserved keys unchanged', () => {
    const input = { AIDER_MODEL: 'gpt-4o', CUSTOM_KEY: 'hello' };
    expect(filterAgentEnv(input)).toEqual(input);
  });

  it('strips FACTORY_INITIAL_TASK', () => {
    const result = filterAgentEnv({ FACTORY_INITIAL_TASK: 'evil', SAFE: 'ok' });
    expect(result).not.toHaveProperty('FACTORY_INITIAL_TASK');
    expect(result).toHaveProperty('SAFE', 'ok');
  });

  it('strips all reserved FACTORY_* keys', () => {
    const reserved: Record<string, string> = {
      FACTORY_INITIAL_TASK: '1',
      FACTORY_GATE_RETRIES: '2',
      FACTORY_GATE_SCRIPT: '3',
      FACTORY_STARTUP_SCRIPT: '4',
      FACTORY_AGENT_SCRIPT: '5',
      FACTORY_TASK_PATH: '6',
    };
    const result = filterAgentEnv({ ...reserved, USER_KEY: 'keep' });
    for (const key of Object.keys(reserved)) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).toHaveProperty('USER_KEY', 'keep');
  });

  it('strips any FACTORY_ prefixed key (prefix-based blocking)', () => {
    const result = filterAgentEnv({ FACTORY_FUTURE_VAR: 'x', FACTORY_CUSTOM: 'y', SAFE: 'z' });
    expect(result).not.toHaveProperty('FACTORY_FUTURE_VAR');
    expect(result).not.toHaveProperty('FACTORY_CUSTOM');
    expect(result).toHaveProperty('SAFE', 'z');
  });

  it('strips WORKSPACE_BASE', () => {
    const result = filterAgentEnv({ WORKSPACE_BASE: '/workspace', KEEP: 'yes' });
    expect(result).not.toHaveProperty('WORKSPACE_BASE');
    expect(result).toHaveProperty('KEEP', 'yes');
  });

  it('strips LLM_API_KEY, LLM_MODEL, LLM_PROVIDER, and LLM_BASE_URL', () => {
    const result = filterAgentEnv({
      LLM_API_KEY: 'secret',
      LLM_MODEL: 'gpt-4o',
      LLM_PROVIDER: 'anthropic',
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      AGENT_SETTING: 'fine',
    });
    expect(result).not.toHaveProperty('LLM_API_KEY');
    expect(result).not.toHaveProperty('LLM_MODEL');
    expect(result).not.toHaveProperty('LLM_PROVIDER');
    expect(result).not.toHaveProperty('LLM_BASE_URL');
    expect(result).toHaveProperty('AGENT_SETTING', 'fine');
  });

  it('emits a console.warn for each stripped key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    filterAgentEnv({ FACTORY_INITIAL_TASK: 'x', LLM_API_KEY: 'y', SAFE: 'z' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('FACTORY_INITIAL_TASK');
    expect(warn.mock.calls[1][0]).toContain('LLM_API_KEY');
    warn.mockRestore();
  });

  it('returns an empty object when all keys are reserved', () => {
    const result = filterAgentEnv({ FACTORY_INITIAL_TASK: 'x', WORKSPACE_BASE: 'y' });
    expect(result).toEqual({});
  });

  it('returns an empty object when input is empty', () => {
    expect(filterAgentEnv({})).toEqual({});
  });
});
