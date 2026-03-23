import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveAgentProfile,
  resolveAgentScriptPath,
  resolveAgentInstallScriptPath,
  SUPPORTED_AGENT_PROFILE_IDS,
  SUPPORTED_AGENT_PROFILES,
} from './index.js';

describe('agent profiles', () => {
  it('includes debug in supported ids', () => {
    expect(SUPPORTED_AGENT_PROFILE_IDS).toContain('debug');
  });

  it('resolves debug profile with raw log format', () => {
    const p = resolveAgentProfile('debug');
    expect(p.id).toBe('debug');
    expect(p.displayName).toBe('Debug (no LLM)');
    expect(p.defaultLogFormat).toBe('raw');
    expect(SUPPORTED_AGENT_PROFILES.debug).toBe(p);
  });

  it('resolves debug script paths under agent-profiles/debug', () => {
    expect(resolveAgentScriptPath('debug')).toMatch(/agent-profiles[/\\]debug[/\\]agent\.sh$/);
    expect(resolveAgentInstallScriptPath('debug')).toMatch(
      /agent-profiles[/\\]debug[/\\]agent-install\.sh$/,
    );
  });

  it('debug agent.sh writes dummy.md matching public dummy feature checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'saifac-debug-agent-'));
    try {
      const taskPath = join(dir, 'task.md');
      writeFileSync(taskPath, '# Task\n', 'utf8');
      execFileSync('bash', [resolveAgentScriptPath('debug')], {
        env: {
          ...process.env,
          SAIFAC_WORKSPACE_BASE: dir,
          SAIFAC_TASK_PATH: taskPath,
          SAIFAC_SKIP_NETWORK_PROBE: '1',
        },
        stdio: 'pipe',
      });
      const body = readFileSync(join(dir, 'dummy.md'), 'utf8');
      expect(body).toContain('# Dummy');
      expect(body).toMatch(/#+\s+Purpose/i);
      expect(body).toMatch(/#+\s+Structure/i);
      expect(body).toMatch(/#+\s+Next Steps/i);
      expect(body.split('\n').length).toBeLessThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('debug agent-install.sh exits 0 without installing tools', () => {
    execFileSync('bash', [resolveAgentInstallScriptPath('debug')], {
      env: { ...process.env },
      stdio: 'pipe',
    });
  });
});
