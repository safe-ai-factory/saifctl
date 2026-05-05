/**
 * Tests for {@link buildRunArtifact}.
 */

import { describe, expect, it } from 'vitest';

import { getGitProvider } from '../../git/index.js';
import type { IterativeLoopOpts } from '../../orchestrator/loop.js';
import { resolveTestProfile } from '../../test-profiles/index.js';
import type { RunSubtask } from '../types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from './artifact.js';
import type { PersistedScriptBundle } from './serialize.js';
import { runSubtasksToInputs } from './subtasks.js';

function minimalLoopOpts(): IterativeLoopOpts & PersistedScriptBundle {
  return {
    sandboxProfileId: 'node-pnpm-python',
    agentProfileId: 'openhands',
    feature: {
      name: 'x',
      absolutePath: '/tmp/saifctl/features/x',
      relativePath: 'saifctl/features/x',
    },
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
    targetBranch: null,
    gitProvider: getGitProvider('github'),
    gateRetries: 10,
    agentEnv: {},
    agentSecretKeys: [],
    agentSecretFiles: [],
    testScript: 'test',
    testProfile: resolveTestProfile('node-vitest'),
    testRetries: 1,
    reviewerEnabled: true,
    includeDirty: false,
    strict: true,
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
    startupScriptFile: 's/startup.sh',
    gateScriptFile: 's/gate.sh',
    stageScriptFile: 's/stage.sh',
    testScriptFile: 's/test.sh',
    agentInstallScriptFile: 's/agent-install.sh',
    agentScriptFile: 's/agent.sh',
    subtasks: [{ content: 'test task', title: 'x' }],
    currentSubtaskIndex: 0,
    enableSubtaskSequence: false,
  };
}

describe('buildRunArtifact', () => {
  it('includes subtasks and currentSubtaskIndex; omits specRef', () => {
    const subtasks: RunSubtask[] = [
      {
        id: 'aabbcc',
        title: 'First',
        content: 'Do the thing',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const artifact = buildRunArtifact({
      runId: 'r1',
      baseCommitSha: 'sha',
      basePatchDiff: undefined,
      runCommits: [],
      sandboxHostAppliedCommitCount: 0,
      subtasks,
      currentSubtaskIndex: 0,
      status: 'running',
      rules: [],
      controlSignal: null,
      pausedSandboxBasePath: null,
      liveInfra: null,
      opts: minimalLoopOpts() as BuildRunArtifactOpts,
    });

    expect(artifact.subtasks).toHaveLength(1);
    expect(artifact.subtasks[0]?.content).toBe('Do the thing');
    expect(artifact.subtasks[0]?.id).toBe('aabbcc');
    expect(artifact.currentSubtaskIndex).toBe(0);
    expect(artifact).not.toHaveProperty('specRef');
    expect(artifact.config.subtasks).toEqual(runSubtasksToInputs(subtasks));
  });

  it('syncs config.subtasks from artifact.subtasks for multiple subtasks', () => {
    const subtasks: RunSubtask[] = [
      {
        id: 's1',
        content: 'A',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 's2',
        title: 'B',
        content: 'B',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        gateRetries: 3,
      },
    ];

    const artifact = buildRunArtifact({
      runId: 'r2',
      baseCommitSha: 'sha',
      basePatchDiff: undefined,
      runCommits: [],
      sandboxHostAppliedCommitCount: 0,
      subtasks,
      currentSubtaskIndex: 1,
      status: 'running',
      rules: [],
      controlSignal: null,
      pausedSandboxBasePath: null,
      liveInfra: null,
      opts: minimalLoopOpts() as BuildRunArtifactOpts,
    });

    expect(artifact.currentSubtaskIndex).toBe(1);
    expect(artifact.config.subtasks).toEqual(runSubtasksToInputs(subtasks));
  });
});
