/**
 * Run storage types for persisting agent run artifacts.
 *
 * Persisted for every run when storage is enabled for `run ls`, `run start`, and tests.
 */

import type { LiveInfra } from '../engines/types.js';
import type { SerializedLoopOpts } from './utils/serialize.js';

export type { DockerLiveInfra, LiveInfra, LocalLiveInfra } from '../engines/types.js';

/** Lifecycle state of a run artifact — terminal (`failed`/`completed`), live (`running`/`paused`/`inspecting`), or transitional. */
export type RunStatus =
  | 'failed'
  | 'completed'
  | 'running'
  | 'paused'
  | 'inspecting'
  /** CLI/orchestrator is beginning `run start` / `feat run` before the loop marks `running`. */
  | 'starting'
  /** `run pause` requested; orchestrator is winding down to `paused`. */
  | 'pausing'
  /** `run stop` requested while live; orchestrator tearing down to `failed`. */
  | 'stopping'
  /** `run resume` handoff before the loop marks `running`. */
  | 'resuming';

/**
 * Live inspect session metadata while {@link RunStatus} is `"inspecting"`.
 * Cleared when the session ends; used by tooling (e.g. VS Code) to attach to the idle coder container.
 */
export interface RunInspectSession {
  /** Docker container name (Leash target or `docker run --name`). */
  containerName: string;
  /**
   * Full Docker container ID from `docker inspect` (64-char hex). Prefer for editor attach when set.
   * `null` when we failed to resolve the container ID.
   */
  containerId: string | null;
  /** In-container workspace path (bind-mounted sandbox code). */
  workspacePath: string;
  /** When the inspect session became ready for attach. */
  startedAt: string;
}

/** Passed to `AbortController.abort()` when `run pause` requests a cooperative stop. */
export const SAIFCTL_PAUSE_ABORT_REASON = 'saifctl-pause';

/** Passed to `AbortController.abort()` when `run stop` requests immediate teardown. */
export const SAIFCTL_STOP_ABORT_REASON = 'saifctl-stop';

/**
 * Passed to `AbortController.abort()` when the coder engine container exited
 * before the host driver received a `subtask-done` signal — i.e. the shell
 * died (silent `set -e`, OOM-kill, signal) without writing the protocol's
 * exit-code handshake file. Without this abort, `pollSubtaskDone` would poll
 * forever and `Promise.all([engine, driver])` would deadlock.
 *
 * Treated by `runCodingPhase` as a normal completion-with-failure (no
 * subtask results, caller marks the run failed). Distinct from `pause` /
 * `stop` so callers can tell user-initiated control from container death.
 */
export const SAIFCTL_ENGINE_EXITED_REASON = 'saifctl-engine-exited';

/** External control signal a user can request via `run pause` / `run stop`. */
export type RunControlAction = 'pause' | 'stop';

/**
 * Last-write-wins control from `run pause` / `run stop` while an orchestrator is active.
 * Cleared when the run leaves {@link RunStatus} `"running"` or the signal is consumed.
 */
export interface RunControlSignal {
  action: RunControlAction;
  requestedAt: string;
}

/** Thrown by {@link RunStorage.requestPause} when the run is not active. */
export class RunCannotPauseError extends Error {
  override readonly name = 'RunCannotPauseError';

  constructor(
    readonly runId: string,
    readonly status: RunStatus,
  ) {
    super(
      `Run "${runId}" cannot be paused (status: "${status}"). Only a run with status "running" can be paused.`,
    );
  }
}

/** Thrown by {@link RunStorage.requestStop} when the run cannot be stopped. */
export class RunCannotStopError extends Error {
  override readonly name = 'RunCannotStopError';

  constructor(
    readonly runId: string,
    readonly status: RunStatus,
  ) {
    super(
      `Run "${runId}" cannot be stopped (status: "${status}"). ` +
        `Stop applies to live or transitional runs (running, paused, starting, pausing, stopping, resuming).`,
    );
  }
}

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

/** Summary of one inner agent → gate → reviewer iteration within an outer attempt. */
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
export type OuterAttemptPhase =
  | 'no_changes'
  | 'tests_passed'
  | 'tests_failed'
  | 'aborted'
  /** Agent finished; staging tests skipped (`skipStagingTests`, e.g. sandbox / POC designer). */
  | 'sandbox_complete';

