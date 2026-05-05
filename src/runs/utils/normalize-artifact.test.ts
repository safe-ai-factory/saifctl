import { describe, expect, it } from 'vitest';

import type { OuterAttemptSummary, RunArtifact } from '../types.js';
import {
  normalizeLoadedRunArtifact,
  syncConfigSubtasksFromArtifact,
} from './normalize-artifact.js';

const stagingEnvironment = {
  engine: 'docker' as const,
  app: { sidecarPort: 8080, sidecarPath: '/exec' },
  appEnvironment: {},
};

function baseLegacyArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  const cfg = {
    featureName: 'my-feat',
    featureRelativePath: 'custom/path',
    gitProviderId: 'github',
    testProfileId: 'vitest',
    sandboxProfileId: 'vitest',
    agentProfileId: 'openhands',
    projectDir: '/p',
    llm: {},
    saifctlDir: 'saifctl',
    projectName: 'proj',
    testImage: 'img',
    resolveAmbiguity: 'ai' as const,
    dangerousNoLeash: false,
    cedarPolicyPath: '',
    cedarScript: '',
    coderImage: '',
    push: null,
    pr: false,
    includeDirty: false,
    gateRetries: 1,
    reviewerEnabled: true,
    agentEnv: {},
    agentSecretKeys: [],
    agentSecretFiles: [],
    testScript: '',
    gateScript: '',
    startupScript: '',
    agentInstallScript: '',
    agentScript: '',
    stageScript: '',
    startupScriptFile: '',
    gateScriptFile: '',
    stageScriptFile: '',
    testScriptFile: '',
    agentInstallScriptFile: '',
    agentScriptFile: '',
    testRetries: 1,
    stagingEnvironment,
    codingEnvironment: { engine: 'docker' as const },
    maxRuns: 7,
    subtasks: [{ content: 'legacy body' }],
  };

  return {
    runId: 'r1',
    baseCommitSha: 'abc',
    runCommits: [],
    sandboxHostAppliedCommitCount: 0,
    subtasks: [],
    currentSubtaskIndex: 0,
    rules: [],
    config: cfg as unknown as RunArtifact['config'],
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    controlSignal: null,
    pausedSandboxBasePath: null,
    liveInfra: null,
    inspectSession: null,
    ...overrides,
  };
}

describe('normalizeLoadedRunArtifact', () => {
  it('migrates config maxRuns to maxAttemptsPerSubtask and drops maxRuns', () => {
    const a = normalizeLoadedRunArtifact(baseLegacyArtifact());
    expect(a.config.maxAttemptsPerSubtask).toBe(7);
    expect(a.config).not.toHaveProperty('maxRuns');
  });

  it('uses specRef as first subtask title when subtasks were empty', () => {
    const raw = baseLegacyArtifact({
      subtasks: [],
    }) as RunArtifact & { specRef?: string };
    raw.specRef = 'saifctl/features/my-feat';
    const a = normalizeLoadedRunArtifact(raw);
    expect(a.subtasks).toHaveLength(1);
    expect(a.subtasks[0]?.title).toBe('saifctl/features/my-feat');
    expect(a.subtasks[0]?.content).toContain('legacy body');
    expect(a).not.toHaveProperty('specRef');
    expect(a).not.toHaveProperty('taskId');
  });

  it('clamps currentSubtaskIndex to last subtask (single subtask)', () => {
    const a = normalizeLoadedRunArtifact(
      baseLegacyArtifact({
        currentSubtaskIndex: 99,
      }),
    );
    expect(a.subtasks).toHaveLength(1);
    expect(a.currentSubtaskIndex).toBe(0);
  });

  it('clamps currentSubtaskIndex when multiple subtasks exist', () => {
    const legacyCfg = {
      ...(baseLegacyArtifact().config as unknown as Record<string, unknown>),
      subtasks: [{ content: 'a' }, { content: 'b' }],
      maxRuns: 5,
    };
    const a = normalizeLoadedRunArtifact(
      baseLegacyArtifact({
        config: legacyCfg as unknown as RunArtifact['config'],
        subtasks: [],
        currentSubtaskIndex: 99,
      }),
    );
    expect(a.subtasks).toHaveLength(2);
    expect(a.currentSubtaskIndex).toBe(1);
  });

  it('fills subtaskIndex and subtaskAttempt on legacy round summaries', () => {
    const legacySummary = {
      attempt: 2,
      phase: 'tests_failed' as const,
      innerRoundCount: 0,
      innerRounds: [],
      commitCount: 0,
      patchBytes: 0,
      startedAt: 'a',
      completedAt: 'b',
    } as unknown as OuterAttemptSummary;
    const a = normalizeLoadedRunArtifact(
      baseLegacyArtifact({
        roundSummaries: [legacySummary],
      }),
    );
    expect(a.roundSummaries?.[0]).toMatchObject({
      subtaskIndex: 0,
      subtaskAttempt: 2,
    });
  });
});

