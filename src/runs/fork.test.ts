/**
 * {@link forkStoredRun} — clone stored run artifact with merged CLI defaults.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOrchestratorCliInputFromFeatArgs, type FeatRunArgs } from '../cli/utils.js';
import { loadSaifctlConfig } from '../config/load.js';
import { forkStoredRun } from './fork.js';
import { createRunStorage } from './storage.js';
import type { RunArtifact } from './types.js';

function makeSourceArtifact(runId: string): RunArtifact {
  return {
    runId,
    baseCommitSha: 'abc123dead',
    basePatchDiff: 'diff --git a/x b/x\n',
    runCommits: [{ message: 'step1', diff: 'patch hunk\n' }],
    specRef: 'saifctl/features/my-feat',
    rules: [],
    lastFeedback: 'try again',
    config: {
      featureName: 'my-feat',
      gitProviderId: 'github',
      testProfileId: 'node-vitest',
      sandboxProfileId: 'node-pnpm-python',
      agentProfileId: 'openhands',
      projectDir: '/ignored-on-merge',
      maxRuns: 5,
      overrides: {},
      saifctlDir: 'saifctl',
      projectName: 'proj',
      testImage: 'test:latest',
      resolveAmbiguity: 'ai',
      dangerousNoLeash: false,
      cedarPolicyPath: '',
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
      codingEnvironment: { engine: 'docker' },
    },
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    controlSignal: null,
    pausedSandboxBasePath: null,
    liveInfra: null,
  };
}

describe('forkStoredRun', () => {
  it('writes a new run id, copies git/patch state, and merges CLI into stored config', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-fork-'));
    try {
      await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'proj' }), 'utf8');
      await mkdir(join(projectDir, 'saifctl', 'features', 'my-feat'), { recursive: true });

      const storage = createRunStorage('local', projectDir)!;
      const source = makeSourceArtifact('srcrun9');
      await storage.saveRun('srcrun9', source);

      const config = await loadSaifctlConfig('saifctl', projectDir);
      const cli = await buildOrchestratorCliInputFromFeatArgs({ 'max-runs': '17' } as FeatRunArgs, {
        projectDir,
        saifctlDir: 'saifctl',
        config,
      });

      const { newRunId } = await forkStoredRun({
        runId: 'srcrun9',
        projectDir,
        saifctlDir: 'saifctl',
        config,
        runStorage: storage,
        cli,
        cliModelDelta: undefined,
        engineCli: undefined,
      });

      expect(newRunId).not.toBe('srcrun9');
      const forked = await storage.getRun(newRunId);
      expect(forked).not.toBeNull();
      expect(forked!.baseCommitSha).toBe(source.baseCommitSha);
      expect(forked!.basePatchDiff).toBe(source.basePatchDiff);
      expect(forked!.runCommits).toEqual(source.runCommits);
      expect(forked!.lastFeedback).toBe(source.lastFeedback);
      expect(forked!.status).toBe('failed');
      expect(forked!.config.maxRuns).toBe(17);
      expect(forked!.config.featureName).toBe('my-feat');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
