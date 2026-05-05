/**
 * Integration tests for `saifctl run stop --force` (stuck status / paused without workspace path).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';

import { consola } from '../../logger.js';
import type { RunArtifact } from '../../runs/types.js';
import runCommand from './run.js';

const EXIT_SENTINEL = '__PROCESS_EXIT__';

function baseArtifact(
  overrides: Partial<RunArtifact> & Pick<RunArtifact, 'runId' | 'status'>,
): RunArtifact {
  const now = '2026-01-01T12:00:00.000Z';
  return {
    runId: overrides.runId,
    baseCommitSha: 'abc',
    runCommits: [],
    sandboxHostAppliedCommitCount: 0,
    subtasks: [
      {
        id: 'st-stop',
        content: 'work',
        status: 'pending',
        createdAt: '2026-01-01T12:00:00.000Z',
      },
    ],
    currentSubtaskIndex: 0,
    rules: [],
    config: {
      featureName: 'x',
      featureRelativePath: 'saifctl/features/x',
      gitProviderId: 'github',
      testProfileId: 'vitest',
      sandboxProfileId: 'vitest',
      agentProfileId: 'openhands',
      projectDir: '/tmp',
      maxAttemptsPerSubtask: 5,
      subtasks: [{ content: 'work' }],
      llm: {},
      saifctlDir: 'saifctl',
      projectName: 'p',
      testImage: 't',
      resolveAmbiguity: 'ai',
      dangerousNoLeash: false,
      cedarPolicyPath: '',
      cedarScript: '',
      coderImage: '',
      push: null,
      pr: false,
      includeDirty: false,
      gateRetries: 10,
      reviewerEnabled: true,
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      testScript: 't',
      gateScript: '#',
      startupScript: '#',
      agentInstallScript: '#',
      agentScript: '#',
      stageScript: '#',
      startupScriptFile: 's/startup.sh',
      gateScriptFile: 's/gate.sh',
      stageScriptFile: 's/stage.sh',
      testScriptFile: 's/test.sh',
      agentInstallScriptFile: 's/agent-install.sh',
      agentScriptFile: 's/agent.sh',
      testRetries: 1,
      stagingEnvironment: {
        engine: 'docker',
        app: { sidecarPort: 8080, sidecarPath: '/exec' },
        appEnvironment: {},
      },
      codingEnvironment: { engine: 'docker' },
    },
    status: overrides.status,
    startedAt: now,
    updatedAt: now,
    controlSignal: overrides.controlSignal ?? null,
    pausedSandboxBasePath: overrides.pausedSandboxBasePath ?? null,
    liveInfra: overrides.liveInfra ?? null,
    inspectSession: overrides.inspectSession ?? null,
    artifactRevision: overrides.artifactRevision,
  };
}

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-run-stop-f-'));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function writeRunFile(projectDir: string, artifact: RunArtifact): Promise<void> {
  const dir = join(projectDir, '.saifctl', 'runs');
  await mkdir(dir, { recursive: true });
  const { runId } = artifact;
  await writeFile(join(dir, `${runId}.json`), JSON.stringify(artifact), 'utf8');
}

async function readRunStatus(projectDir: string, runId: string): Promise<string | undefined> {
  const raw = await readFile(join(projectDir, '.saifctl', 'runs', `${runId}.json`), 'utf8');
  const o = JSON.parse(raw) as { status?: string };
  return o.status;
}

async function runRunSubcommand(rawArgs: string[]): Promise<void> {
  const logSpy = vi.spyOn(consola, 'log').mockImplementation(() => {});
  const warnSpy = vi.spyOn(consola, 'warn').mockImplementation(() => {});
  const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
  }) as never);
  try {
    await cittyRunCommand(runCommand, { rawArgs });
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('saifctl run stop --force', () => {
  it('marks a stuck Stopping run as failed', async () => {
    await withTempProject(async (projectDir) => {
      const runId = 'stuck-stop';
      await writeRunFile(
        projectDir,
        baseArtifact({
          runId,
          status: 'stopping',
          controlSignal: { action: 'stop', requestedAt: '2026-01-02T00:00:00.000Z' },
          artifactRevision: 1,
        }),
      );

      await runRunSubcommand(['stop', runId, '--force', '--project-dir', projectDir]);

      expect(await readRunStatus(projectDir, runId)).toBe('failed');
    });
  });

  it('clears infra on completed run without changing status', async () => {
    await withTempProject(async (projectDir) => {
      const runId = 'done-cleanup';
      await writeRunFile(
        projectDir,
        baseArtifact({
          runId,
          status: 'completed',
          liveInfra: { coding: null, staging: null },
          artifactRevision: 3,
        }),
      );

      await runRunSubcommand(['stop', runId, '-f', '--project-dir', projectDir]);

      expect(await readRunStatus(projectDir, runId)).toBe('completed');
      const raw = JSON.parse(
        await readFile(join(projectDir, '.saifctl', 'runs', `${runId}.json`), 'utf8'),
      ) as { liveInfra: unknown; controlSignal: unknown };
      expect(raw.liveInfra).toBeNull();
      expect(raw.controlSignal).toBeNull();
    });
  });
});
