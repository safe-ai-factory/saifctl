/**
 * Phase: run-coding-phase
 *
 * Runs one coding attempt inside the iterative loop: engine lifecycle (via
 * {@link runEngineAttempt}), rules watcher, optional {@link driveSubtasks}
 * concurrent with the container, and pause / stop / teardown routing.
 *
 * Unlike {@link runAgentPhase} (used by the Hatchet workflow), this phase is
 * control-signal-aware: it wires up an {@link AbortController} that fires when
 * the user issues a `saifctl run pause` or `saifctl run stop` mid-run, and
 * handles each outcome distinctly:
 *
 *   - **pause** → `pauseInfra()` (compose pause; remove Leash/coder containers), emit `CodingPhaseResult { outcome: 'paused' }`
 *   - **stop**  → `teardown()`, emit `CodingPhaseResult { outcome: 'stopped' }`
 *   - **normal exit** → `teardown()`, emit `CodingPhaseResult { outcome: 'completed' }`
 *
 * On pause/stop after a mid-round abort, uncommitted/untracked work in `sandbox.codePath`
 * is committed and returned as `commits` for the run artifact merge.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LiveInfra } from '../../engines/types.js';
import { consola } from '../../logger.js';
import {
  appendMissingRunRules,
  formatRuleBlockForPending,
  pendingRulesPath,
  rulesForPrompt,
  startRulesWatcher,
} from '../../runs/rules.js';
import type { RunStorage } from '../../runs/storage.js';
import {
  type RunCommit,
  type RunSubtask,
  SAIFCTL_ENGINE_EXITED_REASON,
  SAIFCTL_PAUSE_ABORT_REASON,
  SAIFCTL_STOP_ABORT_REASON,
} from '../../runs/types.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { appendUtf8 } from '../../utils/io.js';
import type { IterativeLoopOpts, RunStorageContext } from '../loop.js';
import {
  extractIncrementalRoundPatch,
  type PatchExcludeRule,
  pollSubtaskDone,
  type Sandbox,
  updateSandboxSubtaskScripts,
  writeSubtaskExitSignal,
  writeSubtaskNextPrompt,
  writeSubtaskRetriesOverride,
} from '../sandbox.js';
import { readInnerRounds, roundsStatsPath } from '../stats.js';
import { runEngineAttempt } from './run-engine-attempt.js';
import type {
  CodingPhaseResult,
  OnSubtaskComplete,
  SubtaskCodingResult,
  SubtaskDriverAction,
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { CodingPhaseResult, OnSubtaskComplete, SubtaskCodingResult, SubtaskDriverAction };

/** Options for {@link runCodingPhase}. */
export interface RunCodingPhaseOpts {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed). Used for engine label and patch commit messages. */
  attempt: number;
  /** Error feedback from the previous test run (empty string on first attempt). */
  errorFeedback: string;
  /** Initial task string for the first subtask (plan + rules + feedback merged by the loop). */
  task: string;
  /**
   * Subtasks still to execute from the current cursor, in order.
   * The first entry's body should match {@link task} (the container's `SAIFCTL_INITIAL_TASK`).
   */
  subtasks: RunSubtask[];
  /** 0-based index of {@link subtasks}[0] within the full run artifact list. */
  startSubtaskIndex: number;
  /**
   * Invoked after each `subtask-done` signal while the container stays alive.
   * Not used when {@link IterativeLoopOpts#inspectMode} is set.
   */
  onSubtaskComplete: OnSubtaskComplete;
  /**
   * On `run resume`: coding {@link LiveInfra} from the paused artifact.
   * When set, `Engine.setup()` is skipped so the existing Docker network / compose stack
   * is reused instead of being recreated.
   */
  resumedCodingInfra: LiveInfra | null;
  /** Run storage + mutable context for the rules watcher. Null when storage is disabled. */
  storage: { runStorage: RunStorage; runContext: RunStorageContext } | null;
  registry: CleanupRegistry | null;
  opts: Pick<
    IterativeLoopOpts,
    | 'llm'
    | 'projectDir'
    | 'projectName'
    | 'feature'
    | 'dangerousNoLeash'
    | 'coderImage'
    | 'gateRetries'
    | 'agentEnv'
    | 'agentSecretKeys'
    | 'agentSecretFiles'
    | 'agentProfileId'
    | 'reviewerEnabled'
    | 'codingEnvironment'
    | 'saifctlDir'
    | 'inspectMode'
    | 'enableSubtaskSequence'
    | 'sandboxInteractive'
  >;
  /**
   * Called immediately after the coding engine is set up and the first {@link LiveInfra}
   * snapshot is available. Allows the caller to persist live resources to the run artifact
   * before `runAgent` starts, so a crash mid-round still has an accurate list for cleanup.
   */
  onInfraReady?: (infra: LiveInfra) => Promise<void>;
  /** When set, abort the agent on Hatchet step cancellation. */
  signal?: AbortSignal;
  /**
   * When set, this controller is used for pause/stop and must be the same object the loop
   * uses to abort from {@link RunCodingPhaseOpts#onSubtaskComplete} (e.g. max attempts).
   */
  codingAbortController?: AbortController;
  /** `git rev-parse HEAD` at coding start — diff base for pause/stop commit extraction. */
  preRoundHeadSha: string;
  /** Paths stripped from extracted patches (reward-hacking guardrails, etc.). */
  patchExclude: PatchExcludeRule[];
}

