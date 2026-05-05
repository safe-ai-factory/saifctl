/**
 * Normalizes run artifacts loaded from disk (legacy shapes → current {@link RunArtifact}).
 */

import type { OuterAttemptSummary, RunArtifact } from '../types.js';
import type { SerializedLoopOpts } from './serialize.js';
import { runSubtasksFromInputs, runSubtasksToInputs } from './subtasks.js';

type LegacyConfig = SerializedLoopOpts &
  Record<string, unknown> & {
    maxRuns?: number;
    featureRelativePath?: string;
  };

function normalizeConfig(config: LegacyConfig): SerializedLoopOpts {
  const maxAttemptsPerSubtask =
    typeof config.maxAttemptsPerSubtask === 'number'
      ? config.maxAttemptsPerSubtask
      : typeof config.maxRuns === 'number'
        ? config.maxRuns
        : 5;

  const featureName = String(config.featureName ?? '');
  const saifctlDir = String(config.saifctlDir ?? 'saifctl');
  const derivedFeaturePath = `${saifctlDir}/features/${featureName}`;

  const subtasks =
    Array.isArray(config.subtasks) && config.subtasks.length > 0
      ? config.subtasks
      : [{ content: `Implement feature: ${featureName || 'run'}` }];

  const featureRelativePath =
    typeof config.featureRelativePath === 'string' && config.featureRelativePath.trim()
      ? config.featureRelativePath.trim()
      : derivedFeaturePath;

  const { maxRuns: _maxRuns, ...rest } = config;

  return {
    ...(rest as Omit<
      LegacyConfig,
      'maxRuns' | 'maxAttemptsPerSubtask' | 'subtasks' | 'featureRelativePath'
    >),
    maxAttemptsPerSubtask,
    subtasks,
    featureRelativePath,
  } as SerializedLoopOpts;
}

function normalizeRoundSummaries(
  summaries: readonly OuterAttemptSummary[] | undefined,
): OuterAttemptSummary[] | undefined {
  if (summaries == null) return summaries;
  return summaries.map((s) => {
    if (s.subtaskIndex !== undefined && s.subtaskAttempt !== undefined) return s;
    return {
      ...s,
      subtaskIndex: 0,
      subtaskAttempt: s.attempt,
    };
  });
}

/**
 * Ensures {@link RunArtifact} matches the current schema (subtasks, config keys, round summaries).
 * Safe to call on freshly loaded JSON.
 */
export function normalizeLoadedRunArtifact(artifact: RunArtifact): RunArtifact {
  const legacySpecRef = (artifact as RunArtifact & { specRef?: string }).specRef;
  const cfg = normalizeConfig(artifact.config as LegacyConfig);

  let subtasks = artifact.subtasks;
  if (!subtasks?.length) {
    subtasks = runSubtasksFromInputs(cfg.subtasks);
    if (typeof legacySpecRef === 'string' && legacySpecRef.trim() && subtasks[0]) {
      subtasks[0] = { ...subtasks[0], title: legacySpecRef.trim() };
    }
  }

  const currentSubtaskIndex =
    typeof artifact.currentSubtaskIndex === 'number' &&
    Number.isFinite(artifact.currentSubtaskIndex)
      ? Math.min(Math.max(0, artifact.currentSubtaskIndex), Math.max(0, subtasks.length - 1))
      : 0;

  const {
    specRef: _sr,
    taskId: _tid,
    ...rest
  } = artifact as RunArtifact & {
    specRef?: string;
    taskId?: string;
  };

  return {
    ...rest,
    config: cfg,
    subtasks,
    currentSubtaskIndex,
    sandboxHostAppliedCommitCount:
      typeof artifact.sandboxHostAppliedCommitCount === 'number'
        ? artifact.sandboxHostAppliedCommitCount
        : 0,
    roundSummaries: normalizeRoundSummaries(artifact.roundSummaries),
  };
}

/** Updates {@link SerializedLoopOpts#subtasks} from live {@link RunArtifact#subtasks} before persisting. */
export function syncConfigSubtasksFromArtifact(artifact: RunArtifact): RunArtifact {
  return {
    ...artifact,
    config: {
      ...artifact.config,
      subtasks: runSubtasksToInputs(artifact.subtasks),
    },
  };
}
