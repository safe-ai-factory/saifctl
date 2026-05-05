/**
 * Builds a RunArtifact from loop state for persistence.
 */

import type { IterativeLoopOpts } from '../../orchestrator/loop.js';
import type {
  OuterAttemptSummary,
  RunArtifact,
  RunCommit,
  RunControlSignal,
  RunInspectSession,
  RunLiveInfra,
  RunRule,
  RunStatus,
  RunSubtask,
} from '../types.js';
import { syncConfigSubtasksFromArtifact } from './normalize-artifact.js';
import { type PersistedScriptBundle, serializeArtifactConfig } from './serialize.js';

export type BuildRunArtifactOpts = Omit<
  IterativeLoopOpts,
  'registry' | 'runStorage' | 'runContext'
> &
  PersistedScriptBundle & {
    /** Loop-only; stripped before persistence */
    initialErrorFeedback?: string | null;
  };

export interface BuildRunArtifactParams {
  runId: string;
  baseCommitSha: string;
  basePatchDiff: string | undefined;
  runCommits: RunCommit[];
  sandboxHostAppliedCommitCount: number;
  subtasks: RunSubtask[];
  currentSubtaskIndex: number;
  lastFeedback?: string;
  status: RunStatus;
  rules: RunRule[];
  opts: BuildRunArtifactOpts;
  roundSummaries?: OuterAttemptSummary[];
  controlSignal: RunControlSignal | null;
  pausedSandboxBasePath: string | null;
  liveInfra: RunLiveInfra | null;
  /** Omit or `null` for normal runs; only set when persisting an active inspect session. */
  inspectSession?: RunInspectSession | null;
}

/**
 * Constructs a RunArtifact for saving to run storage.
 */
export function buildRunArtifact(params: BuildRunArtifactParams): RunArtifact {
  const now = new Date().toISOString();
  const { initialErrorFeedback: _ignored, ...serializeOpts } = params.opts;
  const config = serializeArtifactConfig(serializeOpts);
  const art: RunArtifact = {
    runId: params.runId,
    baseCommitSha: params.baseCommitSha,
    basePatchDiff: params.basePatchDiff,
    runCommits: params.runCommits,
    sandboxHostAppliedCommitCount: params.sandboxHostAppliedCommitCount,
    subtasks: params.subtasks,
    currentSubtaskIndex: params.currentSubtaskIndex,
    lastFeedback: params.lastFeedback,
    config,
    status: params.status,
    startedAt: now,
    updatedAt: now,
    rules: params.rules ?? [],
    roundSummaries: params.roundSummaries,
    controlSignal: params.controlSignal ?? null,
    pausedSandboxBasePath: params.pausedSandboxBasePath ?? null,
    liveInfra: params.liveInfra ?? null,
    inspectSession: params.inspectSession ?? null,
  };
  return syncConfigSubtasksFromArtifact(art);
}
