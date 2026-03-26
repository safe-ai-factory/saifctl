/**
 * Builds a RunArtifact from loop state for persistence.
 */

import type { IterativeLoopOpts } from '../../orchestrator/loop.js';
import type { OuterAttemptSummary, RunArtifact, RunCommit, RunRule, RunStatus } from '../types.js';
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
  specRef: string;
  lastFeedback?: string;
  status: RunStatus;
  rules: RunRule[];
  opts: BuildRunArtifactOpts;
  roundSummaries?: OuterAttemptSummary[];
}

/**
 * Constructs a RunArtifact for saving to run storage.
 */
export function buildRunArtifact(params: BuildRunArtifactParams): RunArtifact {
  const now = new Date().toISOString();
  const { initialErrorFeedback: _ignored, ...serializeOpts } = params.opts;
  const config = serializeArtifactConfig(serializeOpts);
  return {
    runId: params.runId,
    baseCommitSha: params.baseCommitSha,
    basePatchDiff: params.basePatchDiff,
    runCommits: params.runCommits,
    specRef: params.specRef,
    lastFeedback: params.lastFeedback,
    config,
    status: params.status,
    startedAt: now,
    updatedAt: now,
    rules: params.rules ?? [],
    roundSummaries: params.roundSummaries,
  };
}
