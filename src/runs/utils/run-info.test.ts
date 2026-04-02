import { describe, expect, it } from 'vitest';

import type { RunArtifact, RunCommit } from '../types.js';
import { toRunInfoJson } from './run-info.js';

const minimalArtifact: RunArtifact = {
  runId: 'r1',
  baseCommitSha: 'abc',
  basePatchDiff: 'base-diff-content',
  runCommits: [{ message: 'm', diff: 'run-diff-content' }],
  specRef: 'saifctl/features/x',
  rules: [],
  lastFeedback: 'feedback line',
  config: {
    featureName: 'feat',
    gitProviderId: 'github',
    testProfileId: 'vitest',
    sandboxProfileId: 'vitest',
    agentProfileId: 'openhands',
    projectDir: '/p',
    maxRuns: 3,
    llm: {},
    saifctlDir: 'saifctl',
    projectName: 'proj',
    testImage: 'img',
    resolveAmbiguity: 'ai',
    dangerousNoLeash: false,
    cedarPolicyPath: '',
    cedarScript: 'CEDAR BODY',
    coderImage: '',
    push: null,
    pr: false,
    includeDirty: false,
    gateRetries: 1,
    reviewerEnabled: true,
    agentEnv: {},
    agentSecretKeys: [],
    agentSecretFiles: [],
    testScript: 'TEST BODY',
    gateScript: 'GATE BODY',
    startupScript: 'START BODY',
    agentInstallScript: 'INSTALL BODY',
    agentScript: 'AGENT BODY',
    stageScript: 'STAGE BODY',
    startupScriptFile: 'path/startup.sh',
    gateScriptFile: 'path/gate.sh',
    stageScriptFile: 'path/stage.sh',
    testScriptFile: 'path/test.sh',
    agentInstallScriptFile: 'path/install.sh',
    agentScriptFile: 'path/agent.sh',
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

describe('toRunInfoJson', () => {
  it('omits basePatchDiff and run commit diffs; keeps message (and author when set)', () => {
    const view = toRunInfoJson(minimalArtifact);
    expect(view).not.toHaveProperty('basePatchDiff');
    expect(view.runCommits).toEqual([{ message: 'm' }]);
    const row = (view.runCommits as unknown[])[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('diff');
  });

  it('includes author in runCommits when present', () => {
    const art: RunArtifact = {
      ...minimalArtifact,
      runCommits: [
        { message: 'first', diff: 'd1', author: 'Alice <a@b.com>' },
        { message: 'second', diff: 'd2' },
      ],
    };
    const view = toRunInfoJson(art);
    expect(view.runCommits).toEqual([
      { message: 'first', author: 'Alice <a@b.com>' },
      { message: 'second' },
    ]);
  });

  it('omits script bodies but keeps *File paths', () => {
    const view = toRunInfoJson(minimalArtifact);
    const cfg = view.config;
    expect(cfg.startupScriptFile).toBe('path/startup.sh');
    expect(cfg.testScriptFile).toBe('path/test.sh');
    expect(cfg).not.toHaveProperty('startupScript');
    expect(cfg).not.toHaveProperty('testScript');
    expect(cfg).not.toHaveProperty('gateScript');
    expect(cfg).not.toHaveProperty('stageScript');
    expect(cfg).not.toHaveProperty('agentScript');
    expect(cfg).not.toHaveProperty('agentInstallScript');
    expect(cfg).not.toHaveProperty('cedarScript');
  });

  it('preserves other top-level fields', () => {
    const view = toRunInfoJson(minimalArtifact);
    expect(view.runId).toBe('r1');
    expect(view.specRef).toBe('saifctl/features/x');
    expect(view.lastFeedback).toBe('feedback line');
    expect(view.status).toBe('failed');
  });

  it('does not mutate the source artifact', () => {
    const copy = structuredClone(minimalArtifact);
    toRunInfoJson(minimalArtifact);
    expect(minimalArtifact).toEqual(copy);
  });

  it('treats missing runCommits as empty (legacy or partial artifacts)', () => {
    const art = { ...minimalArtifact, runCommits: undefined as unknown as RunCommit[] };
    const view = toRunInfoJson(art);
    expect(view.runCommits).toEqual([]);
  });
});
