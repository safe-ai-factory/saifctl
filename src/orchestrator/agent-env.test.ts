import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { consola } from '../logger.js';
import {
  buildCoderContainerEnv,
  filterAgentEnv,
  filterAgentSecretKeyNames,
  filterAgentSecretPairs,
  resolveAgentSecretEnv,
} from './agent-env.js';

describe('filterAgentEnv', () => {
  it('passes through non-reserved keys unchanged', () => {
    const input = { AIDER_MODEL: 'gpt-4o', CUSTOM_KEY: 'hello' };
    expect(filterAgentEnv(input)).toEqual(input);
  });

  it('strips SAIFCTL_INITIAL_TASK', () => {
    const result = filterAgentEnv({ SAIFCTL_INITIAL_TASK: 'evil', SAFE: 'ok' });
    expect(result).not.toHaveProperty('SAIFCTL_INITIAL_TASK');
    expect(result).toHaveProperty('SAFE', 'ok');
  });

  it('strips all reserved SAIFCTL_* keys', () => {
    const reserved: Record<string, string> = {
      SAIFCTL_INITIAL_TASK: '1',
      SAIFCTL_GATE_RETRIES: '2',
      SAIFCTL_GATE_SCRIPT: '3',
      SAIFCTL_REVIEWER_ENABLED: '1',
      SAIFCTL_STARTUP_SCRIPT: '4',
      SAIFCTL_AGENT_INSTALL_SCRIPT: '5',
      SAIFCTL_AGENT_SCRIPT: '6',
      SAIFCTL_TASK_PATH: '7',
      SAIFCTL_RUN_ID: '8',
    };
    const result = filterAgentEnv({ ...reserved, USER_KEY: 'keep' });
    for (const key of Object.keys(reserved)) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).toHaveProperty('USER_KEY', 'keep');
  });

  it('strips any SAIFCTL_ prefixed key (prefix-based blocking)', () => {
    const result = filterAgentEnv({ SAIFCTL_FUTURE_VAR: 'x', SAIFCTL_CUSTOM: 'y', SAFE: 'z' });
    expect(result).not.toHaveProperty('SAIFCTL_FUTURE_VAR');
    expect(result).not.toHaveProperty('SAIFCTL_CUSTOM');
    expect(result).toHaveProperty('SAFE', 'z');
  });

  it('strips SAIFCTL_WORKSPACE_BASE', () => {
    const result = filterAgentEnv({ SAIFCTL_WORKSPACE_BASE: '/workspace', KEEP: 'yes' });
    expect(result).not.toHaveProperty('SAIFCTL_WORKSPACE_BASE');
    expect(result).toHaveProperty('KEEP', 'yes');
  });

  it('strips UV_NATIVE_TLS (factory-controlled)', () => {
    const result = filterAgentEnv({ UV_NATIVE_TLS: '0', KEEP: 'yes' });
    expect(result).not.toHaveProperty('UV_NATIVE_TLS');
    expect(result).toHaveProperty('KEEP', 'yes');
  });

  it('strips SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, NODE_EXTRA_CA_CERTS (factory-controlled)', () => {
    const result = filterAgentEnv({
      SSL_CERT_FILE: '/tmp/evil.pem',
      REQUESTS_CA_BUNDLE: '/tmp/evil2.pem',
      CURL_CA_BUNDLE: '/tmp/evil3.pem',
      NODE_EXTRA_CA_CERTS: '/tmp/evil4.pem',
      KEEP: 'yes',
    });
    expect(result).not.toHaveProperty('SSL_CERT_FILE');
    expect(result).not.toHaveProperty('REQUESTS_CA_BUNDLE');
    expect(result).not.toHaveProperty('CURL_CA_BUNDLE');
    expect(result).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
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

  it('strips REVIEWER_LLM_API_KEY, REVIEWER_LLM_MODEL, REVIEWER_LLM_PROVIDER, and REVIEWER_LLM_BASE_URL', () => {
    const result = filterAgentEnv({
      REVIEWER_LLM_API_KEY: 'secret',
      REVIEWER_LLM_MODEL: 'gpt-4o',
      REVIEWER_LLM_PROVIDER: 'anthropic',
      REVIEWER_LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      AGENT_SETTING: 'fine',
    });
    expect(result).not.toHaveProperty('REVIEWER_LLM_API_KEY');
    expect(result).not.toHaveProperty('REVIEWER_LLM_MODEL');
    expect(result).not.toHaveProperty('REVIEWER_LLM_PROVIDER');
    expect(result).not.toHaveProperty('REVIEWER_LLM_BASE_URL');
    expect(result).toHaveProperty('AGENT_SETTING', 'fine');
  });

  it('emits a consola.warn for each stripped key', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    filterAgentEnv({ SAIFCTL_INITIAL_TASK: 'x', LLM_API_KEY: 'y', SAFE: 'z' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('SAIFCTL_INITIAL_TASK');
    expect(warn.mock.calls[1][0]).toContain('LLM_API_KEY');
    warn.mockRestore();
  });

  it('returns an empty object when all keys are reserved', () => {
    const result = filterAgentEnv({ SAIFCTL_INITIAL_TASK: 'x', SAIFCTL_WORKSPACE_BASE: 'y' });
    expect(result).toEqual({});
  });

  it('returns an empty object when input is empty', () => {
    expect(filterAgentEnv({})).toEqual({});
  });
});

describe('filterAgentSecretKeyNames', () => {
  it('passes through valid key names', () => {
    expect(filterAgentSecretKeyNames(['MY_TOKEN', 'OTHER_KEY'])).toEqual(['MY_TOKEN', 'OTHER_KEY']);
  });

  it('strips reserved and SAIFCTL_ keys', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    expect(filterAgentSecretKeyNames(['SAFE', 'LLM_API_KEY', 'SAIFCTL_FOO'])).toEqual(['SAFE']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveAgentSecretEnv', () => {
  it('copies values from process.env for allowed keys', () => {
    const key = 'AGENT_ENV_TEST_RESOLVE_KEY';
    const prev = process.env[key];
    process.env[key] = 'secret-value';
    try {
      expect(resolveAgentSecretEnv([key])).toEqual({ [key]: 'secret-value' });
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});

describe('filterAgentSecretPairs', () => {
  it('drops reserved keys like filterAgentEnv', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const out = filterAgentSecretPairs({ MY_TOKEN: 'a', LLM_API_KEY: 'b', KEEP: 'c' });
    expect(out).toEqual({ MY_TOKEN: 'a', KEEP: 'c' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('buildCoderContainerEnv + agentSecretKeys', () => {
  it('applies filterAgentEnv to agentEnv (reserved keys never reach env)', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: { LLM_MODEL: 'user-override', CUSTOM: 'ok' },
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 't',
      gateRetries: 1,
      runId: 'r',
      enableSubtaskSequence: false,
    });
    expect(c.env).not.toHaveProperty('LLM_MODEL', 'user-override');
    expect(c.env.LLM_MODEL).toBe('anthropic/m');
    expect(c.env.CUSTOM).toBe('ok');
    expect(c.env.UV_NATIVE_TLS).toBe('1');
    expect(c.env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(c.env.REQUESTS_CA_BUNDLE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(c.env.CURL_CA_BUNDLE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(c.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('forces UV_NATIVE_TLS=1 even if agentEnv tries to disable it', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: { UV_NATIVE_TLS: '0' },
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 't',
      gateRetries: 1,
      runId: 'r',
      enableSubtaskSequence: false,
    });
    expect(c.env.UV_NATIVE_TLS).toBe('1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('forces Debian CA bundle for container mode even if agentEnv sets SSL_CERT_FILE', async () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: { SSL_CERT_FILE: '/tmp/user.pem' },
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 't',
      gateRetries: 1,
      runId: 'r',
      enableSubtaskSequence: false,
    });
    expect(c.env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(c.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('merges file-based secrets then host keys (host wins on duplicate)', async () => {
    const key = 'AGENT_ENV_TEST_FILE_HOST_DUP';
    const dir = mkdtempSync(join(tmpdir(), 'saifctl-coder-env-'));
    writeFileSync(join(dir, 'secrets.env'), `${key}=from-file\n`, 'utf8');
    const prev = process.env[key];
    process.env[key] = 'from-host';
    try {
      const c = await buildCoderContainerEnv({
        mode: { kind: 'container' },
        llmConfig: {
          modelId: 'm',
          provider: 'anthropic',
          fullModelString: 'anthropic/m',
          apiKey: 'k',
        },
        reviewer: null,
        agentEnv: {},
        projectDir: dir,
        agentSecretKeys: [key],
        agentSecretFiles: ['secrets.env'],
        taskPrompt: 't',
        gateRetries: 1,
        runId: 'r',
        enableSubtaskSequence: false,
      });
      expect(c.secretEnv[key]).toBe('from-host');
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it('merges resolved agent secrets into secretEnv', async () => {
    const key = 'AGENT_ENV_TEST_BUILD_CODER_KEY';
    const prev = process.env[key];
    process.env[key] = 'from-host';
    try {
      const c = await buildCoderContainerEnv({
        mode: { kind: 'container' },
        llmConfig: {
          modelId: 'm',
          provider: 'anthropic',
          fullModelString: 'anthropic/m',
          apiKey: 'k',
        },
        reviewer: null,
        agentEnv: {},
        projectDir: process.cwd(),
        agentSecretKeys: [key],
        agentSecretFiles: [],
        taskPrompt: 't',
        gateRetries: 1,
        runId: 'r',
        enableSubtaskSequence: false,
      });
      expect(c.secretEnv[key]).toBe('from-host');
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it('sets subtask signal paths and sequence flag when enableSubtaskSequence is true (container mode)', async () => {
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: {},
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 't',
      gateRetries: 1,
      runId: 'r',
      enableSubtaskSequence: true,
    });
    expect(c.env.SAIFCTL_ENABLE_SUBTASK_SEQUENCE).toBe('1');
    expect(c.env.SAIFCTL_SUBTASK_DONE_PATH).toBe('/workspace/.saifctl/subtask-done');
    expect(c.env.SAIFCTL_NEXT_SUBTASK_PATH).toBe('/workspace/.saifctl/subtask-next.md');
    expect(c.env.SAIFCTL_SUBTASK_EXIT_PATH).toBe('/workspace/.saifctl/subtask-exit');
    expect(c.env.SAIFCTL_SUBTASK_RETRIES_PATH).toBe('/workspace/.saifctl/subtask-retries');
  });

  it('omits SAIFCTL_ENABLE_SUBTASK_SEQUENCE when enableSubtaskSequence is false', async () => {
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: {},
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 't',
      gateRetries: 1,
      runId: 'r',
      enableSubtaskSequence: false,
    });
    expect(c.env.SAIFCTL_ENABLE_SUBTASK_SEQUENCE).toBeUndefined();
  });

  it('omits task, gate, and subtask env when sandboxInteractive is true (container mode)', async () => {
    const c = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: {
        modelId: 'm',
        provider: 'anthropic',
        fullModelString: 'anthropic/m',
        apiKey: 'k',
      },
      reviewer: null,
      agentEnv: {},
      projectDir: process.cwd(),
      agentSecretKeys: [],
      agentSecretFiles: [],
      taskPrompt: 'should-not-appear',
      gateRetries: 99,
      runId: 'r',
      enableSubtaskSequence: true,
      sandboxInteractive: true,
    });
    expect(c.env.SAIFCTL_INITIAL_TASK).toBeUndefined();
    expect(c.env.SAIFCTL_GATE_RETRIES).toBeUndefined();
    expect(c.env.SAIFCTL_AGENT_SCRIPT).toBeUndefined();
    expect(c.env.SAIFCTL_SUBTASK_DONE_PATH).toBeUndefined();
    expect(c.env.SAIFCTL_ENABLE_SUBTASK_SEQUENCE).toBeUndefined();
    expect(c.env.SAIFCTL_RUN_ID).toBe('r');
    expect(c.env.LLM_MODEL).toBe('anthropic/m');
    expect(c.env.SAIFCTL_STARTUP_SCRIPT).toBe('/saifctl/startup.sh');
    expect(c.env.SAIFCTL_AGENT_INSTALL_SCRIPT).toBe('/saifctl/agent-install.sh');
  });
});
