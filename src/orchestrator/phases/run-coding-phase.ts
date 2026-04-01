/**
 * Phase: run-coding-phase
 *
 * Runs one coding attempt inside the iterative loop: engine lifecycle (via
 * {@link runEngineAttempt}), rules watcher, and pause / stop / teardown routing.
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
 * is committed and returned as `commits` for the caller to merge into the run artifact
 * (same semantics as a completed round).
 *
 * The caller is responsible for persisting the paused `liveInfra` snapshot when
 * `outcome === 'paused'` and for routing the stopped/paused result upstream.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LiveInfra } from '../../engines/types.js';
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
  SAIFCTL_PAUSE_ABORT_REASON,
  SAIFCTL_STOP_ABORT_REASON,
} from '../../runs/types.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { appendUtf8 } from '../../utils/io.js';
import type { IterativeLoopOpts, RunStorageContext } from '../loop.js';
import { extractIncrementalRoundPatch, type PatchExcludeRule, type Sandbox } from '../sandbox.js';
import { runEngineAttempt } from './run-engine-attempt.js';
import type { CodingPhaseResult } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { CodingPhaseResult };

export interface RunCodingPhaseOpts {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed). */
  attempt: number;
  /** Error feedback from the previous test run (empty string on first attempt). */
  errorFeedback: string;
  /** Initial task string (built once per loop from plan.md + specification.md). */
  task: string;
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
    | 'overrides'
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
  >;
  /**
   * Called immediately after the coding engine is set up and the first {@link LiveInfra}
   * snapshot is available. Allows the caller to persist live resources to the run artifact
   * before `runAgent` starts, so a crash mid-round still has an accurate list for cleanup.
   */
  onInfraReady?: (infra: LiveInfra) => Promise<void>;
  /** When set, abort the agent on Hatchet step cancellation. */
  signal?: AbortSignal;
  /** `git rev-parse HEAD` at the start of this outer attempt — diff base for patch extraction. */
  preRoundHeadSha: string;
  /** Paths stripped from extracted patches (reward-hacking guardrails, etc.). */
  patchExclude: PatchExcludeRule[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function runCodingPhase(input: RunCodingPhaseOpts): Promise<CodingPhaseResult> {
  const {
    sandbox,
    attempt,
    errorFeedback,
    task,
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
  const controlAbort = new AbortController();

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

  let result: Awaited<ReturnType<typeof runEngineAttempt>>;
  try {
    result = await runEngineAttempt({
      sandbox,
      attempt,
      errorFeedback,
      task,
      resumedCodingInfra,
      registry,
      // Pass the abort signal down
      signal: input.signal ?? controlAbort.signal,
      preparePendingRules: true,
      onInfraReady,
      onFinally: async ({ abortSignal }) => {
        const reason = abortSignal.aborted ? (abortSignal.reason as string) : null;
        return reason === SAIFCTL_PAUSE_ABORT_REASON ? 'pause' : 'teardown';
      },
      opts,
    });
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

  // Inspect session completed — skip tests, git branch, and further iterations.
  if (opts.inspectMode) {
    return { outcome: 'inspected' };
  }

  // Agent ran to completion (success or failure — caller checks the patch).
  return { outcome: 'completed', infra: result.infra!, innerRounds: result.innerRounds };
}