describe('syncConfigSubtasksFromArtifact', () => {
  it('writes config.subtasks from runtime rows (inputs only)', () => {
    const normalized = normalizeLoadedRunArtifact(baseLegacyArtifact());
    const a: RunArtifact = {
      ...normalized,
      subtasks: [
        {
          id: 'id1',
          title: 'T',
          content: 'body',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          gateRetries: 3,
        },
      ],
      config: {
        ...normalized.config,
        subtasks: [{ content: 'stale' }],
      },
    };
    const synced = syncConfigSubtasksFromArtifact(a);
    expect(synced.config.subtasks).toEqual([{ title: 'T', content: 'body', gateRetries: 3 }]);
  });
});

describe('Block 4 phaseBaseRef — runtime-only field, must survive persist/reload', () => {
  // Why this test exists:
  //   `phaseBaseRef` is intentionally NOT part of `RunSubtaskInput` (per the
  //   Block 4 plan: "runtime state, not config"). On resume, the loop reads
  //   it back from the impl row to render `{{phase.baseRef}}` in critic
  //   prompts. The contract is load-bearing on three things:
  //
  //   1. JSON-serialising `artifact.subtasks` preserves `phaseBaseRef`
  //      (default `JSON.stringify` behaviour for own enumerable string
  //      fields — no dropping).
  //   2. `normalizeLoadedRunArtifact` does NOT re-derive `subtasks` from
  //      `cfg.subtasks` when `artifact.subtasks` is non-empty (which it
  //      always is post-Block-4). Re-deriving would lose `phaseBaseRef`
  //      because `runSubtasksFromInputs` doesn't carry it through.
  //   3. The resume-path consumers in `modes.ts` clone with `{...s}` rather
  //      than running through `runSubtasksFromInputs`.
  //
  //   Anyone who tightens (2) — e.g. "always re-derive for consistency" —
  //   silently breaks critic resume. Lock the survival here.
  it('JSON round-trip preserves phaseBaseRef on impl rows', () => {
    const original: RunArtifact = {
      ...normalizeLoadedRunArtifact(baseLegacyArtifact()),
      subtasks: [
        {
          id: 'impl-1',
          title: 'phase:01-core impl',
          content: 'implement core',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          phaseId: '01-core',
          phaseBaseRef: 'deadbeef1234',
        },
        {
          id: 'crit-1',
          title: 'phase:01-core critic:strict round:1/1 discover',
          content: 'audit phase {{phase.baseRef}}',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          phaseId: '01-core',
        },
      ],
    };

    const persisted: RunArtifact = JSON.parse(JSON.stringify(original));
    const reloaded = normalizeLoadedRunArtifact(persisted);

    // phaseBaseRef survives the persist/normalize cycle on the impl row.
    expect(reloaded.subtasks[0]?.phaseBaseRef).toBe('deadbeef1234');
    // Critic row stays free of it (only impl rows carry it).
    expect(reloaded.subtasks[1]?.phaseBaseRef).toBeUndefined();
    // phaseId is also preserved on both rows so the loop can re-pair them.
    expect(reloaded.subtasks[0]?.phaseId).toBe('01-core');
    expect(reloaded.subtasks[1]?.phaseId).toBe('01-core');
  });

  it('does NOT round-trip phaseBaseRef through cfg.subtasks (intentional — runtime-only)', () => {
    // Sanity check: if syncConfigSubtasksFromArtifact stripped phaseBaseRef
    // (which it should, since RunSubtaskInput doesn't carry it), and a
    // future bug made normalizeLoadedRunArtifact re-derive subtasks from
    // cfg.subtasks even when artifact.subtasks is non-empty, phaseBaseRef
    // would silently disappear. Lock the cfg.subtasks shape.
    const a: RunArtifact = {
      ...normalizeLoadedRunArtifact(baseLegacyArtifact()),
      subtasks: [
        {
          id: 'x',
          title: 'impl',
          content: 'body',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          phaseId: '01-core',
          phaseBaseRef: 'shouldnotleak',
        },
      ],
    };
    const synced = syncConfigSubtasksFromArtifact(a);
    // phaseId DOES go through (it's on RunSubtaskInput).
    expect(synced.config.subtasks[0]).toMatchObject({ phaseId: '01-core' });
    // phaseBaseRef DOES NOT — it's runtime-only.
    expect(synced.config.subtasks[0]).not.toHaveProperty('phaseBaseRef');
  });
});
