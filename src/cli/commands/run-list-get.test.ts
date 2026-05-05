/**
 * Integration tests for `saifctl run list --format json` and `saifctl run get`.
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
  const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-run-list-get-'));
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
    subtasks: [
      {
        id: `st-${runId}`,
        title: 'feat-x',
        content: 'task',
        status: 'pending' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    currentSubtaskIndex: 0,
    rules: [],
    config: {
      featureName: 'feat-x',
      featureRelativePath: 'saifctl/features/x',
      gitProviderId: 'github',
      testProfileId: 'vitest',
      sandboxProfileId: 'vitest',
      agentProfileId: 'openhands',
      projectDir: '/tmp',
      maxAttemptsPerSubtask: 5,
      subtasks: [{ content: 'task' }],
      llm: {},
      saifctlDir: 'saifctl',
      projectName: 'test',
      testImage: 'test:latest',
      resolveAmbiguity: 'ai',
      dangerousNoLeash: false,
      cedarPolicyPath: '',
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
    controlSignal: null,
    pausedSandboxBasePath: null,
    liveInfra: null,
    inspectSession: null,
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

describe('saifctl run list --format json', () => {
  it('prints JSON array with run summaries', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'lst1');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'list',
        '--format',
        'json',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      const parsed = JSON.parse(logs[0]!) as Array<Record<string, unknown>>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        runId: 'lst1',
        featureName: 'feat-x',
        specRef: 'saifctl/features/x',
        featureRelativePath: 'saifctl/features/x',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(parsed[0]).not.toHaveProperty('runCommits');
      expect(logs[0]).toContain('\n');
    });
  });

  it('prints compact JSON with --no-pretty', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'lst2');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'list',
        '--format',
        'json',
        '--no-pretty',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain('\n');
      const parsed = JSON.parse(logs[0]!) as unknown[];
      expect(parsed).toHaveLength(1);
    });
  });

  it('prints [] when no runs', async () => {
    await withTempProject(async (projectDir) => {
      const { logs, errors, exitCode } = await runRunSubcommand([
        'list',
        '--format',
        'json',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toEqual(['[]']);
    });
  });

  it('prints null when storage disabled', async () => {
    await withTempProject(async (projectDir) => {
      const { logs, errors, exitCode } = await runRunSubcommand([
        'list',
        '--format',
        'json',
        '--project-dir',
        projectDir,
        '--storage',
        'none',
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toEqual(['null']);
    });
  });

  it('errors on invalid --format', async () => {
    await withTempProject(async (projectDir) => {
      const { logs, errors, exitCode } = await runRunSubcommand([
        'list',
        '--format',
        'yaml',
        '--project-dir',
        projectDir,
      ]);

      expect(logs).toEqual([]);
      expect(errors.some((e) => e.includes('Invalid --format'))).toBe(true);
      expect(exitCode).toBe(1);
    });
  });
});

describe('saifctl run get', () => {
  it('prints full artifact JSON including diffs', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'get1');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'get',
        'get1',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      const text = logs[0]!;
      expect(text).toContain('SECRET_BASE');
      expect(text).toContain('SECRET_RUN');
      const parsed = JSON.parse(text) as {
        runId: string;
        basePatchDiff: string;
        runCommits: Array<{ diff: string }>;
        subtasks: Array<{ content: string }>;
        currentSubtaskIndex: number;
      };
      expect(parsed.runId).toBe('get1');
      expect(parsed.basePatchDiff).toBe('SECRET_BASE');
      expect(parsed.runCommits[0]?.diff).toBe('SECRET_RUN');
      expect(parsed.subtasks).toHaveLength(1);
      expect(parsed.subtasks[0]?.content).toBe('task');
      expect(parsed.currentSubtaskIndex).toBe(0);
      expect(parsed).not.toHaveProperty('specRef');
    });
  });

  it('prints single-line JSON with --no-pretty', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'get2');

      const { logs, errors, exitCode } = await runRunSubcommand([
        'get',
        'get2',
        '--project-dir',
        projectDir,
        '--no-pretty',
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain('\n');
      const parsed = JSON.parse(logs[0]!) as { runId: string };
      expect(parsed.runId).toBe('get2');
    });
  });

  it('errors when run not found', async () => {
    await withTempProject(async (projectDir) => {
      const { logs, errors, exitCode } = await runRunSubcommand([
        'get',
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
        'get',
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