/**
 * Compile-time-known critic prompt metadata (Block 4 of TODO_phases_and_critics).
 *
 * The compiler emits one of these on every critic subtask. Everything except
 * `phase.baseRef` is known at compile time — `baseRef` is the git rev at the
 * start of the phase's implementer subtask and is captured by the loop just
 * before the critic subtask becomes the active row. The renderer in
 * `src/specs/phases/critic-prompt.ts` consumes this metadata together with
 * the runtime `phase.baseRef` to mustache-render the subtask's `content`.
 *
 * `content` on the subtask carries the raw `critics/<id>.md` body — the
 * manifest stays faithful to what the user wrote. Rendering is a runtime
 * concern; the artifact is never mutated.
 */
export interface RunSubtaskCriticPrompt {
  criticId: string;
  /** 1-based round counter; matches the subtask title. */
  round: number;
  totalRounds: number;
  /**
   * Each critic round compiles to two subtasks: 'discover' (writes findings
   * to {@link findingsPath}; does NOT modify code) and 'fix' (reads findings,
   * applies fixes, deletes the file). See §6 of the planning doc.
   */
  step: 'discover' | 'fix';
  /**
   * Container-side path (under `/workspace`) of the temp findings file
   * shared between this round's discover + fix subtasks. Pinned per
   * (phase, critic, round) so re-runs are deterministic.
   */
  findingsPath: string;
  /**
   * Mustache `feature.*` and `phase.{id,dir,spec,tests}` values precomputed
   * by the compiler. Inlined here so the loop can render without re-walking
   * the feature dir. `phase.baseRef` is filled in by the loop.
   */
  vars: {
    feature: { name: string; dir: string; plan: string };
    phase: { id: string; dir: string; spec: string; tests: string };
  };
}

/**
 * Per-subtask test scope — the gate's view of which test directories are
 * in-scope for this subtask.
 *
 * - `include`: absolute paths (host-side) to test directories that should be
 *   merged into the gate's testsDir. Each path follows the same `tests/`
 *   layout the test runner expects (`public/`, `hidden/`, `helpers.ts`,
 *   `infra.spec.ts`). Caller (Block 3 phase compiler) is responsible for
 *   producing absolute paths; the loop does not validate them.
 * - `cumulative`: when `true` (default), prior subtasks' `include` paths are
 *   prepended in subtask order — phases use this so phase N gates on
 *   `phases/01..N/tests/` cumulatively. Set `false` for an isolated scope
 *   that ignores prior subtasks (e.g. spike phases).
 *
 * When `testScope` is omitted (legacy / non-phased path), the loop uses the
 * feature's `tests/` directory verbatim — no behavior change.
 */
export interface RunSubtaskTestScope {
  include?: string[];
  cumulative?: boolean;
}

/**
 * Serialized subtask definition (manifest / {@link RunArtifact#config}).
 * Runtime fields (`id`, `status`, timestamps) are assigned by the orchestrator.
 */
export interface RunSubtaskInput {
  title?: string;
  content: string;
  gateScript?: string;
  agentScript?: string;
  gateRetries?: number;
  reviewerEnabled?: boolean;
  agentEnv?: Record<string, string>;
  testScope?: RunSubtaskTestScope;
  /**
   * Phase id this subtask belongs to (Block 4). Set by the phase compiler on
   * every emitted subtask (impl + each critic round). Used by the loop to
   * capture `phase.baseRef` when an impl subtask starts and to look it up
   * again when subsequent critic subtasks for that phase render.
   *
   * Omitted on legacy / non-phased subtasks; loop has no per-phase tracking
   * for those.
   */
  phaseId?: string;
  /**
   * Present on critic subtasks (Block 4). Tells the loop to mustache-render
   * `content` against the closed variable set + the runtime baseRef before
   * invoking the agent. Absence ⇒ `content` is used verbatim (impl subtasks,
   * legacy non-phased path).
   */
  criticPrompt?: RunSubtaskCriticPrompt;
}

/**
 * One unit of work within a run. Single-task runs use a one-element {@link RunArtifact#subtasks} list.
 */
