/**
 * Shared engine-lifecycle atom for a single coding attempt.
 *
 * Covers the innermost unit that both the iterative loop ({@link runCodingPhase})
 * and the Hatchet workflow step ({@link runAgentPhase}) need:
 *
 *   register → setup (or resume) → prepareStats → runAgent
 *             └── finally: deregister → teardown (or pause, if caller requested it)
 *
 * Callers own everything outside this scope:
 * - **`run-coding-phase`**: rules watcher, pause/stop routing, `CodingPhaseResult` union
 * - **`run-agent-phase`**: patch extraction, `RunAgentPhaseOutput`
 *
 * The `onFinally` callback lets the caller intercept the finally block before
 * deregister/teardown so it can do engine-specific work (e.g. `pauseInfra`)
 * while the infra is still registered.
 */

import { resolveAgentProfile } from '../../agent-profiles/index.js';
import { createEngine } from '../../engines/index.js';
import { defaultEngineLog } from '../../engines/logs.js';
import type { LiveInfra } from '../../engines/types.js';
import { dummyInspectLlmConfig, resolveAgentLlmConfigForContainer } from '../../llm-config.js';
import { preparePendingRulesFile } from '../../runs/rules.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { buildCoderContainerEnv } from '../agent-env.js';
import { AGENT_WORKSPACE_CONTAINER, AGENT_WORKSPACE_HOST, buildTaskPrompt } from '../agent-task.js';
import { createAgentStdoutPipe, createDefaultAgentLog } from '../logs.js';
import type { IterativeLoopOpts } from '../loop.js';
import type { Sandbox } from '../sandbox.js';
import { getArgusBinaryPath } from '../sidecars/reviewer/argus.js';
import { prepareRoundsStatsFile } from '../stats.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link runEngineAttempt}. */
export interface RunEngineAttemptOpts {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed). Used for the engine label. */
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
  registry: CleanupRegistry | null;
  /**
   * Called immediately after the engine is set up (or resumed) and the first `LiveInfra`
   * snapshot is available. Allows the caller to persist the live resource list before
   * `runAgent` starts, so a crash mid-round still has an accurate record for cleanup.
   */
  onInfraReady?: (infra: LiveInfra) => Promise<void>;
  /**
   * Called inside the `finally` block, before deregister and teardown.
   * Receives the latest infra snapshot and the abort signal.
   * The callback decides whether to `pauseInfra` or let the default teardown proceed;
   * it returns `'pause' | 'teardown'` to tell the atom which path to take.
   */
  onFinally: (opts: {
    infra: LiveInfra | null;
    abortSignal: AbortSignal;
  }) => Promise<'pause' | 'teardown'>;
  /** Abort signal from the caller (Hatchet cancellation or `controlAbort` from the loop). */
  signal: AbortSignal | null;
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
  /** When true, also prepare the pending-rules file (iterative loop path only). */
  preparePendingRules: boolean;
}

