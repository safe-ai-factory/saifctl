/**
 * Run storage types for persisting agent run artifacts.
 *
 * Persisted for every run when storage is enabled for `run ls`, `run start`, and tests.
 */

import type { SerializedLoopOpts } from './utils/serialize.js';

export type RunStatus = 'failed' | 'completed' | 'running';

/**
 * One-off rules apply only until the coding round finishes;
 * `always` rules repeat every round.
 */
export type RunRuleScope = 'once' | 'always';

/**
 * User feedback injected into the agent task (see {@link RunArtifact#rules}).
 * `once` rules get {@link RunRule#consumedAt} set after the coding phase of
 * the round that included them.
 */
export interface RunRule {
  id: string;
  content: string;
  scope: RunRuleScope;
  createdAt: string;
  updatedAt: string;
  /** When set, a `once` rule is no longer included in the task prompt. */
  consumedAt?: string;
}

/**
 * One recorded commit in the sandbox / artifact worktree (message + unified diff + optional author).
 * Diffs apply in order on top of `baseCommitSha` + optional `basePatchDiff` + prior run commits.
 */
export interface RunCommit {
  message: string;
  diff: string;
  /** Git author line, e.g. `Name <email>`. Defaults to saifctl when omitted on apply. */
  author?: string;
}

/** Outcome of one inner iteration in coder-start.sh (agent → gate → optional reviewer). */
export type InnerRoundPhase =
  | 'agent_failed'
  | 'gate_passed'
  | 'gate_failed'
  | 'reviewer_passed'
  | 'reviewer_failed';

export interface InnerRoundSummary {
  /** 1-based inner round index within this outer attempt */
  round: number;
  phase: InnerRoundPhase;
  /** Agent/gate/reviewer output on failure; truncated in shell (~2k chars) */
  gateOutput?: string;
  startedAt: string;
  completedAt: string;
}

/** Outcome of one orchestrator outer attempt (one agent container + staging tests). */
export type OuterAttemptPhase = 'no_changes' | 'tests_passed' | 'tests_failed' | 'aborted';

export interface OuterAttemptSummary {
  /** 1-based outer attempt index */
  attempt: number;
  phase: OuterAttemptPhase;
  innerRoundCount: number;
  innerRounds: InnerRoundSummary[];
  commitCount: number;
  patchBytes: number;
  errorFeedback?: string;
  startedAt: string;
  completedAt: string;
}

/** Options for {@link RunStorage.saveRun} optimistic locking updates. */
export interface RunSaveOptions {
  /**
   * When set, the save succeeds only if the stored artifact's
   * {@link RunArtifact#artifactRevision} (missing treated as 0) equals this value.
   * Used by `run inspect` and other concurrent writers to avoid clobbering.
   */
  ifRevisionEquals?: number;
}

export class StaleArtifactError extends Error {
  override readonly name = 'StaleArtifactError';

  constructor(opts: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly actualRevision: number;
  }) {
    const { runId, expectedRevision, actualRevision } = opts;
    super(
      `Run "${runId}" artifact revision mismatch: expected ${expectedRevision}, stored ${actualRevision}. ` +
        `Another process may have updated this run; reload the artifact and retry.`,
    );
  }
}

/** Thrown by {@link RunStorage.setStatusRunning} when the stored run already has status {@link RunStatus} `"running"`. */
export class RunAlreadyRunningError extends Error {
  override readonly name = 'RunAlreadyRunningError';

  constructor(readonly runId: string) {
    super(
      `Run "${runId}" already has status "running". ` +
        `If the process died without saving a final status, manually edit or delete the run artifact ` +
        `(e.g. .saifctl/runs/${runId}.json) to clear the stale "running" status.`,
    );
  }
}

export interface RunArtifact {
  runId: string;
  taskId?: string;

  /**
   * Monotonic counter (only goes up) incremented on every successful {@link RunStorage.saveRun}.
   * Assigned by storage (callers should omit when building a new artifact).
   */
  artifactRevision?: number;

  /** Git commit SHA when the run started */
  baseCommitSha: string;
  /** Uncommitted changes at run start (git diff + git diff --cached) */
  basePatchDiff?: string;
  /** Commits from coding rounds / inspect sessions (apply in order; each diff is one replayed commit; one outer round may add several). */
  runCommits: RunCommit[];

  /** Feature path, e.g. saifctl/features/feat-stripe-webhooks */
  specRef: string;
  /** Sanitized test failure summary for Ralph Wiggum feedback */
  lastFeedback?: string;

  /** User rules appended via `saifctl run rules create` and merged into the agent task. */
  rules: RunRule[];

  /** Serialized CLI config used for this run */
  config: SerializedLoopOpts;

  status: RunStatus;
  startedAt: string;
  updatedAt: string;

  /**
   * Per-attempt summaries (inner gate rounds + test outcome), appended after each outer attempt.
   * Saved incrementally while status is `"running"` when run storage is enabled.
   */
  roundSummaries?: OuterAttemptSummary[];
}
