/**
 * Integration tests for `saifctl run info`.
 * `--no-pretty` is citty’s negation of the `pretty` boolean (default true).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';

import * as loggerModule from '../../logger.js';
import runCommand from './run.js';

const EXIT_SENTINEL = '__PROCESS_EXIT__';

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-run-info-'));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

/** Minimal Run JSON (matches LocalStorage layout). */
async function writeRunJson(projectDir: string, runId: string): Promise<void> {
  const dir = join(projectDir, '.saifctl', 'runs');
  await mkdir(dir, { recursive: true });
  const doc = {
    runId,
    baseCommitSha: 'abc',
    basePatchDiff: 'SECRET_BASE',
    runCommits: [{ message: 'm', diff: 'SECRET_RUN' }],
    specRef: 'saifctl/features/x',
    config: {
      featureName: 'feat-x',
      gitProviderId: 'github',
      testProfileId: 'vitest',
      sandboxProfileId: 'vitest',
      agentProfileId: 'openhands',
      projectDir: '/tmp',
      maxRuns: 5,
      llm: {},
      saifctlDir: 'saifctl',
      projectName: 'test',
      testImage: 'test:latest',
      resolveAmbiguity: 'ai',
      dangerousNoLeash: false,
      cedarPolicyPath: '',
      cedarScript: '// cedar',
      coderImage: '',
      push: null,
      pr: false,
      gateRetries: 10,
      reviewerEnabled: true,
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      testScript: 'TEST_CONTENT',
      gateScript: 'GATE_CONTENT',
      startupScript: 'START_CONTENT',
      agentInstallScript: 'INSTALL_CONTENT',
      agentScript: 'AGENT_CONTENT',
      stageScript: 'STAGE_CONTENT',
      startupScriptFile: 'sandbox/startup.sh',
      gateScriptFile: 'sandbox/gate.sh',
      stageScriptFile: 'sandbox/stage.sh',
      testScriptFile: 'sandbox/test.sh',
      agentInstallScriptFile: 'sandbox/install.sh',
      agentScriptFile: 'sandbox/agent.sh',
      testRetries: 1,
      stagingEnvironment: {
        engine: 'docker',
        app: { sidecarPort: 8080, sidecarPath: '/exec' },
        appEnvironment: {},
      },
      codingEnvironment: { engine: 'docker' },
    },
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  await writeFile(join(dir, `${runId}.json`), JSON.stringify(doc), 'utf8');
}

interface RunCapture {
  logs: string[];
  errors: string[];
  exitCode: number | undefined;
}

async function runRunSubcommand(rawArgs: string[]): Promise<RunCapture> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(loggerModule, 'outputCliData').mockImplementation((msg: string) => {
    logs.push(msg);
  });
  const errSpy = vi.spyOn(loggerModule.consola, 'error').mockImplementation((msg?: unknown) => {
    errors.push(msg == null ? '' : String(msg));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
  }) as never);
  try {
    await cittyRunCommand(runCommand, { rawArgs });
    return { logs, errors, exitCode: undefined };
  } catch (e) {
    if (e instanceof Error && e.message === EXIT_SENTINEL && 'exitCode' in e) {
      return { logs, errors, exitCode: (e as Error & { exitCode: number }).exitCode };
    }
    throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('saifctl run info', () => {
  it('prints pretty JSON without diffs or script bodies; keeps script paths', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'ins1');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'info',
        'ins1',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      const text = logs[0]!;
      expect(text).toContain('\n');
      const parsed = JSON.parse(text) as {
        config: Record<string, unknown>;
        runCommits?: unknown[];
      };

      expect(parsed.config.startupScriptFile).toBe('sandbox/startup.sh');
      expect(parsed.config).not.toHaveProperty('startupScript');
      expect(parsed).not.toHaveProperty('basePatchDiff');
      expect(parsed.runCommits).toEqual([{ message: 'm' }]);
      expect(text).not.toContain('SECRET_BASE');
      expect(text).not.toContain('SECRET_RUN');
      expect(text).not.toContain('START_CONTENT');
    });
  });

  it('prints single-line JSON with --no-pretty', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'ins2');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'info',
        'ins2',
        '--project-dir',
        projectDir,
        '--no-pretty',
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      const text = logs[0]!;
      expect(text).not.toContain('\n');
      const parsed = JSON.parse(text) as { runId: string };
      expect(parsed.runId).toBe('ins2');
    });
  });

  it('errors when run not found', async () => {
    await withTempProject(async (projectDir) => {
      const { logs, errors, exitCode } = await runRunSubcommand([
        'info',
        'missing',
        '--project-dir',
        projectDir,
      ]);

      expect(logs).toEqual([]);
      expect(errors.some((e) => e.includes('Run not found: missing'))).toBe(true);
      expect(exitCode).toBe(1);
    });
  });

  it('errors when --storage none', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'x');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'info',
        'x',
        '--project-dir',
        projectDir,
        '--storage',
        'none',
      ]);

      expect(logs).toEqual([]);
      expect(errors.some((e) => e.includes('Run storage is disabled'))).toBe(true);
      expect(exitCode).toBe(1);
    });
  });
});
