import { describe, expect, it } from 'vitest';

import type { RunArtifact } from '../types.js';
import { toRunInfoJson } from './run-info.js';

const minimalArtifact: RunArtifact = {
  runId: 'r1',
  baseCommitSha: 'abc',
  basePatchDiff: 'base-diff-content',
  runPatchDiff: 'run-diff-content',
  specRef: 'saifac/features/x',
  lastFeedback: 'feedback line',
  config: {
    featureName: 'feat',
    gitProviderId: 'github',
    testProfileId: 'vitest',
    sandboxProfileId: 'vitest',
    agentProfileId: 'openhands',
    projectDir: '/p',
    maxRuns: 3,
    overrides: {},
    saifDir: 'saifac',
    projectName: 'proj',
    testImage: 'img',
    resolveAmbiguity: 'ai',
    dangerousDebug: false,
    cedarPolicyPath: '',
    coderImage: '',
    push: null,
    pr: false,
    gateRetries: 1,
    reviewerEnabled: true,
    agentEnv: {},
    agentLogFormat: 'openhands',
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
      provisioner: 'docker',
      app: { sidecarPort: 8080, sidecarPath: '/exec' },
      appEnvironment: {},
    },
    codingEnvironment: { provisioner: 'docker' },
  },
  status: 'failed',
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

describe('toRunInfoJson', () => {
  it('omits patch diff fields', () => {
    const view = toRunInfoJson(minimalArtifact);
    expect(view).not.toHaveProperty('basePatchDiff');
    expect(view).not.toHaveProperty('runPatchDiff');
  });

  it('omits script bodies but keeps *File paths', () => {
    const view = toRunInfoJson(minimalArtifact);
    const cfg = view.config as Record<string, unknown>;
    expect(cfg.startupScriptFile).toBe('path/startup.sh');
    expect(cfg.testScriptFile).toBe('path/test.sh');
    expect(cfg).not.toHaveProperty('startupScript');
    expect(cfg).not.toHaveProperty('testScript');
    expect(cfg).not.toHaveProperty('gateScript');
    expect(cfg).not.toHaveProperty('stageScript');
    expect(cfg).not.toHaveProperty('agentScript');
    expect(cfg).not.toHaveProperty('agentInstallScript');
  });

  it('preserves other top-level fields', () => {
    const view = toRunInfoJson(minimalArtifact);
    expect(view.runId).toBe('r1');
    expect(view.specRef).toBe('saifac/features/x');
    expect(view.lastFeedback).toBe('feedback line');
    expect(view.status).toBe('failed');
  });

  it('does not mutate the source artifact', () => {
    const copy = structuredClone(minimalArtifact);
    toRunInfoJson(minimalArtifact);
    expect(minimalArtifact).toEqual(copy);
  });
});
