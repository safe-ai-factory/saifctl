/**
 * Clone a Run to a new artifact ID (no orchestration — no worktree, sandbox, or agent loop).
 */

import type { FromArtifactOpts } from '../orchestrator/modes.js';
import { resolveOrchestratorOpts } from '../orchestrator/options.js';
import { resolveFeature } from '../specs/discover.js';
import { cloneRunRules } from './rules.js';
import type { RunStorage } from './storage.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from './utils/artifact.js';
import { deserializeArtifactConfig } from './utils/serialize.js';

/** Same inputs as `run start` / {@link FromArtifactOpts}; used by `saifctl run fork`. */
export type ForkStoredRunOpts = FromArtifactOpts;

async function allocateUnusedRunId(runStorage: RunStorage): Promise<string> {
  for (let i = 0; i < 32; i++) {
    const id = Math.random().toString(36).substring(2, 9);
    if ((await runStorage.getRun(id)) == null) return id;
  }
  throw new Error('Could not allocate a unique run ID after 32 attempts.');
}

/**
 * Clones a Run to a new run ID: same base commit, base patch, and run commits as the source;
 * config is merged from the source artifact and CLI the same way as `run start` (defaults → artifact → CLI).
 *
 * Does not create a worktree, sandbox, or agent loop — use `saifctl run start <newId>` next.
 */
export async function forkStoredRun(opts: ForkStoredRunOpts): Promise<{ newRunId: string }> {
  const {
    runId: sourceRunId,
    projectDir,
    saifctlDir,
    runStorage,
    cli,
    cliModelDelta,
    config,
    engineCli,
  } = opts;

  const source = await runStorage.getRun(sourceRunId);
  if (!source) {
    throw new Error(`Run not found: ${sourceRunId}. List runs with: saifctl run ls`);
  }

  const deserialized = deserializeArtifactConfig(source.config);
  const feature = await resolveFeature({
    input: deserialized.featureName,
    projectDir,
    saifctlDir: deserialized.saifctlDir,
  });

  const mergedOpts = await resolveOrchestratorOpts({
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    artifact: source,
    engineCli,
  });

  const { runStorage: _rs, fromArtifact: _fromArtifact, ...artifactLoopOpts } = mergedOpts;
  const newRunId = await allocateUnusedRunId(runStorage);

  const forked = buildRunArtifact({
    runId: newRunId,
    baseCommitSha: source.baseCommitSha,
    basePatchDiff: source.basePatchDiff,
    runCommits: source.runCommits.map((c) => ({ ...c })),
    sandboxHostAppliedCommitCount: source.sandboxHostAppliedCommitCount,
    subtasks: source.subtasks.map((s) => ({ ...s })),
    currentSubtaskIndex: source.currentSubtaskIndex,
    lastFeedback: source.lastFeedback,
    rules: cloneRunRules(source.rules),
    roundSummaries: source.roundSummaries,
    status: 'failed',
    controlSignal: source.controlSignal ?? null,
    pausedSandboxBasePath: source.pausedSandboxBasePath ?? null,
    liveInfra: source.liveInfra ?? null,
    inspectSession: null,
    opts: artifactLoopOpts as BuildRunArtifactOpts,
  });

  await runStorage.saveRun(newRunId, forked);
  return { newRunId };
}