export interface RunSubtask {
  id: string;
  title?: string;
  content: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  gateScript?: string;
  agentScript?: string;
  gateRetries?: number;
  reviewerEnabled?: boolean;
  agentEnv?: Record<string, string>;
  testScope?: RunSubtaskTestScope;
  /** See {@link RunSubtaskInput#phaseId}. Round-tripped through the manifest. */
  phaseId?: string;
  /** See {@link RunSubtaskInput#criticPrompt}. Round-tripped through the manifest. */
  criticPrompt?: RunSubtaskCriticPrompt;
  /**
   * Block 4 runtime state — git rev at the start of this phase's impl
   * subtask. Captured by the loop the first time the impl subtask is
   * activated; reused by every critic subtask in the same phase to render
   * `{{phase.baseRef}}` in their mustache templates.
   *
   * Only meaningful on impl subtasks (those with `phaseId` and no
   * `criticPrompt`). Critic subtasks read this from their phase's impl row.
   *
   * Runtime-only — intentionally NOT mirrored on `RunSubtaskInput` (per the
   * Block 4 plan clarification "Do NOT persist into `RunSubtaskInput` (it's
   * runtime state, not config)"). Resume preserves this via
   * `seedSubtasks` (which clones `artifact.subtasks` directly without going
   * through the manifest-stripping `runSubtasksToInputs` round-trip).
   */
  phaseBaseRef?: string;
}

/** Summary of one orchestrator outer attempt — its position in the run, the test phase outcome, and rolled-up inner-round/commit metrics. */
export interface OuterAttemptSummary {
  /** 1-based outer attempt index (monotonic across the whole run). */
  attempt: number;
  /** 0-based index into {@link RunArtifact#subtasks}. */
  subtaskIndex: number;
  /** 1-based attempt counter within the current subtask. */
  subtaskAttempt: number;
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

/** Thrown by {@link RunStorage.saveRun} when `ifRevisionEquals` does not match the stored {@link RunArtifact#artifactRevision}. */
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

/**
 * Thrown by {@link RunStorage.setStatusRunning} when the Run is already active in a conflicting way
 * (e.g. `running`, `inspecting`, or mid-transition).
 */
export class RunAlreadyRunningError extends Error {
  override readonly name = 'RunAlreadyRunningError';

  constructor(readonly runId: string) {
    super(
      `Run "${runId}" is already active or mid-transition (cannot enter "running"). ` +
        `If the process died without saving a final status, manually edit or delete the run artifact ` +
        `(e.g. .saifctl/runs/${runId}.json).`,
    );
  }
}

/**
 * Live infra keyed by environment. Stores infra-specific details.
 * Written incrementally as resources are created; cleared after teardown.
 */
export interface RunLiveInfra {
  coding: LiveInfra | null;
  staging: LiveInfra | null;
}

/** Persisted state of a single run — base commit + replayed commits, subtask list, lifecycle status, user rules, serialized config, and live-infra/inspect-session pointers. */
export interface RunArtifact {
  runId: string;

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

  /**
   * How many leading entries of {@link runCommits} were already applied to the host working tree
   * via sandbox extract (`host-apply` / `host-apply-filtered`). Used to resume without double-applying
   * after incremental per-subtask extract.
   */
  sandboxHostAppliedCommitCount: number;

  /** Ordered subtasks for this run (single-task runs have exactly one entry). */
  subtasks: RunSubtask[];
  /** Index into {@link subtasks} for the active subtask (0-based). */
  currentSubtaskIndex: number;

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

  /**
   * Set by `run pause` / `run stop` while the orchestrator polls storage. Last write wins.
   * Cleared when the run is no longer `"running"` or the signal has been applied.
   */
  controlSignal: RunControlSignal | null;

  /**
   * Host sandbox directory preserved across `run pause` / `run resume` (same bind mounts).
   * Set when entering `"paused"`; cleared when resuming via the `run start` path or on completion.
   */
  pausedSandboxBasePath: string | null;

  /**
   * Resources currently provisioned for this run (containers, networks, compose project, images).
   * Populated in later phases; `null` until tracking is wired or after full teardown.
   */
  liveInfra: RunLiveInfra | null;

  /**
   * Set only while {@link RunArtifact#status} is `"inspecting"`; otherwise `null`.
   */
  inspectSession: RunInspectSession | null;
}