/** Result of {@link runEngineAttempt}: final infra snapshot and whether the finally block paused vs tore down. */
export interface RunEngineAttemptResult {
  /** Final infra snapshot after `runAgent` (or null if setup failed). */
  infra: LiveInfra | null;
  /**
   * Whether the finally block ran `pauseInfra` (true) or `teardown` (false).
   * Lets the caller know whether infra is frozen and needs to be persisted.
   */
  didPause: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Shared engine-lifecycle atom: register, setup (or reuse {@link RunEngineAttemptOpts.resumedCodingInfra}),
 * prepare stats and rules files, run the agent, then deregister and either pause or tear down based on
 * what {@link RunEngineAttemptOpts.onFinally} returns. Used by both the iterative loop and the Hatchet step.
 */
export async function runEngineAttempt(
  input: RunEngineAttemptOpts,
): Promise<RunEngineAttemptResult> {
  const {
    sandbox,
    attempt,
    errorFeedback,
    task,
    resumedCodingInfra: initialResumedInfra,
    registry,
    signal,
    opts,
    preparePendingRules,
    onInfraReady,
    onFinally,
  } = input;

  const {
    llm,
    projectDir,
    projectName,
    feature,
    dangerousNoLeash,
    coderImage,
    gateRetries,
    agentEnv,
    agentProfileId,
    reviewerEnabled,
    codingEnvironment,
    saifctlDir,
    agentSecretKeys,
    agentSecretFiles,
    inspectMode,
    enableSubtaskSequence,
    sandboxInteractive,
  } = opts;

  const runId = sandbox.runId;
  const codingLabel = `${runId}-coding-${attempt}`;
  const codingEngine = createEngine(codingEnvironment);
  const codingIsLocal = codingEnvironment.engine === 'local';

  const agentProfile = resolveAgentProfile(agentProfileId);
  const coderLlmConfig = inspectMode
    ? dummyInspectLlmConfig()
    : resolveAgentLlmConfigForContainer('coder', llm);
  const reviewer =
    inspectMode || !reviewerEnabled
      ? null
      : {
          llmConfig: resolveAgentLlmConfigForContainer('reviewer', llm),
          argusBinaryPath: await getArgusBinaryPath(),
        };

  // Track latest live infra: SIGINT cleanup and teardown() need the same snapshot.
  // Each operation like Engine.setup() may mutate the live infra shape.
  let codingInfraRef: LiveInfra | null = null;

  // Register before setup so an early signal still sees infra once setup()
  // has assigned codingInfraRef.
  registry?.registerEngine({
    engine: codingEngine,
    runId,
    label: codingLabel,
    projectDir,
    getInfra: () => codingInfraRef,
  });

  let didPause = false;

  try {
    let afterCodingSetup: LiveInfra;
    if (initialResumedInfra) {
      // Resume path: infra already matches the paused network/compose; setup() would recreate
      // the bridge and break the stopped coder container still attached to the old network.
      afterCodingSetup = initialResumedInfra;
    } else {
      // Provision network (and optional compose); Docker coding also includes
      // the leash container for teardown.
      const { infra } = await codingEngine.setup({
        runId,
        projectName,
        featureName: feature.name,
        projectDir,
        sandboxBasePath: sandbox.sandboxBasePath,
      });
      afterCodingSetup = infra;
    }
    codingInfraRef = afterCodingSetup;
    if (onInfraReady) {
      await onInfraReady(afterCodingSetup);
    }

    // Per-round stats file for inner gate rounds (read later by the outer loop).
    await prepareRoundsStatsFile(sandbox.sandboxBasePath);
    if (preparePendingRules) {
      // Pending-rules file for human-in-the-loop rule updates mid-round.
      await preparePendingRulesFile(sandbox.sandboxBasePath);
    }

    // Stream agent stdout/stderr according to profile (e.g. tee vs line-buffered logs).
    const logStrategy = agentProfile.stdoutStrategy;
    const { onAgentStdout, onAgentStdoutEnd } = createAgentStdoutPipe({
      stdoutStrategy: logStrategy,
      onAgentLog: createDefaultAgentLog({
        linePrefix: 'agent',
        stdoutStrategy: logStrategy,
      }),
    });

    // Full task text: feature spec + rules + prior test feedback for this outer attempt.
    // Workspace mode mirrors the engine kind: `--engine local` runs the
    // agent on the host with `cwd: codePath`, so the directive must use
    // host paths; container engines bind-mount `codePath` at `/workspace`.
    const taskPrompt = await buildTaskPrompt({
      codePath: sandbox.codePath,
      task,
      saifctlDir,
      feature,
      errorFeedback,
      workspace: codingIsLocal ? AGENT_WORKSPACE_HOST : AGENT_WORKSPACE_CONTAINER,
    });

    // Env vars and secrets passed into the coder container (or host process when engine is local).
    const containerEnv = await buildCoderContainerEnv({
      mode: codingIsLocal
        ? { kind: 'host', codePath: sandbox.codePath, saifctlPath: sandbox.saifctlPath }
        : { kind: 'container' },
      llmConfig: coderLlmConfig,
      reviewer: reviewer ? { llmConfig: reviewer.llmConfig } : null,
      agentEnv,
      projectDir,
      agentSecretKeys,
      agentSecretFiles,
      taskPrompt,
      gateRetries,
      runId,
      enableSubtaskSequence,
      sandboxInteractive: !!sandboxInteractive,
    });

    // Run coding agent container (Leash / local) until exit or abort.
    // When inspectMode is set, runAgent starts an idle container instead and calls onReady.
    const { infra: afterAgent } = await codingEngine.runAgent({
      codePath: sandbox.codePath,
      sandboxBasePath: sandbox.sandboxBasePath,
      containerEnv,
      dangerousNoLeash,
      coderImage,
      saifctlPath: sandbox.saifctlPath,
      onAgentStdout,
      onAgentStdoutEnd,
      onLog: defaultEngineLog,
      reviewer: reviewer ? { argusBinaryPath: reviewer.argusBinaryPath } : null,
      signal,
      runId,
      infra: afterCodingSetup,
      inspectMode,
    });
    codingInfraRef = afterAgent;
  } finally {
    // Deregister first so global signal cleanup does not double-tear-down; then pause or
    // teardown using the latest infra snapshot (null ⇒ failed setup ⇒ teardown no-ops / warns).
    registry?.deregisterEngine(codingEngine);

    const action = await onFinally({
      infra: codingInfraRef,
      abortSignal: signal ?? new AbortController().signal,
    });

    if (action === 'pause' && codingInfraRef) {
      await codingEngine.pauseInfra({
        sandboxBasePath: sandbox.sandboxBasePath,
        infra: codingInfraRef,
      });
      didPause = true;
    } else {
      await codingEngine.teardown({ runId, infra: codingInfraRef, projectDir });
    }
  }

  return { infra: codingInfraRef, didPause };
}
