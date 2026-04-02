/**
 * Unit tests for {@link runInspect} — mocked engine, sandbox, worktree helpers, and I/O.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaifctlConfig } from '../config/schema.js';
import { getGitProvider } from '../git/index.js';
import { type RunStorage } from '../runs/storage.js';
import { type RunArtifact, type RunInspectSession, StaleArtifactError } from '../runs/types.js';
import type { Feature } from '../specs/discover.js';
import { resolveTestProfile } from '../test-profiles/index.js';
import { type OrchestratorOpts, runInspect } from './modes.js';
import type { OrchestratorCliInput } from './options.js';
import type { Sandbox } from './sandbox.js';

const feature: Feature = {
  name: 'my-feat',
  absolutePath: '/tmp/proj/saifctl/features/my-feat',
  relativePath: 'saifctl/features/my-feat',
};

function makeOrchestratorOpts(): OrchestratorOpts {
  const testProfile = resolveTestProfile('node-vitest');
  const gitProvider = getGitProvider('github');
  return {
    sandboxProfileId: 'node-pnpm-python',
    agentProfileId: 'openhands',
    feature,
    projectDir: '/tmp/proj',
    maxRuns: 5,
    llm: {},
    saifctlDir: 'saifctl',
    projectName: 'proj',
    sandboxBaseDir: '/tmp/sandboxes',
    testImage: 'test:latest',
    resolveAmbiguity: 'ai',
    testRetries: 1,
    dangerousNoLeash: false,
    cedarPolicyPath: '/policy.cedar',
    cedarScript: '// policy',
    coderImage: 'coder:latest',
    push: null,
    pr: false,
    targetBranch: null,
    gateRetries: 10,
    agentEnv: {},
    agentSecretKeys: [],
    agentSecretFiles: [],
    testScript: 'test',
    testProfile,
    gitProvider,
    reviewerEnabled: false,
    includeDirty: false,
    stagingEnvironment: {
      engine: 'docker',
      app: { sidecarPort: 8080, sidecarPath: '/exec' },
      appEnvironment: {},
    },
    codingEnvironment: { engine: 'docker' },
    gateScript: '#',
    startupScript: '#',
    agentInstallScript: '#',
    agentScript: '#',
    stageScript: '#',
    startupScriptFile: 'startup.sh',
    gateScriptFile: 'gate.sh',
    stageScriptFile: 'stage.sh',
    testScriptFile: 'test.sh',
    agentInstallScriptFile: 'agent-install.sh',
    agentScriptFile: 'agent.sh',
    runStorage: null,
    fromArtifact: null,
    patchExclude: undefined,
    verbose: false,
    testOnly: false,
  };
}

const baseArtifact: RunArtifact = {
  runId: 'run-inspect-1',
  baseCommitSha: 'abc123',
  runCommits: [{ message: 'saifctl: coding attempt 1', diff: 'original patch\n' }],
  specRef: 'saifctl/features/my-feat',
  rules: [],
  config: {
    featureName: 'my-feat',
    gitProviderId: 'github',
    testProfileId: 'node-vitest',
    sandboxProfileId: 'node-pnpm-python',
    agentProfileId: 'openhands',
    projectDir: '/tmp/proj',
    maxRuns: 5,
    llm: {},
    saifctlDir: 'saifctl',
    projectName: 'proj',
    testImage: 'test:latest',
    resolveAmbiguity: 'ai',
    dangerousNoLeash: false,
    cedarPolicyPath: '',
    cedarScript: '',
    coderImage: '',
    push: null,
    pr: false,
    targetBranch: null,
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

const sandbox: Sandbox = {
  runId: 'sb-run1',
  sandboxBasePath: '/tmp/saifctl/sandboxes/proj-my-feat-sb-run1',
  codePath: '/tmp/saifctl/sandboxes/proj-my-feat-sb-run1/code',
  saifctlPath: '/tmp/saifctl/sandboxes/proj-my-feat-sb-run1/saifctl',
  hostBasePatchPath: '',
};

const {
  createArtifactRunWorktreeMock,
  cleanupArtifactRunWorktreeMock,
  createSandboxMock,
  destroySandboxMock,
  extractIncrementalRoundPatchMock,
  createEngineMock,
  resolveFeatureMock,
  resolveOrchestratorOptsMock,
  writeUtf8Mock,
  mockEngine,
} = vi.hoisted(() => {
  const mockInspectInfra = {
    engine: 'docker' as const,
    projectDir: '/tmp/proj',
    networkName: 'saifctl-net',
    composeProjectName: 'proj',
    stagingImages: [] as string[],
    containers: [] as string[],
  };
  const setup = vi.fn().mockResolvedValue({ infra: mockInspectInfra });
  const teardown = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const runAgent = vi.fn().mockImplementation(
    async (opts: {
      codePath: string;
      infra?: typeof mockInspectInfra;
      inspectMode?: {
        onReady: (
          session: {
            containerName: string;
            containerId?: string;
            workspacePath: string;
            stop: typeof stop;
          },
          ctx: { codePath: string },
        ) => Promise<void>;
      };
    }) => {
      if (opts.inspectMode) {
        await opts.inspectMode.onReady(
          {
            containerName: 'leash-target-test',
            containerId: 'cbe2a522f55613720b1148320aa3a04212c7ea64a6e296abd2949e448b16ff90',
            workspacePath: '/workspace',
            stop,
          },
          { codePath: opts.codePath },
        );
      }
      return {
        agent: { success: true, exitCode: 0, output: '' },
        infra: opts.infra ?? mockInspectInfra,
      };
    },
  );
  const mockEngine = { setup, teardown, runAgent };
  return {
    createArtifactRunWorktreeMock: vi.fn(),
    cleanupArtifactRunWorktreeMock: vi.fn().mockResolvedValue(undefined),
    createSandboxMock: vi.fn(),
    destroySandboxMock: vi.fn().mockResolvedValue(undefined),
    extractIncrementalRoundPatchMock: vi.fn(),
    createEngineMock: vi.fn(() => mockEngine),
    resolveFeatureMock: vi.fn(),
    resolveOrchestratorOptsMock: vi.fn(),
    writeUtf8Mock: vi.fn().mockResolvedValue(undefined),
    mockEngine,
  };
});

vi.mock('./worktree.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createArtifactRunWorktree: createArtifactRunWorktreeMock,
    cleanupArtifactRunWorktree: cleanupArtifactRunWorktreeMock,
  };
});

vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createSandbox: createSandboxMock,
    destroySandbox: destroySandboxMock,
    extractIncrementalRoundPatch: extractIncrementalRoundPatchMock,
  };
});

vi.mock('../engines/index.js', () => ({
  createEngine: createEngineMock,
}));

vi.mock('../specs/discover.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveFeature: resolveFeatureMock,
  };
});

vi.mock('./options.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveOrchestratorOpts: resolveOrchestratorOptsMock,
  };
});

vi.mock('../utils/io.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    writeUtf8: writeUtf8Mock,
  };
});

vi.mock('./sidecars/reviewer/argus.js', () => ({
  getArgusBinaryPath: vi.fn().mockResolvedValue('/tmp/argus'),
}));

vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    git: vi.fn().mockResolvedValue('pretestheadsha\n'),
  };
});

vi.mock('../llm-config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveAgentLlmConfig: vi.fn().mockReturnValue({
      modelId: 'claude-3-5-sonnet-latest',
      provider: 'anthropic',
      fullModelString: 'anthropic/claude-3-5-sonnet-latest',
      apiKey: 'test-key',
    }),
  };
});

vi.mock('./loop.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    buildInitialTask: vi.fn().mockResolvedValue('initial task'),
    logIterativeLoopSettings: vi.fn(),
  };
});

vi.mock('./agent-task.js', () => ({
  buildTaskPrompt: vi.fn().mockResolvedValue('inspect task prompt'),
}));

describe('runInspect', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'saifctl-inspect-'));
    vi.clearAllMocks();
    createArtifactRunWorktreeMock.mockResolvedValue({
      worktreePath: join(projectDir, 'wt'),
      branchName: 'saifctl-run-run-inspect-1',
      baseSnapshotPath: join(projectDir, 'base-snap'),
    });
    createSandboxMock.mockResolvedValue(sandbox);
    resolveFeatureMock.mockResolvedValue(feature);
    resolveOrchestratorOptsMock.mockImplementation(async () => makeOrchestratorOpts());
    extractIncrementalRoundPatchMock.mockResolvedValue({
      patch: '',
      patchPath: join(sandbox.sandboxBasePath, 'patch.diff'),
      commits: [],
    });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  /** Wait until the inspect path has registered its SIGINT handler, then emit SIGINT. */
  async function finishWithSigint() {
    const deadline = Date.now() + 10_000;
    while (mockEngine.runAgent.mock.calls.length === 0) {
      if (Date.now() > deadline) {
        throw new Error('runAgent was not called (inspect onReady never reached)');
      }
      await new Promise<void>((r) => setImmediate(r));
    }
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        process.emit('SIGINT');
        resolve();
      });
    });
  }

  function makeStorage(
    initial: RunArtifact = baseArtifact,
    overrides: {
      getRun?: ReturnType<typeof vi.fn>;
      saveRun?: ReturnType<typeof vi.fn>;
      setStatusRunning?: ReturnType<typeof vi.fn>;
      setStatusInspecting?: ReturnType<typeof vi.fn>;
    } = {},
  ): RunStorage {
    let art: RunArtifact = {
      ...initial,
      inspectSession: initial.inspectSession ?? null,
    };

    const setStatusInspecting =
      overrides.setStatusInspecting ??
      vi.fn(async (_runId: string, session: RunInspectSession) => {
        const nextRev = (art.artifactRevision ?? 0) + 1;
        art = {
          ...art,
          status: 'inspecting',
          inspectSession: session,
          artifactRevision: nextRev,
          updatedAt: new Date().toISOString(),
        };
        return nextRev;
      });

    const saveRun =
      overrides.saveRun ??
      vi.fn(
        async (
          _runId: string,
          incoming: RunArtifact,
          opts?: { ifRevisionEquals?: number },
        ): Promise<number> => {
          if (
            opts?.ifRevisionEquals !== undefined &&
            (art.artifactRevision ?? 0) !== opts.ifRevisionEquals
          ) {
            throw new StaleArtifactError({
              runId: art.runId,
              expectedRevision: opts.ifRevisionEquals,
              actualRevision: art.artifactRevision ?? 0,
            });
          }
          art = {
            ...incoming,
            artifactRevision: (art.artifactRevision ?? 0) + 1,
          };
          return art.artifactRevision!;
        },
      );

    const getRun = overrides.getRun ?? vi.fn(() => Promise.resolve({ ...art }));

    return {
      uri: 'mock',
      getRun,
      saveRun,
      setStatusRunning: overrides.setStatusRunning ?? vi.fn().mockResolvedValue(1),
      setStatusInspecting,
      listRuns: vi.fn(),
      deleteRun: vi.fn(),
      clearRuns: vi.fn(),
    } as unknown as RunStorage;
  }

  it('throws when run storage is null', async () => {
    await expect(
      runInspect({
        runId: 'x',
        projectDir,
        saifctlDir: 'saifctl',
        config: {} as SaifctlConfig,
        runStorage: null as unknown as RunStorage,
        cli: {} as unknown as OrchestratorCliInput,
        cliModelDelta: undefined,
        engineCli: undefined,
      }),
    ).rejects.toThrow(/run storage/i);
  });

  it('passes dangerousNoLeash false to runAgent when inspectLeash is true', async () => {
    const storage = makeStorage();
    const p = runInspect({
      runId: baseArtifact.runId,
      projectDir,
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
      runStorage: storage,
      cli: {} as unknown as OrchestratorCliInput,
      cliModelDelta: undefined,
      inspectLeash: true,
      engineCli: undefined,
    });
    await finishWithSigint();
    await p;

    expect(mockEngine.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ dangerousNoLeash: false, inspectMode: expect.any(Object) }),
    );
  });

  it('throws when run is not found', async () => {
    const storage = makeStorage(baseArtifact, { getRun: vi.fn().mockResolvedValue(null) });
    await expect(
      runInspect({
        runId: 'missing',
        projectDir,
        saifctlDir: 'saifctl',
        config: {} as SaifctlConfig,
        runStorage: storage,
        cli: {} as unknown as OrchestratorCliInput,
        cliModelDelta: undefined,
        engineCli: undefined,
      }),
    ).rejects.toThrow(/Run not found/);
  });

  it('throws when Run status is running', async () => {
    const storage = makeStorage(baseArtifact, {
      getRun: vi.fn().mockResolvedValue({ ...baseArtifact, status: 'running' }),
    });
    await expect(
      runInspect({
        runId: baseArtifact.runId,
        projectDir,
        saifctlDir: 'saifctl',
        config: {} as SaifctlConfig,
        runStorage: storage,
        cli: {} as unknown as OrchestratorCliInput,
        cliModelDelta: undefined,
        engineCli: undefined,
      }),
    ).rejects.toThrow(/cannot be inspected/);
  });

  it('throws when Run status is inspecting', async () => {
    const storage = makeStorage(baseArtifact, {
      getRun: vi.fn().mockResolvedValue({
        ...baseArtifact,
        status: 'inspecting',
        inspectSession: {
          containerName: 'x',
          workspacePath: '/workspace',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    await expect(
      runInspect({
        runId: baseArtifact.runId,
        projectDir,
        saifctlDir: 'saifctl',
        config: {} as SaifctlConfig,
        runStorage: storage,
        cli: {} as unknown as OrchestratorCliInput,
        cliModelDelta: undefined,
        engineCli: undefined,
      }),
    ).rejects.toThrow(/already in inspect mode/);
  });

  it('creates worktree and sandbox, then on SIGINT skips save when patch unchanged', async () => {
    const storage = makeStorage();
    const p = runInspect({
      runId: baseArtifact.runId,
      projectDir,
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
      runStorage: storage,
      cli: {} as unknown as OrchestratorCliInput,
      cliModelDelta: undefined,
      engineCli: undefined,
    });
    await finishWithSigint();
    await p;

    expect(createArtifactRunWorktreeMock).toHaveBeenCalled();
    expect(createSandboxMock).toHaveBeenCalled();
    expect(mockEngine.setup).toHaveBeenCalled();
    expect(mockEngine.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ dangerousNoLeash: true, inspectMode: expect.any(Object) }),
    );
    expect(storage.setStatusInspecting).toHaveBeenCalledWith(
      baseArtifact.runId,
      expect.objectContaining({
        containerName: 'leash-target-test',
        containerId: 'cbe2a522f55613720b1148320aa3a04212c7ea64a6e296abd2949e448b16ff90',
        workspacePath: '/workspace',
      }),
    );
    expect(storage.saveRun).toHaveBeenCalledTimes(1);
    expect(destroySandboxMock).toHaveBeenCalledWith(sandbox.sandboxBasePath);
    expect(cleanupArtifactRunWorktreeMock).toHaveBeenCalled();
  });

  it('calls saveRun with ifRevisionEquals when patch changes', async () => {
    const artifact = {
      ...baseArtifact,
      artifactRevision: 2,
      runCommits: [] as RunArtifact['runCommits'],
    };
    const storage = makeStorage(artifact);
    const newStep = {
      message: 'saifctl: inspect session',
      diff: 'new patch content\n',
      author: 'saifctl <saifctl@safeaifactory.com>',
    };
    extractIncrementalRoundPatchMock.mockResolvedValue({
      patch: 'new patch content\n',
      patchPath: join(sandbox.sandboxBasePath, 'patch.diff'),
      commits: [newStep],
    });

    const p = runInspect({
      runId: artifact.runId,
      projectDir,
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
      runStorage: storage,
      cli: {} as unknown as OrchestratorCliInput,
      cliModelDelta: undefined,
      engineCli: undefined,
    });
    await finishWithSigint();
    await p;

    expect(storage.saveRun).toHaveBeenCalledTimes(2);
    expect(storage.saveRun).toHaveBeenLastCalledWith(
      artifact.runId,
      expect.objectContaining({
        runCommits: [newStep],
      }),
      { ifRevisionEquals: 4 },
    );
  });

  it('writes fallback json file on StaleArtifactError', async () => {
    const artifact = {
      ...baseArtifact,
      artifactRevision: 1,
      runCommits: [] as RunArtifact['runCommits'],
    };
    let art: RunArtifact = { ...artifact, inspectSession: null };
    const setStatusInspecting = vi.fn(async (_runId: string, session: RunInspectSession) => {
      const nextRev = (art.artifactRevision ?? 0) + 1;
      art = {
        ...art,
        status: 'inspecting',
        inspectSession: session,
        artifactRevision: nextRev,
        updatedAt: new Date().toISOString(),
      };
      return nextRev;
    });
    let saveCall = 0;
    const saveRun = vi.fn(
      async (
        _runId: string,
        incoming: RunArtifact,
        opts?: { ifRevisionEquals?: number },
      ): Promise<number> => {
        if (
          opts?.ifRevisionEquals !== undefined &&
          (art.artifactRevision ?? 0) !== opts.ifRevisionEquals
        ) {
          throw new StaleArtifactError({
            runId: art.runId,
            expectedRevision: opts.ifRevisionEquals,
            actualRevision: art.artifactRevision ?? 0,
          });
        }
        saveCall += 1;
        if (saveCall === 1) {
          art = { ...incoming, artifactRevision: (art.artifactRevision ?? 0) + 1 };
          return art.artifactRevision!;
        }
        throw new StaleArtifactError({
          runId: artifact.runId,
          expectedRevision: opts?.ifRevisionEquals ?? 0,
          actualRevision: 999,
        });
      },
    );
    const storage = {
      uri: 'mock',
      getRun: vi.fn(() => Promise.resolve({ ...art })),
      saveRun,
      setStatusInspecting,
      setStatusRunning: vi.fn(),
      listRuns: vi.fn(),
      deleteRun: vi.fn(),
      clearRuns: vi.fn(),
    } as unknown as RunStorage;
    const staleStep = {
      message: 'saifctl: inspect session',
      diff: 'conflict patch\n',
      author: 'saifctl <saifctl@safeaifactory.com>',
    };
    extractIncrementalRoundPatchMock.mockResolvedValue({
      patch: 'conflict patch\n',
      patchPath: join(sandbox.sandboxBasePath, 'patch.diff'),
      commits: [staleStep],
    });

    const p = runInspect({
      runId: artifact.runId,
      projectDir,
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
      runStorage: storage,
      cli: {} as unknown as OrchestratorCliInput,
      cliModelDelta: undefined,
      engineCli: undefined,
    });
    await finishWithSigint();
    await p;

    expect(writeUtf8Mock).toHaveBeenCalledWith(
      join(projectDir, `.saifctl-inspect-stale-${artifact.runId}.json`),
      JSON.stringify([staleStep]),
    );
  });

  it('rethrows non-stale save errors after cleanup', async () => {
    const artifact = {
      ...baseArtifact,
      runCommits: [{ message: 'm', diff: 'a\n' }],
    };
    const diskError = new Error('disk full');
    const storage = makeStorage(artifact, {
      saveRun: vi.fn().mockRejectedValue(diskError),
    });
    extractIncrementalRoundPatchMock.mockResolvedValue({
      patch: 'b\n',
      patchPath: join(sandbox.sandboxBasePath, 'patch.diff'),
      commits: [{ message: 'saifctl: inspect session', diff: 'b\n' }],
    });

    const p = runInspect({
      runId: artifact.runId,
      projectDir,
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
      runStorage: storage,
      cli: {} as unknown as OrchestratorCliInput,
      cliModelDelta: undefined,
      engineCli: undefined,
    });
    await finishWithSigint();
    await expect(p).rejects.toThrow('disk full');

    expect(destroySandboxMock).toHaveBeenCalled();
    expect(cleanupArtifactRunWorktreeMock).toHaveBeenCalled();
  });
});