// ---------------------------------------------------------------------------
// Subtask driver (host ↔ coder-start.sh)
// ---------------------------------------------------------------------------
// Waits on subtask-done signals from the container, reads inner-round stats, then calls
// onSubtaskComplete. The callback returns exit / next / retry / abort; we write the matching
// prompt, gate/agent script updates, retries override, or exit file so coder-start.sh can proceed.

async function driveSubtasks(opts: {
  sandbox: Sandbox;
  subtasks: RunSubtask[];
  startSubtaskIndex: number;
  controlAbort: AbortController;
  enableSubtaskSequence: boolean;
  onSubtaskComplete: OnSubtaskComplete;
  subtaskResults: SubtaskCodingResult[];
}): Promise<void> {
  const {
    sandbox,
    subtasks,
    startSubtaskIndex,
    controlAbort,
    enableSubtaskSequence,
    onSubtaskComplete,
    subtaskResults,
  } = opts;

  let relativeIdx = 0;

  while (true) {
    const subtask = subtasks[relativeIdx];
    // Slice exhausted (e.g. start index past end): tell shell to exit the inner loop if enabled.
    if (!subtask) {
      if (enableSubtaskSequence) {
        await writeSubtaskExitSignal(sandbox.sandboxBasePath);
      }
      return;
    }

    const absoluteIdx = startSubtaskIndex + relativeIdx;

    let doneResult: Awaited<ReturnType<typeof pollSubtaskDone>>;
    try {
      doneResult = await pollSubtaskDone(sandbox.sandboxBasePath, controlAbort.signal);
    } catch {
      consola.log('[subtask-driver] pollSubtaskDone aborted or failed — stopping driver.');
      return;
    }

    const innerRounds = await readInnerRounds(roundsStatsPath(sandbox.sandboxBasePath));
    const result: SubtaskCodingResult = {
      subtaskIndex: absoluteIdx,
      innerExitCode: doneResult.exitCode,
      innerRounds,
    };
    subtaskResults.push(result);

    let action: SubtaskDriverAction;
    // Outer loop (patch/tests/retries) decides how the inner shell should continue.
    try {
      action = await onSubtaskComplete(result);
    } catch (err) {
      consola.error('[subtask-driver] onSubtaskComplete threw — aborting container.', err);
      controlAbort.abort(SAIFCTL_STOP_ABORT_REASON);
      return;
    }

    switch (action.kind) {
      case 'exit':
        // Run finished successfully (or sandbox fast-path): signal clean inner shutdown.
        if (enableSubtaskSequence) {
          await writeSubtaskExitSignal(sandbox.sandboxBasePath);
        }
        return;
      case 'abort':
        // stop/max-attempts/etc. — engine abort already requested; driver just stops.
        return;
      case 'next': {
        relativeIdx += 1;
        // Last subtask done: same as exit for the shell protocol.
        if (relativeIdx >= subtasks.length) {
          if (enableSubtaskSequence) {
            await writeSubtaskExitSignal(sandbox.sandboxBasePath);
          }
          return;
        }
        await updateSandboxSubtaskScripts({
          saifctlPath: sandbox.saifctlPath,
          gateScript: action.gateScript,
          agentScript: action.agentScript,
        });
        if (action.gateRetries !== undefined) {
          await writeSubtaskRetriesOverride(sandbox.sandboxBasePath, action.gateRetries);
        }
        await writeSubtaskNextPrompt(sandbox.sandboxBasePath, action.prompt);
        break;
      }
      case 'retry': {
        // Same subtask row, new task text (outer attempt / feedback).
        if (action.gateRetries !== undefined) {
          await writeSubtaskRetriesOverride(sandbox.sandboxBasePath, action.gateRetries);
        }
        await writeSubtaskNextPrompt(sandbox.sandboxBasePath, action.prompt);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Aborts `controlAbort` with {@link SAIFCTL_ENGINE_EXITED_REASON} when the
 * engine promise settles, unless the abort is already set (e.g. by a user
 * `run pause` / `run stop`).
 *
 * Why this exists — the deadlock it prevents:
 *   `runCodingPhase` does `await Promise.all([enginePromise, driverPromise])`.
 *   The driver blocks in `pollSubtaskDone` waiting for the container's
 *   coder-start.sh to write a `subtask-done` file. If the container exits
 *   without writing that file (most commonly because of a `set -e` death
 *   between the inner-loop end and the explicit `printf > $SUBTASK_DONE_PATH`
 *   line; OOM-kill, SIGKILL, and Leash crashes also qualify), the engine
 *   resolves but the driver polls forever. `Promise.all` never settles.
 *
 * `coder-start.sh` also has a `trap EXIT` that writes the done signal as a
 * shell-level safety net. This function is the orchestrator-side complement
 * for the cases where even the trap can't fire (the script process is gone
 * before bash unwinds).
 *
 * Side-effect-only: the caller still awaits `enginePromise` separately to
 * read its result. Returns nothing. The `.catch()` suppresses the
 * "unhandledRejection" warning when `enginePromise` rejects — the rejection
 * is surfaced through the caller's own `await`.
 *
 * Exported for unit testing of the cross-link contract.
 */
export function wireEngineExitedAbort(opts: {
  enginePromise: Promise<unknown>;
  controlAbort: AbortController;
}): void {
  void opts.enginePromise
    .finally(() => {
      if (!opts.controlAbort.signal.aborted) {
        opts.controlAbort.abort(SAIFCTL_ENGINE_EXITED_REASON);
      }
    })
    .catch(() => {
      // Caller's own await surfaces the rejection; this catch only exists
      // to silence Node's unhandled-rejection warning on this side branch.
    });
}

/**
 * Iterative-loop coding phase: runs one coding-agent attempt with concurrent
 * subtask driver and rules watcher, routes pause/stop control signals, and
 * returns a {@link CodingPhaseResult} capturing the outcome (completed,
 * inspected, paused with infra, stopped with commits).
 */
export async function runCodingPhase(input: RunCodingPhaseOpts): Promise<CodingPhaseResult> {
  const {
    sandbox,
    attempt,
    errorFeedback,
    task,
    subtasks,
    startSubtaskIndex,
    onSubtaskComplete,
    resumedCodingInfra,
    storage,
    registry,
    opts,
    onInfraReady,
    preRoundHeadSha,
    patchExclude,
  } = input;

  const runId = sandbox.runId;

  // AbortController wired to pause/stop control signals arriving via the rules watcher.
  const controlAbort = input.codingAbortController ?? new AbortController();

  if (input.signal && input.signal !== controlAbort.signal) {
    const forward = () => {
      if (input.signal?.aborted) {
        controlAbort.abort(input.signal.reason);
      }
    };
    forward();
    input.signal.addEventListener('abort', forward, { once: true });
  }

  // Part of real-time human feedback and 'run pause' / 'run stop' control signals.
  // Poll the saved Run artifact every 2 seconds.
  // - If the refreshed Run artifact has new active rules, append them to the pending-rules file
  //   so we can include them in the task prompt for the next inner round.
  // - If the refreshed Run artifact has a control signal ('pause' or 'stop'), abort the agent.
  const rulesWatcher = (() => {
    if (!storage) return null;
    const { runStorage, runContext } = storage;
    const rc = runContext;
    const knownRuleIds = new Set(rulesForPrompt(rc.rules).map((r) => r.id));
    const pendingFile = pendingRulesPath(sandbox.sandboxBasePath);
    return startRulesWatcher({
      runStorage,
      runId,
      knownRuleIds,
      onNewRules: async (newRules) => {
        await mkdir(dirname(pendingFile), { recursive: true });
        await appendUtf8(pendingFile, formatRuleBlockForPending(newRules));
        rc.rules = appendMissingRunRules({ inMemory: rc.rules, incoming: newRules });
      },
      onArtifactRevision: (rev) => {
        rc.expectedArtifactRevision = rev;
      },
      onControlSignal: (action) => {
        controlAbort.abort(
          action === 'pause' ? SAIFCTL_PAUSE_ABORT_REASON : SAIFCTL_STOP_ABORT_REASON,
        );
      },
    });
  })();

  // Filled by driveSubtasks for CodingPhaseResult when the phase completes normally.
  const subtaskResults: SubtaskCodingResult[] = [];
  const enableSubtaskSequence = opts.enableSubtaskSequence === true;

  let result: Awaited<ReturnType<typeof runEngineAttempt>>;
  try {
    // Inspect: no subtask protocol — single engine run, idle/shell-only behavior.
    if (opts.inspectMode) {
      result = await runEngineAttempt({
        sandbox,
        attempt,
        errorFeedback,
        task,
        resumedCodingInfra,
        registry,
        signal: input.signal ?? controlAbort.signal,
        preparePendingRules: true,
        onInfraReady,
        onFinally: async ({ abortSignal }) => {
          const reason = abortSignal.aborted ? (abortSignal.reason as string) : null;
          return reason === SAIFCTL_PAUSE_ABORT_REASON ? 'pause' : 'teardown';
        },
        opts,
      });
    } else {
      // Normal coding: engine (compose + agent) and host driver run together — driver reacts to
      // each inner completion while the engine blocks until the shell exits or aborts.
      const enginePromise = runEngineAttempt({
        sandbox,
        attempt,
        errorFeedback,
        task,
        resumedCodingInfra,
        registry,
        signal: input.signal ?? controlAbort.signal,
        preparePendingRules: true,
        onInfraReady,
        onFinally: async ({ abortSignal }) => {
          const reason = abortSignal.aborted ? (abortSignal.reason as string) : null;
          return reason === SAIFCTL_PAUSE_ABORT_REASON ? 'pause' : 'teardown';
        },
        opts,
      });

      const driverPromise = driveSubtasks({
        sandbox,
        subtasks,
        startSubtaskIndex,
        controlAbort,
        enableSubtaskSequence,
        onSubtaskComplete,
        subtaskResults,
      });

      // Cross-link: when the engine resolves before the driver's last
      // `subtask-done` poll, abort the driver — otherwise it polls forever
      // for a file the dead shell will never write, deadlocking the
      // `Promise.all` below. See {@link wireEngineExitedAbort}.
      wireEngineExitedAbort({ enginePromise, controlAbort });

      // Both must finish: driver ends when the shell stops consuming subtasks; engine returns teardown/pause outcome.
      [result] = await Promise.all([enginePromise, driverPromise]);
    }
  } finally {
    // Stop the rules watcher when the coding phase completes.
    rulesWatcher?.stop();
  }

  const abortReason = controlAbort.signal.aborted ? (controlAbort.signal.reason as string) : null;

  // Extract the commits that were made after the control signal was issued.
  const commitsAfterControlAbort = async (): Promise<RunCommit[]> => {
    const { commits } = await extractIncrementalRoundPatch(sandbox.codePath, {
      preRoundHeadSha,
      attempt,
      exclude: patchExclude,
    });
    return commits;
  };

  // User issued `saifctl run pause`; infra is frozen and must be persisted.
  if (abortReason === SAIFCTL_PAUSE_ABORT_REASON) {
    return {
      outcome: 'paused',
      liveInfra: result.infra,
      commits: await commitsAfterControlAbort(),
    };
  }

  // User issued `saifctl run stop`; infra has been torn down.
  if (abortReason === SAIFCTL_STOP_ABORT_REASON) {
    return { outcome: 'stopped', commits: await commitsAfterControlAbort() };
  }

  // Engine container exited before the driver received its final
  // `subtask-done` signal (set above by the .finally on enginePromise).
  // `subtaskResults` is empty (or partial) in this case; the caller observes
  // no successful subtask and marks the run failed. We deliberately fall
  // through to the standard `completed` return rather than a dedicated
  // outcome so the caller's failure-handling path is the same as a
  // normal-exit-with-no-commits run — there is no infra to preserve and no
  // distinct user-facing recovery action ("the container died" reduces to
  // "the run failed; try again or read the logs"). The abort reason is the
  // diagnostic — if a future caller needs to distinguish, surface it via
  // the result type.
  if (abortReason === SAIFCTL_ENGINE_EXITED_REASON) {
    consola.warn(
      '[run-coding-phase] Engine container exited without a final subtask-done signal; ' +
        'treating as failure. See harness logs for the underlying cause (often a `set -e` ' +
        'death in coder-start.sh between inner-loop end and the explicit done-signal write).',
    );
  }

  // Inspect session completed — skip tests, git branch, and further iterations.
  if (opts.inspectMode) {
    return { outcome: 'inspected' };
  }

  // Agent ran to completion (success or failure — caller checks the patch).
  return { outcome: 'completed', infra: result.infra!, subtaskResults };
}
