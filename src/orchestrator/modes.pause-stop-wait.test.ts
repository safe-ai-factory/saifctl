import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consola } from '../logger.js';
import type { RunStorage } from '../runs/storage.js';
import type { RunArtifact } from '../runs/types.js';
import { runPause } from './modes.js';

const baseArtifact: RunArtifact = {
  runId: 'r1',
  baseCommitSha: 'abc',
  runCommits: [],
  specRef: 's',
  rules: [],
  config: {
    featureName: 'f',
    gitProviderId: 'github',
    testProfileId: 'vitest',
    sandboxProfileId: 'vitest',
    agentProfileId: 'openhands',
    projectDir: '/tmp',
    maxRuns: 5,
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
  status: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  controlSignal: null,
  pausedSandboxBasePath: null,
  liveInfra: null,
  inspectSession: null,
};

function mockStorage(opts: { getRunImpl: (callIndex: number) => RunArtifact | null }): RunStorage {
  let getRunCalls = 0;
  return {
    async requestPause() {
      /* no-op: real storage would set controlSignal */
    },
    async getRun() {
      getRunCalls += 1;
      return opts.getRunImpl(getRunCalls);
    },
  } as unknown as RunStorage;
}

describe('runPause wait + timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves after status leaves running (poll interval)', async () => {
    const storage = mockStorage({
      getRunImpl(callIndex) {
        if (callIndex < 2) {
          return { ...baseArtifact, status: 'running' };
        }
        return { ...baseArtifact, status: 'paused' };
      },
    });

    const p = runPause({ runId: 'r1', runStorage: storage, waitTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
  });

  it('warns when wait times out', async () => {
    const warnSpy = vi.spyOn(consola, 'warn').mockImplementation(() => {});
    const storage = mockStorage({
      getRunImpl() {
        return { ...baseArtifact, status: 'running' };
      },
    });

    const p = runPause({ runId: 'r1', runStorage: storage, waitTimeoutMs: 2500 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('Timed out');
    expect(msg).toContain('r1');
  });
});
