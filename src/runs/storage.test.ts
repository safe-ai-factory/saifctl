import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRunStorage } from './storage.js';
import {
  RunAlreadyRunningError,
  type RunArtifact,
  RunCannotPauseError,
  RunCannotStopError,
  StaleArtifactError,
} from './types.js';

const dummyArtifact: RunArtifact = {
  runId: 'test-1',
  baseCommitSha: 'abc123',
  runCommits: [{ message: 'm', diff: 'diff' }],
  specRef: 'saifctl/features/x',
  rules: [],
  config: {
    featureName: 'x',
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
    testScript: 'test',
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
    codingEnvironment: {
      engine: 'docker',
    },
  },
  status: 'failed',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  controlSignal: null,
  pausedSandboxBasePath: null,
  liveInfra: null,
  inspectSession: null,
};

describe('createRunStorage', () => {
  it('returns null for none', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      expect(createRunStorage('none', tmp)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns RunStorage for local', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp);
      expect(storage).not.toBeNull();
      await storage!.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      const got = await storage!.getRun('run-1');
      expect(got?.runId).toBe('run-1');
      expect(got?.artifactRevision).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('increments artifactRevision on each save and preserves startedAt', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      const t0 = '2026-01-01T12:00:00.000Z';
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        startedAt: t0,
        updatedAt: t0,
      });
      const r1 = await storage.getRun('run-1');
      expect(r1?.artifactRevision).toBe(1);
      expect(r1?.startedAt).toBe(t0);

      const t1 = '2026-01-02T12:00:00.000Z';
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        runCommits: [{ message: 'm', diff: 'updated' }],
        startedAt: t1,
        updatedAt: t1,
      });
      const r2 = await storage.getRun('run-1');
      expect(r2?.artifactRevision).toBe(2);
      expect(r2?.startedAt).toBe(t0);
      expect(r2?.runCommits).toEqual([{ message: 'm', diff: 'updated' }]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('saveRun with ifRevisionEquals succeeds when revision matches', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      expect((await storage.getRun('run-1'))?.artifactRevision).toBe(1);

      await storage.saveRun(
        'run-1',
        { ...dummyArtifact, runId: 'run-1', runCommits: [{ message: 'm', diff: 'v2' }] },
        { ifRevisionEquals: 1 },
      );
      expect((await storage.getRun('run-1'))?.artifactRevision).toBe(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusRunning writes running status and returns new revision', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      const t0 = '2026-01-01T12:00:00.000Z';
      const rev = await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
        startedAt: t0,
        updatedAt: t0,
      });
      expect(rev).toBe(1);
      const got = await storage.getRun('run-1');
      expect(got?.status).toBe('running');
      expect(got?.artifactRevision).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusInspecting writes inspecting status, session, and revision', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      const session = {
        containerName: 'saifctl-coder-test',
        containerId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T12:00:00.000Z',
      };
      const rev = await storage.setStatusInspecting('run-1', session);
      expect(rev).toBe(2);
      const got = await storage.getRun('run-1');
      expect(got?.status).toBe('inspecting');
      expect(got?.inspectSession).toEqual(session);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusInspecting throws when already inspecting', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      const session = {
        containerName: 'c1',
        containerId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
        workspacePath: '/workspace',
        startedAt: '2026-01-01T12:00:00.000Z',
      };
      await storage.setStatusInspecting('run-1', session);
      await expect(storage.setStatusInspecting('run-1', session)).rejects.toThrow(
        /already in inspect mode/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusRunning throws RunAlreadyRunningError when stored status is already running', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
      });
      await expect(
        storage.setStatusRunning('run-1', {
          ...dummyArtifact,
          runId: 'run-1',
          status: 'running',
        }),
      ).rejects.toThrow(RunAlreadyRunningError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusRunning throws RunAlreadyRunningError when stored status is inspecting', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      await storage.setStatusInspecting('run-1', {
        containerId: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
        containerName: 'c1',
        workspacePath: '/w',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      await expect(
        storage.setStatusRunning('run-1', {
          ...dummyArtifact,
          runId: 'run-1',
          status: 'running',
        }),
      ).rejects.toThrow(RunAlreadyRunningError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('setStatusRunning after failed increments revision and preserves startedAt', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      const t0 = '2026-01-01T12:00:00.000Z';
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'failed',
        startedAt: t0,
        updatedAt: t0,
      });
      expect((await storage.getRun('run-1'))?.artifactRevision).toBe(1);

      const rev = await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
      });
      expect(rev).toBe(2);
      const got = await storage.getRun('run-1');
      expect(got?.status).toBe('running');
      expect(got?.startedAt).toBe(t0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('saveRun with ifRevisionEquals throws StaleArtifactError on mismatch', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      await expect(
        storage.saveRun(
          'run-1',
          { ...dummyArtifact, runId: 'run-1', runCommits: [{ message: 'm', diff: 'stale' }] },
          { ifRevisionEquals: 0 },
        ),
      ).rejects.toThrow(StaleArtifactError);
      expect((await storage.getRun('run-1'))?.artifactRevision).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns RunStorage for file URI with custom base path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    const customBase = join(tmp, 'custom-base');
    try {
      const storage = createRunStorage(`file://${customBase}`, tmp);
      expect(storage).not.toBeNull();
      await storage!.saveRun('run-1', { ...dummyArtifact, runId: 'run-1' });
      const got = await storage!.getRun('run-1');
      expect(got?.runId).toBe('run-1');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestPause sets controlSignal pause when status is running', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      const t0 = '2026-01-01T12:00:00.000Z';
      await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
        startedAt: t0,
        updatedAt: t0,
      });
      await storage.requestPause('run-1');
      const got = await storage.getRun('run-1');
      expect(got?.controlSignal?.action).toBe('pause');
      expect(got?.controlSignal?.requestedAt).toBeDefined();
      expect(got?.status).toBe('pausing');
      expect(got?.artifactRevision).toBe(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestPause throws RunCannotPauseError when not running', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'paused',
      });
      await expect(storage.requestPause('run-1')).rejects.toThrow(RunCannotPauseError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestStop sets controlSignal stop when status is running', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
      });
      await storage.requestStop('run-1');
      const got = await storage.getRun('run-1');
      expect(got?.controlSignal?.action).toBe('stop');
      expect(got?.controlSignal?.requestedAt).toBeDefined();
      expect(got?.status).toBe('stopping');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestStop throws RunCannotStopError when status is paused (use CLI teardown)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'paused',
        pausedSandboxBasePath: '/tmp/sandbox',
      });
      await expect(storage.requestStop('run-1')).rejects.toThrow(RunCannotStopError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestStop throws RunCannotStopError when completed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1', status: 'completed' });
      await expect(storage.requestStop('run-1')).rejects.toThrow(RunCannotStopError);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('beginRunStartFromArtifact sets starting from failed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', { ...dummyArtifact, runId: 'run-1', status: 'failed' });
      const rev = await storage.beginRunStartFromArtifact('run-1');
      const got = await storage.getRun('run-1');
      expect(rev).toBeGreaterThanOrEqual(2);
      expect(got?.status).toBe('starting');
      expect(got?.controlSignal).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('beginRunStartFromArtifact allows paused with no sandbox path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'paused',
        pausedSandboxBasePath: null,
      });
      await storage.beginRunStartFromArtifact('run-1');
      const got = await storage.getRun('run-1');
      expect(got?.status).toBe('starting');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('requestStop overwrites requestPause (last write wins)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.setStatusRunning('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'running',
      });
      await storage.requestPause('run-1');
      await storage.requestStop('run-1');
      const got = await storage.getRun('run-1');
      expect(got?.controlSignal?.action).toBe('stop');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('listRuns and clearRuns respect filters', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'saifctl-'));
    try {
      const storage = createRunStorage('local', tmp)!;
      await storage.saveRun('run-1', {
        ...dummyArtifact,
        runId: 'run-1',
        status: 'failed',
        taskId: 'task-a',
      });
      await storage.saveRun('run-2', {
        ...dummyArtifact,
        runId: 'run-2',
        status: 'completed',
        taskId: 'task-a',
      });
      await storage.saveRun('run-3', {
        ...dummyArtifact,
        runId: 'run-3',
        status: 'failed',
        taskId: 'task-b',
      });

      const failed = await storage.listRuns({ status: 'failed' });
      expect(failed).toHaveLength(2);
      const taskB = await storage.listRuns({ taskId: 'task-b' });
      expect(taskB).toHaveLength(1);
      expect(taskB[0].runId).toBe('run-3');

      await storage.clearRuns({ status: 'failed' });
      expect(await storage.getRun('run-1')).toBeNull();
      expect(await storage.getRun('run-3')).toBeNull();
      expect(await storage.getRun('run-2')).not.toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
