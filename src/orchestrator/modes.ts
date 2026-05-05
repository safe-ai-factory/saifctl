/**
 * Orchestration modes for the Software Factory.
 *
 *  1. fail2pass      — Verify at least one feature test fails on current codebase (sanity check; partial overlap OK)
 *  2. start          — Create a fresh sandbox and run the iterative agent loop
 *  3. fromArtifact   — Start again from a Run (artifact) then runs the same loop as `start`
 *  4. test           — Re-test a Run's patch without running the coding agent loop
 *  5. inspect        — Idle coding container for a Run (changes made in the container are saved)
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { SaifctlConfig } from '../config/schema.js';
import { createEngine } from '../engines/index.js';
import { defaultEngineLog } from '../engines/logs.js';
import { type AssertionSuiteResult, type LiveInfra, type TestsResult } from '../engines/types.js';
import { parseJUnitXmlString } from '../engines/utils/test-parser.js';
import { getHatchetClient } from '../hatchet/client.js';
import { serializeOrchestratorOpts } from '../hatchet/utils/serialize-opts.js';
import {
  type ConvergenceOutput,
  createFeatRunWorkflow,
  type FeatRunSerializedInput,
} from '../hatchet/workflows/feat-run.workflow.js';
import { type LlmOverrides } from '../llm-config.js';
import { consola, ensureStdoutNewline } from '../logger.js';
import { cloneRunRules } from '../runs/rules.js';
import { type RunStorage } from '../runs/storage.js';
import {
  type OuterAttemptSummary,
  RunAlreadyRunningError,
  type RunArtifact,
  RunCannotStopError,
  type RunCommit,
  type RunInspectSession,
  type RunSubtask,
  StaleArtifactError,
} from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import { deserializeArtifactConfig } from '../runs/utils/serialize.js';
import {
  allowsBeginRunStartFromArtifact,
  blocksRunInspect,
  isRunAwaitingPauseCompletion,
  isRunAwaitingStopCompletion,
} from '../runs/utils/statuses.js';
import { runSubtasksFromInputs } from '../runs/utils/subtasks.js';
import { resolveFeature } from '../specs/discover.js';
import { CleanupRegistry } from '../utils/cleanup.js';
import { git } from '../utils/git.js';
import { pathExists, writeUtf8 } from '../utils/io.js';
import {
  buildPatchExcludeRules,
  type IterativeLoopOpts,
  logIterativeLoopSettings,
  type OrchestratorResult,
  prepareTestRunnerOpts,
  runIterativeLoop,
  type RunStorageContext,
} from './loop.js';
import { type OrchestratorCliInput, resolveOrchestratorOpts } from './options.js';
import {
  assertRunCommitsSafeForHost,
  computeRunCommitsDiffHash,
  pushHostApplyBranch,
  resolveHostApplyBranchName,
} from './phases/apply-patch.js';
import {
  createSandbox,
  destroySandbox,
  extractIncrementalRoundPatch,
  SAIFCTL_TEMP_ROOT,
  type Sandbox,
  sandboxFromPausedBasePath,
} from './sandbox.js';
import {
  captureBaseGitState,
  cleanupArtifactRunWorktree,
  createArtifactRunWorktree,
  saveRunOnError,
} from './worktree.js';

/**
 * Full options for the orchestrator entry points (start / fromArtifact / inspect / apply).
 * Extends the inner-loop options with sandbox base dir, resolved scripts, run storage,
 * and the {@link OrchestratorOpts.fromArtifact} block populated when continuing a Run.
 */
export interface OrchestratorOpts extends IterativeLoopOpts {
  /**
   * Base directory where sandbox entries are created.
   */
  sandboxBaseDir: string;
  /**
   * Content of the gate script to run after each OpenHands round. In leash mode the script is
   * written to sandboxBasePath/gate.sh and mounted read-only at /saifctl/gate.sh inside the
   * container. In `--engine local` it runs on the host via bash.
   *
   * It must exit 0 to pass; non-zero causes the inner loop to retry with the output as feedback.
   *
   * Resolved by the CLI: defaults to the gate.sh from the resolved sandbox profile when --gate-script is not set.
   */
  gateScript: string;
  /**
   * Content of the startup script to run once before the agent loop begins.
   * Written to sandboxBasePath/startup.sh and mounted read-only at /saifctl/startup.sh
   * inside the coder container (or on the host with `--engine local`).
   *
   * Use for workspace setup that requires the workspace to be mounted first:
   * pnpm install, pip install -r requirements.txt, cargo fetch, etc.
   *
   * Resolved by the CLI: set via --profile or --startup-script. When neither is
   * provided, the profile's installation script is used.
   */
  startupScript: string;
  /**
   * Content of the agent setup script to write into the sandbox as `agent-install.sh`.
   * Mounted read-only at `/saifctl/agent-install.sh` inside the coder container and executed
   * once by `coder-start.sh` after the startup script, before the agent loop begins.
   *
   * Use to install the coding agent at runtime (e.g. `pipx install aider-chat`).
   *
   * Resolved by the CLI: defaults to the agent profile's agent-install.sh.
   */
  agentInstallScript: string;
  /**
   * Content of the agent script to write into the sandbox as `agent.sh`.
   * Mounted read-only at `/saifctl/agent.sh` inside the coder container and invoked
   * by `coder-start.sh` once per inner round. The script must read the task from
   * `$SAIFCTL_TASK_PATH`.
   *
   * Resolved by the CLI: defaults to the agent profile's agent.sh (OpenHands) when
   * --agent and --agent-script are not set.
   */
  agentScript: string;
  /**
   * Content of the staging script mounted read-only in the staging container at /saifctl/stage.sh.
   * Invoked by staging-start.sh after the installation script and the sidecar have run.
   *
   * Resolved by the CLI: set via --profile or --stage-script. When neither is provided,
   * the profile's stage script is used.
   */
  stageScript: string;
  /**
   * Reporting-only paths for run artifacts (relative to projectDir when under the project,
   * else absolute). Not read by the orchestrator for execution.
   */
  startupScriptFile: string;
  gateScriptFile: string;
  stageScriptFile: string;
  testScriptFile: string;
  agentInstallScriptFile: string;
  agentScriptFile: string;
  /**
   * Run storage for persisting failed runs. Resolved by CLI via readStorageStringFromCli + resolveRunStorage.
   * Default: local (.saifctl/runs/) when --storage is omitted. Set to null for --storage runs=none.
   */
  runStorage: RunStorage | null;
  /**
   * When set, runStartCore operates in from-artifact mode: use sandboxSourceDir for createSandbox,
   * skip base git capture, and pass initialErrorFeedback to the loop.
   * Only used when {@link fromArtifactCore} delegates to runStartCore.
   */
  fromArtifact: {
    sandboxSourceDir: string;
    runContext: RunStorageContext;
    initialErrorFeedback?: string;
    /** Base tree copy (before run commits) — sandbox rsync source for from-artifact/tests/inspect */
    baseSnapshotPath?: string;
    /** Stored {@link RunArtifact#runCommits} replayed after the sandbox "Base state" commit */
    seedRunCommits?: RunCommit[];
    /**
     * When starting from run storage, the run id to reuse for the sandbox and persisted artifact
     * (same as the key passed to `saifctl run start <id>`).
     */
    persistedRunId?: string;
    /**
     * Stored {@link RunArtifact#artifactRevision} when loading from storage (missing treated as 0).
     *
     * Used for optimistic locking on `saveRun`, same pattern as `run inspect`.
     *
     * This is used to prevent race conditions when multiple processes are trying to save the same run.
     * If the revision is not the same as the one in storage, the save will fail.
     */
    artifactRevisionWhenFromArtifact?: number;
    /** Prior {@link RunArtifact#roundSummaries} when continuing from a Run */
    seedRoundSummaries?: OuterAttemptSummary[];
    /**
     * `run resume` when paused sandbox still exists: reuse sandbox dir + Docker bridge from `run pause` (skips createSandbox).
     * Leash/coder containers are removed on pause and recreated when the loop runs again.
     *
     * NOTE: Even if a run was paused, the sandbox may be lost if it's stored in /tmp/
     * and the system reboots.
     * */
    pausedSandbox?: Sandbox;
    /**
     * Coding {@link LiveInfra} from the paused artifact (network, compose, containers).
     *
     * Set to a non-null value by `run resume` to skip {@link Engine.setup} on the first iterative loop round
     * so the existing bridge/network is preserved. Always `null` for non-resume paths (`run start`, `fromArtifact`).
     */
    resumedCodingInfra: LiveInfra | null;
    /**
     * When true, {@link createSandbox} reuses an existing `{project}-{feature}-{runId}` directory
     * (refresh patch + scripts only). Set when `run resume` falls back to from-artifact while the
     * paused sandbox path is still on disk.
     */
    reuseExistingSandbox?: boolean;
    /** Subtasks copied from the stored {@link RunArtifact} when continuing a run. */
    seedSubtasks?: RunSubtask[];
    /** Cursor into {@link seedSubtasks} from the stored artifact. */
    currentSubtaskIndex?: number;
    /** From {@link RunArtifact#sandboxHostAppliedCommitCount} (host extract cursor for resume). */
    sandboxHostAppliedCommitCount: number;
  } | null;
  /**
   * When true, append the semantic reviewer step to the gate script.
   * Disabled via --no-reviewer.
   */
  reviewerEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Cleanup registry decorator
// ---------------------------------------------------------------------------

function withCleanupRegistry<T, R>(
  fn: (opts: T, registry: CleanupRegistry) => Promise<R>,
): (opts: T) => Promise<R> {
  return async (opts: T): Promise<R> => {
    const registry = new CleanupRegistry();
    let isCleaningUp = false;

    // This function is called when the user hits Ctrl+C or the process is terminated.
    // It cleans up the containers and networks created during the run.
    // It also saves the run state to runStorage so the user can start again from the artifact later.
    const onSignal = (sig: string) => {
      if (isCleaningUp) return;
      isCleaningUp = true;

      consola.log(`\n[orchestrator] ${sig} received — cleaning up...`);

      // The terminal sends SIGINT to the whole process group.
      // pnpm (the parent) catches SIGINT and immediately sends SIGTERM to us.
      // We must catch BOTH and explicitly ignore them so Node doesn't die
      // before our async Docker API calls finish.
      const ignore = () => {};
      process.on('SIGINT', ignore);
      process.on('SIGTERM', ignore);

      void (async () => {
        try {
          await registry.cleanup();
        } catch (err) {
          consola.warn('[orchestrator] Cleanup error:', err);
        } finally {
          process.exit(sig === 'SIGINT' ? 130 : 143);
        }
      })();
    };

    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    try {
      return await fn(opts, registry);
    } finally {
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
    }
  };
}

// ---------------------------------------------------------------------------
// Public entry points (wrapped with cleanup registry)
// ---------------------------------------------------------------------------

/**
 * Mode 1 — verifies feature tests fail on the current host codebase before any agent run.
 * Spins up staging containers with no patch and asserts at least one feature test fails.
 */
export const runFail2Pass = withCleanupRegistry(runFail2PassCore);
/**
 * Mode 2 — fresh sandbox plus the full iterative agent loop. Used by `feat run` and
 * `run start <id>` (when `OrchestratorOpts.fromArtifact` is set, this also drives the
 * from-artifact and `run resume` paths).
 */
export const runStart = withCleanupRegistry(runStartCore);
/**
 * Mode 3 — start again from a stored Run artifact. Materialises a worktree from
 * `baseCommitSha` + `runCommits`, then delegates to {@link runStart} with
 * `fromArtifact` populated. Also used by `run test` (with `testOnly`).
 */
export const fromArtifact = withCleanupRegistry(fromArtifactCore);
/**
 * Resume a paused Run: when the on-disk sandbox + Docker bridge survive, reuses them
 * directly; otherwise falls back to {@link fromArtifact} after clearing pause metadata.
 */
export const runResume = withCleanupRegistry(runResumeCore);
/**
 * Mode 4 — re-run staging tests from a Run artifact without re-running the coding agent.
 * Same pipeline as {@link fromArtifact} with `testOnly: true`.
 */
export const runTestsFromRun = withCleanupRegistry(runTestsFromRunCore);
/**
 * Mode 3c — apply a stored Run's commits to a host worktree branch (and optional push/PR).
 * No sandbox, no tests; pure git replay using {@link applyPatchToHost}-style worktree flow.
 */
export const runApply = withCleanupRegistry(runApplyCore);

// ---------------------------------------------------------------------------
// Mode 1: fail2pass
// ---------------------------------------------------------------------------

/**
 * Spins up containers with no patch applied and runs the full test suite
 * (including hidden tests). Asserts that tests FAIL (exit code 1).
 *
 * Purpose: sanity-check that the tests are actually testing something new
 * and haven't been accidentally satisfied by existing code.
 */
type Fail2PassOpts = Pick<
  OrchestratorOpts,
  | 'sandboxProfileId'
  | 'feature'
  | 'projectDir'
  | 'saifctlDir'
  | 'projectName'
  | 'sandboxBaseDir'
  | 'testImage'
  | 'stagingEnvironment'
  | 'startupScript'
  | 'gateScript'
  | 'agentInstallScript'
  | 'agentScript'
  | 'stageScript'
  | 'testScript'
  | 'testProfile'
  | 'cedarScript'
  | 'verbose'
  | 'includeDirty'
>;

async function runFail2PassCore(
  opts: Fail2PassOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    saifctlDir,
    projectName,
    sandboxBaseDir,
    testImage,
    stagingEnvironment,
    startupScript,
    gateScript,
    agentInstallScript,
    agentScript,
    stageScript,
    testScript,
    cedarScript,
  } = opts;

  consola.log(`\n[orchestrator] MODE: fail2pass — ${feature.name}`);

  const sandbox = await createSandbox({
    feature,
    projectDir,
    saifctlDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentInstallScript,
    agentScript,
    stageScript,
    cedarScript,
    verbose: opts.verbose,
    includeDirty: opts.includeDirty,
  });
  registry.setEmergencySandboxPath(sandbox.sandboxBasePath);
  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
    testProfile: opts.testProfile,
  });

  const stagingEngine = createEngine(stagingEnvironment);

  // Track latest live infra for this engine: SIGINT cleanup and teardown() need
  // the same snapshot. Each operation like Engine.setup() may mutate the live infra shape.
  let stagingInfra: LiveInfra | null = null;

  // Register before setup so an early signal still sees infra once setup()
  // has assigned stagingInfra.
  registry.registerEngine({
    engine: stagingEngine,
    runId: sandbox.runId,
    label: sandbox.runId,
    projectDir,
    getInfra: () => stagingInfra,
  });

  try {
    // Provision staging engine network (and optional compose) for fail2pass verification.
    const { infra: afterSetup } = await stagingEngine.setup({
      runId: sandbox.runId,
      projectName,
      featureName: feature.name,
      projectDir,
    });
    stagingInfra = afterSetup;

    // Bring up the staging container (sidecar / app) against the sandbox workspace.
    const { stagingHandle, infra: afterStaging } = await stagingEngine.startStaging({
      runId: sandbox.runId,
      sandboxProfileId,
      codePath: sandbox.codePath,
      projectDir,
      stagingEnvironment,
      feature,
      projectName,
      saifctlPath: sandbox.saifctlPath,
      onLog: defaultEngineLog,
      infra: afterSetup,
    });
    stagingInfra = afterStaging;

    // Execute the feature test suite inside the staging environment.
    const { tests: result, infra: afterTests } = await stagingEngine.runTests({
      ...testRunnerOpts,
      stagingHandle,
      testImage,
      runId: sandbox.runId,
      feature,
      projectName,
      onLog: defaultEngineLog,
      infra: afterStaging,
    });
    stagingInfra = afterTests;

    // Process results
    if (result.runnerError) {
      throw new Error(
        `Test runner error (not a test failure): ${result.runnerError}\n` +
          `Check that runner.spec.ts and tests.json are present and valid.\n` +
          `Stderr:\n${result.stderr}`,
      );
    }

    if (hasFeatureSuccessfullyFailed(result)) {
      consola.log(
        '\n[orchestrator] ✓ FAIL2PASS CONFIRMED — feature tests correctly fail on current codebase',
      );
      return {
        status: 'success',
        attempts: 1,
        message: 'Tests correctly fail on current codebase. Ready to start the iterative loop.',
      };
    } else {
      consola.error(
        '\n[orchestrator] ✗ FAIL2PASS REJECTED — no feature tests failed on current codebase',
      );
      consola.error('Either the feature already exists or the tests are invalid.');
      return {
        status: 'failed',
        attempts: 1,
        message:
          'No feature tests failed on current codebase — feature may already be implemented or tests are invalid.',
      };
    }
  } finally {
    // Deregister first; then teardown when we have an infra snapshot
    // (null ⇒ failed setup ⇒ teardown no-ops / warns).
    registry.deregisterEngine(stagingEngine);
    await stagingEngine.teardown({
      runId: sandbox.runId,
      infra: stagingInfra,
      projectDir,
    });
    await destroySandbox(sandbox.sandboxBasePath);
    registry.clearEmergencySandboxPath();
  }
}

// ---------------------------------------------------------------------------
// Mode 2: start (fresh sandbox -> running)
// ---------------------------------------------------------------------------

/** If `run stop` won the race during `starting` setup, mark `failed` and throw. */
async function abortRunStartIfStopRequested(runStorage: RunStorage, runId: string): Promise<void> {
  const cur = await runStorage.getRun(runId);
  if (!cur) return;
  if (cur.status !== 'stopping' && cur.controlSignal?.action !== 'stop') return;
  const rev = cur.artifactRevision ?? 0;
  const t = new Date().toISOString();
  try {
    await runStorage.saveRun(
      runId,
      {
        ...cur,
        status: 'failed',
        controlSignal: null,
        updatedAt: t,
        lastFeedback: cur.lastFeedback ?? 'Run was stopped before start completed.',
      },
      { ifRevisionEquals: rev },
    );
  } catch {
    // stale revision — still abort visible work
  }
  throw new Error(`Run "${runId}" was stopped before start completed.`);
}

/**
 * Hatchet-experimental gate (per release-readiness/D-04).
 *
 * The remote-server Hatchet path is not generally available in v0.1.0. When
 * `HATCHET_CLIENT_TOKEN` is set (`isLocal === false`), users must additionally
 * opt in via `SAIFCTL_EXPERIMENTAL_HATCHET=1`. Local mode (`LocalHatchetRunner`)
 * is unaffected; this is purely a guard on the remote-dispatch branch.
 *
 * Throws a single, clear error pointing the user at either fallback. Exported
 * so the gate can be unit-tested independently of `runStartCore`.
 */
export function assertHatchetReady(isLocal: boolean): void {
  if (isLocal) return;
  if (process.env.SAIFCTL_EXPERIMENTAL_HATCHET === '1') return;
  throw new Error(
    'Hatchet integration is not yet available in v0.1.0. ' +
      'Use local mode (unset HATCHET_CLIENT_TOKEN) or enable the experimental ' +
      'flag SAIFCTL_EXPERIMENTAL_HATCHET=1 to opt in to the in-progress path.',
  );
}

/**
 * Creates a fresh sandbox and runs the full Ralph Wiggum iterative loop:
 *   1. Run OpenHands to implement the feature
 *   2. Extract the patch
 *   3. Run Mutual Verification (Container A + B)
 *   4. If pass → apply patch to host, commit, open PR
 *   5. If fail → feed stderr back to OpenHands, repeat
 */
async function runStartCore(
  opts: OrchestratorOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    feature,
    projectDir,
    saifctlDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentInstallScript,
    agentScript,
    stageScript,
    runStorage,
    testOnly,
  } = opts;

  if (opts.includeDirty) {
    consola.warn(
      '[orchestrator] --include-dirty: sandbox includes uncommitted/untracked files. ' +
        'Prefer `saifctl run export <runId>` over `run apply` so untracked files are not baked into the branch.',
    );
  }

  const sandboxSourceDir = getSandboxSourceDir(opts);

  // ─── Run context (for save-on-Ctrl+C / save-on-failure) ────────────────────
  // Capture all the relevant state so that we can start again from the artifact later.
  // Thus, if `runIterativeLoop` throws or user aborts with CTRL+C, the loop
  // will persist an artifact with all the relevant state so the user can
  // start again with `saifctl run start <runId>`.
  let runContext: RunStorageContext;
  if (opts.fromArtifact) {
    // Resume: use the context from the stored artifact
    runContext = opts.fromArtifact.runContext;
  } else {
    // Start: capture the current git state so we can reconstruct it when resuming
    runContext = await captureBaseGitState(projectDir);
  }

  const { subtasks: runArtifactSubtasks, currentSubtaskIndex: runArtifactSubtaskIndex } = opts
    .fromArtifact?.seedSubtasks?.length
    ? {
        subtasks: opts.fromArtifact.seedSubtasks.map((s) => ({ ...s })),
        currentSubtaskIndex: opts.fromArtifact.currentSubtaskIndex ?? 0,
      }
    : {
        subtasks: runSubtasksFromInputs(opts.subtasks),
        currentSubtaskIndex: opts.currentSubtaskIndex ?? 0,
      };

  // ─── Hatchet path ─────────────────────────────────────────────────────────
  // When HATCHET_CLIENT_TOKEN is set, dispatch via Hatchet (distributed mode).
  // IMPORTANT: Do not call createSandbox here — the worker's provision-sandbox task creates
  // the only sandbox. A local createSandbox before this branch used to leak sandboxes on
  // every Hatchet dispatch.
  //
  // OrchestratorOpts is not JSON-serializable (contains gitProvider/testProfile class
  // instances, patchExclude RegExp), so we serialize it at dispatch and reconstruct it
  // on the worker via deserializeOrchestratorOpts — no ambient in-process state needed.
  const { hatchet, isLocal } = getHatchetClient();
  if (!isLocal) {
    assertHatchetReady(isLocal);
    consola.log('[orchestrator] Hatchet token detected — dispatching via Hatchet workflow.');
    consola.warn(
      '[orchestrator] SAIFCTL_EXPERIMENTAL_HATCHET=1 — Hatchet support is experimental ' +
        'and incomplete (run resume on a paused sandbox is not supported yet).',
    );

    // TODO - HATCHET + RUN RESUME PATH DOES NOT WORK YET
    // TODO - HATCHET + RUN RESUME PATH DOES NOT WORK YET
    // TODO - HATCHET + RUN RESUME PATH DOES NOT WORK YET
    //        The problem:
    //        A paused sandbox is local state on one specific machine.
    //        The sandbox directory and Docker network live on the worker's filesystem.
    //        When run resume tries to reuse them,
    //        it must run on the same worker. Hatchet's default scheduling is
    //        round-robin / load-balanced — no guarantee of worker affinity.
    if (opts.fromArtifact?.pausedSandbox) {
      throw new Error("Hatchet + 'run resume' path does not work yet.");
    }

    const serializedOpts = serializeOrchestratorOpts(opts);
    const featRunWorkflow = createFeatRunWorkflow();

    // Start an inline worker for this request. In production a persistent
    // worker process (`saifctl worker start`) is preferred.
    const worker = await hatchet.worker('saifctl-worker', { workflows: [featRunWorkflow] });
    await worker.start();

    try {
      const input: FeatRunSerializedInput = {
        serializedOpts,
        runContext: {
          baseCommitSha: runContext.baseCommitSha,
          basePatchDiff: runContext.basePatchDiff,
          lastErrorFeedback: runContext.lastErrorFeedback,
          rules: runContext.rules,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hatchetRaw = await hatchet.run<FeatRunSerializedInput, { [x: string]: any }>(
        featRunWorkflow.name,
        input,
      );
      return orchestratorResultFromHatchetWorkflowOutput(hatchetRaw);
    } finally {
      // Note: There is finally, but not `catch` branch, so the error still throws
      // after the cleanup.
      await worker.stop();
    }
  }

  ///////////////////////
  // Non-hatchet branch
  ///////////////////////

  /** Fresh `feat run` with storage: reserve id + `starting` before sandbox creation. */
  let persistedRunIdForStorage: string | undefined;
  if (runStorage && !opts.fromArtifact && !testOnly) {
    const rid = Math.random().toString(36).substring(2, 9);
    try {
      const { runStorage: _rs, fromArtifact: _fa, ...loopOpts } = opts;
      const startingArtifact = buildRunArtifact({
        runId: rid,
        baseCommitSha: runContext.baseCommitSha,
        basePatchDiff: runContext.basePatchDiff,
        runCommits: [],
        sandboxHostAppliedCommitCount: 0,
        subtasks: runArtifactSubtasks.map((s) => ({ ...s })),
        currentSubtaskIndex: runArtifactSubtaskIndex,
        rules: runContext.rules,
        status: 'starting',
        opts: loopOpts,
        pausedSandboxBasePath: null,
        controlSignal: null,
        inspectSession: null,
        liveInfra: null,
        lastFeedback: runContext.lastErrorFeedback ?? undefined,
      });
      await runStorage.setStatusStartingNewRun(rid, startingArtifact);
      const snap = await runStorage.getRun(rid);
      if (snap?.status === 'stopping' || snap?.controlSignal?.action === 'stop') {
        await abortRunStartIfStopRequested(runStorage, rid);
      }
      persistedRunIdForStorage = rid;
    } catch (err) {
      if (err instanceof RunAlreadyRunningError) throw err;
      if (err instanceof Error && err.message.includes('was stopped before start completed')) {
        throw err;
      }
      consola.warn('[orchestrator] Failed to persist new run as starting:', err);
    }
  }

  // When resuming, we reuse the existing sandbox
  const pausedSandbox = opts.fromArtifact?.pausedSandbox;
  const sandbox: Sandbox =
    pausedSandbox ??
    (await createSandbox({
      feature,
      projectDir: sandboxSourceDir,
      codeSourceDir: opts.fromArtifact?.baseSnapshotPath ?? sandboxSourceDir,
      saifctlDir,
      projectName,
      sandboxBaseDir,
      gateScript,
      startupScript,
      agentInstallScript,
      agentScript,
      stageScript,
      cedarScript: opts.cedarScript,
      verbose: opts.verbose,
      runCommits: opts.fromArtifact?.seedRunCommits ?? [],
      runId: opts.fromArtifact?.persistedRunId ?? persistedRunIdForStorage,
      includeDirty: opts.includeDirty,
      reuseExistingSandbox: !!opts.fromArtifact?.reuseExistingSandbox,
    }));

  const modeLabel = testOnly ? 'test' : opts.fromArtifact ? 'fromArtifact' : 'start';
  consola.log(`\n[orchestrator] MODE: ${modeLabel} — ${feature.name} (run ${sandbox.runId})`);
  logIterativeLoopSettings(opts, { runId: sandbox.runId });

  registry.setEmergencySandboxPath(sandbox.sandboxBasePath);

  // ─── Set status to "running" ─────
  if (runStorage) {
    try {
      const { runStorage: _rs, fromArtifact: _fa, ...loopOpts } = opts;
      const runningArtifact = buildRunArtifact({
        runId: sandbox.runId,
        baseCommitSha: runContext.baseCommitSha,
        basePatchDiff: runContext.basePatchDiff,
        runCommits: opts.fromArtifact?.seedRunCommits ?? [],
        sandboxHostAppliedCommitCount: opts.fromArtifact
          ? opts.fromArtifact.sandboxHostAppliedCommitCount
          : 0,
        subtasks: runArtifactSubtasks.map((s) => ({ ...s })),
        currentSubtaskIndex: runArtifactSubtaskIndex,
        rules: runContext.rules,
        status: 'running',
        opts: loopOpts,
        pausedSandboxBasePath: null,
        controlSignal: null,
        inspectSession: null,
        // On resume, keep the coding infra in the artifact so a SIGINT before the first round
        // doesn't lose the live Docker resources. Non-resume paths start with null and let the
        // iterative loop fill it in once infra is provisioned.
        liveInfra: opts.fromArtifact?.resumedCodingInfra
          ? { coding: opts.fromArtifact.resumedCodingInfra, staging: null }
          : null,
      });
      runContext.expectedArtifactRevision = await runStorage.setStatusRunning(
        sandbox.runId,
        runningArtifact,
      );
    } catch (err) {
      if (err instanceof RunAlreadyRunningError) throw err;
      consola.warn('[orchestrator] Failed to set run status to "running":', err);
    }
  }

  // ─── Save run artifact on interrupt (Ctrl+C) ───────────────────────────────
  // Normal exit (success or failure) is handled inside runIterativeLoop cleanup.
  if (runStorage) {
    registry.setBeforeCleanup(async () => {
      await saveRunOnError({
        sandbox,
        runContext,
        opts,
        runStorage,
        saveRunOptions:
          runContext.expectedArtifactRevision !== undefined
            ? { ifRevisionEquals: runContext.expectedArtifactRevision }
            : undefined,
      });
    });
  }

  // ─── Existing in-process path ──────────────────────────────────────────────
  return runIterativeLoop(sandbox, {
    ...opts,
    saifctlDir,
    runStorage,
    runContext,
    initialErrorFeedback: opts.fromArtifact?.initialErrorFeedback ?? null,
    seedRunCommits: opts.fromArtifact?.seedRunCommits ?? [],
    seedRoundSummaries: opts.fromArtifact?.seedRoundSummaries,
    registry,
    loopRunSubtasks: opts.fromArtifact?.seedSubtasks?.length
      ? opts.fromArtifact.seedSubtasks.map((s) => ({ ...s }))
      : runArtifactSubtasks.map((s) => ({ ...s })),
    loopCurrentSubtaskIndex: opts.fromArtifact?.currentSubtaskIndex ?? runArtifactSubtaskIndex,
  });
}

/**
 * Converts the raw output of the `feat-run` Hatchet workflow.
 *
 * Two possible output shapes:
 *
 * 1. Failure-hook shape (fast path)
 * When the workflow errors out, Hatchet invokes the `onFailure` step from `feat-run.workflow.ts`.
 * This step writes a normalized {@link OrchestratorResult}.
 *
 * 2. Normal-completion shape (step-keyed)
 * When the workflow runs to completion without error, Hatchet merges step outputs under their step
 * names. The relevant keys are:
 * - `provision-sandbox` — sandbox-provisioning step, contains `runId`.
 * - `convergence-loop`  — iterative agent loop, typed as {@link ConvergenceOutput}.
 */
function orchestratorResultFromHatchetWorkflowOutput(raw: unknown): OrchestratorResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Hatchet feat-run workflow returned no result.');
  }
  const o = raw as Record<string, unknown>;
  const st = o.status;

  // Fast path: the onFailure hook already produced a normalized OrchestratorResult.
  if (st === 'success' || st === 'failed' || st === 'paused' || st === 'stopped') {
    return o as unknown as OrchestratorResult;
  }

  // Normal completion path: map from step-keyed Hatchet output.
  const conv = o['convergence-loop'];
  if (conv && typeof conv === 'object') {
    const c = conv as ConvergenceOutput;
    const provision = o['provision-sandbox'] as { runId?: string } | undefined;
    const runId = provision?.runId;
    if (c.success) {
      return {
        status: 'success',
        attempts: c.attempt,
        runId,
        patchPath: c.patchPath ?? undefined,
        message: `Feature implemented successfully in ${c.attempt} attempt(s).`,
      };
    }
    return {
      status: 'failed',
      attempts: c.attempt,
      runId,
      message: c.lastErrorFeedback ?? `Failed after ${c.attempt} run(s).`,
    };
  }
  throw new Error(`Unexpected Hatchet feat-run workflow output shape: ${JSON.stringify(o)}`);
}

// ---------------------------------------------------------------------------
// Mode 3: fromArtifact (existing (stopped/paused) -> running)
// ---------------------------------------------------------------------------

/** Options shared by {@link fromArtifact}, {@link runResume}, {@link runTestsFromRun}, {@link runApply}, and {@link runInspect}. */
export interface FromArtifactOpts {
  runId: string;
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  runStorage: RunStorage;
  cli: OrchestratorCliInput;
  cliModelDelta: LlmOverrides | undefined;
  engineCli: string | undefined;
  /**
   * When true and the on-disk sandbox for this run still exists, {@link createSandbox} reuses it
   * (`run resume` after Docker infra is gone but `/tmp/.../sandboxes/...` remains).
   */
  reuseSandboxIfPresent?: boolean;
}

/**
 * Starts again from a Run. Fetches the artifact, prepares workspace from
 * baseCommitSha + diffs, creates a fresh sandbox, and runs the loop.
 * Delegates to runStartCore with {@link OrchestratorOpts#fromArtifact} set.
 *
 * Used by both `run start` and `run test`.
 */
async function fromArtifactCore(
  opts: FromArtifactOpts & { testOnly?: boolean },
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    runId,
    projectDir,
    runStorage,
    cli,
    cliModelDelta,
    config,
    saifctlDir,
    testOnly,
    engineCli,
  } = opts;

  let artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }
  if (artifact.status === 'paused' && artifact.pausedSandboxBasePath?.trim()) {
    throw new Error(`Run "${runId}" is paused. Use: saifctl run resume ${runId}`);
  }
  if (!allowsBeginRunStartFromArtifact(artifact.status, artifact.pausedSandboxBasePath)) {
    throw new Error(
      `Run "${runId}" cannot be started (status: "${artifact.status}"). ` +
        `Use run start on failed or completed runs, or run resume when paused with a sandbox.`,
    );
  }

  await runStorage.beginRunStartFromArtifact(runId);
  await abortRunStartIfStopRequested(runStorage, runId);
  artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }

  const mode = testOnly ? 'test' : 'fromArtifact';
  consola.log(`\n[orchestrator] MODE: ${mode} — ${artifact.config.featureName} (run ${runId})`);

  // Fresh worktree under /tmp/worktrees/ (from artifact), then fresh sandbox in runStartCore
  // to reconstruct the state of the workspace at the time of the run (+ agent's changes)
  const { worktreePath, branchName, baseSnapshotPath } = await createArtifactRunWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runCommits: artifact.runCommits,
  });

  await abortRunStartIfStopRequested(runStorage, runId);
  artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }

  const deserialized = deserializeArtifactConfig(artifact.config);
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
    artifact,
    engineCli,
  });

  mergedOpts.fromArtifact = {
    sandboxSourceDir: worktreePath,
    baseSnapshotPath,
    seedRunCommits: artifact.runCommits,
    seedRoundSummaries: artifact.roundSummaries,
    runContext: {
      baseCommitSha: artifact.baseCommitSha,
      basePatchDiff: artifact.basePatchDiff,
      rules: cloneRunRules(artifact.rules),
    },
    initialErrorFeedback: artifact.lastFeedback,
    persistedRunId: runId,
    artifactRevisionWhenFromArtifact: artifact.artifactRevision ?? 0,
    resumedCodingInfra: null,
    reuseExistingSandbox: !!opts.reuseSandboxIfPresent,
    seedSubtasks: artifact.subtasks.map((s) => ({ ...s })),
    currentSubtaskIndex: artifact.currentSubtaskIndex,
    sandboxHostAppliedCommitCount: artifact.sandboxHostAppliedCommitCount,
  };

  try {
    // Finally, run the same flow as when we run `saifctl feat start <featureName>`
    // (runStartCore logs MODE + settings after createSandbox, including Run ID.)
    return await runStartCore(mergedOpts, registry);
  } finally {
    await cleanupArtifactRunWorktree({ worktreePath, projectDir, branchName }, () => {
      // Best-effort cleanup
    });
  }
}

/**
 * Resume a paused run when the sandbox directory and Docker bridge still exist; otherwise clears
 * pause metadata and continues via {@link fromArtifactCore} (same as `run start`). Leash/coder
 * containers are recreated by the agent loop (removed on pause).
 */
async function runResumeCore(
  opts: FromArtifactOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const { runId, projectDir, runStorage, cli, cliModelDelta, config, saifctlDir, engineCli } = opts;

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }
  if (artifact.status !== 'paused') {
    throw new Error(
      `Run "${runId}" is not paused (status: "${artifact.status}"). Use: saifctl run start ${runId}`,
    );
  }
  const pausedPath = artifact.pausedSandboxBasePath?.trim();
  if (!pausedPath) {
    throw new Error(
      `Run "${runId}" is missing pausedSandboxBasePath. Use: saifctl run start ${runId}`,
    );
  }

  consola.log(`\n[orchestrator] MODE: runResume — ${artifact.config.featureName} (run ${runId})`);

  const deserialized = deserializeArtifactConfig(artifact.config);
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
    artifact,
    engineCli,
  });

  const pathOk = await pathExists(pausedPath);

  const codingEngine = createEngine(mergedOpts.codingEnvironment);
  const engineType = mergedOpts.codingEnvironment.engine;
  const resumedCodingInfra = artifact.liveInfra?.coding;
  const resumedInfraMissing = !resumedCodingInfra;

  let infraOk = false;
  if (!resumedInfraMissing) {
    // Guard: Engine mismatch → error.
    if (resumedCodingInfra.engine !== engineType) {
      throw new Error(
        `Run "${runId}" cannot be resumed: stored coding infra uses engine "${resumedCodingInfra.engine}" ` +
          `but the current config uses "${engineType}". ` +
          `Align environments.coding (or CLI) with the paused run, or start fresh with: saifctl run start ${runId}`,
      );
    }

    // Check whether the infra stored on the Run still exists
    infraOk = await codingEngine.verifyInfraToResume({
      projectName: mergedOpts.projectName,
      featureName: feature.name,
      runId: artifact.runId,
      sandboxBasePath: pausedPath,
      projectDir,
      infra: resumedCodingInfra,
    });
  }

  // Guard: missing sandbox, missing engine infra, or missing stored coding liveInfra → rebuild.
  if (!pathOk || !infraOk || resumedInfraMissing) {
    let reason = '';
    if (!pathOk) {
      reason = 'Paused run is missing sandbox directory';
    } else if (!infraOk) {
      reason = `Paused run defined infra (network / container) to resume but the infra is no longer present`;
    } else if (resumedInfraMissing) {
      reason = `Paused run has no defined infra (network / container) to resume`;
    }
    consola.warn(`[orchestrator] ${reason} — continuing like run start (rebuild from artifact).`);

    const rev = artifact.artifactRevision ?? 0;
    await runStorage.saveRun(
      runId,
      {
        ...artifact,
        pausedSandboxBasePath: null,
        controlSignal: null,
        updatedAt: new Date().toISOString(),
      },
      { ifRevisionEquals: rev },
    );
    return fromArtifactCore({ ...opts, reuseSandboxIfPresent: pathOk }, registry);
  }

  const revResume = artifact.artifactRevision ?? 0;
  const tResume = new Date().toISOString();
  await runStorage.saveRun(
    runId,
    {
      ...artifact,
      status: 'resuming',
      controlSignal: null,
      updatedAt: tResume,
    },
    { ifRevisionEquals: revResume },
  );
  const artifactResuming = await runStorage.getRun(runId);
  const resumeArtifactRevision = artifactResuming?.artifactRevision ?? revResume + 1;

  const resumeSandbox = sandboxFromPausedBasePath({
    runId: artifact.runId,
    sandboxBasePath: pausedPath,
  });

  // Finally, everything present, we can resume the infra (e.g. `docker compose up`)
  await codingEngine.resumeInfra({
    sandboxBasePath: resumeSandbox.sandboxBasePath,
    runId: artifact.runId,
    projectName: mergedOpts.projectName,
    featureName: feature.name,
    projectDir,
  });

  mergedOpts.fromArtifact = {
    sandboxSourceDir: resumeSandbox.codePath,
    runContext: {
      baseCommitSha: artifact.baseCommitSha,
      basePatchDiff: artifact.basePatchDiff,
      rules: cloneRunRules(artifact.rules),
    },
    initialErrorFeedback: artifact.lastFeedback,
    seedRunCommits: artifact.runCommits,
    persistedRunId: runId,
    artifactRevisionWhenFromArtifact: resumeArtifactRevision,
    seedRoundSummaries: artifact.roundSummaries,
    pausedSandbox: resumeSandbox,
    resumedCodingInfra,
    seedSubtasks: artifact.subtasks.map((s) => ({ ...s })),
    currentSubtaskIndex: artifact.currentSubtaskIndex,
    sandboxHostAppliedCommitCount: artifact.sandboxHostAppliedCommitCount,
  };

  return runStartCore(mergedOpts, registry);
}

// ---------------------------------------------------------------------------
// Pause: running → paused
// ---------------------------------------------------------------------------

/** Poll interval while waiting for pause/stop handshakes to finish. */
const RUN_WAIT_POLL_MS = 1000;

/** Default max wait when `run pause` / `run stop` await orchestrator teardown (seconds → ms at CLI). */
const DEFAULT_RUN_WAIT_TIMEOUT_MS = 60_000;

async function waitForPauseSettled(opts: {
  runStorage: RunStorage;
  runId: string;
  waitTimeoutMs: number;
}): Promise<boolean> {
  const { runStorage, runId, waitTimeoutMs } = opts;
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RUN_WAIT_POLL_MS));
    const cur = await runStorage.getRun(runId);
    if (!cur) return true;
    if (!isRunAwaitingPauseCompletion(cur.status)) return true;
  }
  return false;
}

async function waitForAsyncStopSettled(opts: {
  runStorage: RunStorage;
  runId: string;
  waitTimeoutMs: number;
}): Promise<boolean> {
  const { runStorage, runId, waitTimeoutMs } = opts;
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RUN_WAIT_POLL_MS));
    const cur = await runStorage.getRun(runId);
    if (!cur) return true;
    if (!isRunAwaitingStopCompletion(cur.status)) return true;
  }
  return false;
}

/**
 * Request pause and wait until the run leaves `"running"` (or `--timeout`).
 */
export async function runPause(opts: {
  runId: string;
  runStorage: RunStorage;
  waitTimeoutMs?: number;
}): Promise<void> {
  const { runId, runStorage } = opts;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_RUN_WAIT_TIMEOUT_MS;

  // Request run to be paused by changing state in storage
  // The running Run polls the storage and that's how it finds about our
  // pause request.
  await runStorage.requestPause(runId);
  consola.log(`Pause requested for run ${runId} — waiting for orchestrator to finish pausing...`);

  const ok = await waitForPauseSettled({ runStorage, runId, waitTimeoutMs });
  if (!ok) {
    consola.warn(
      `[orchestrator] Timed out after ${waitTimeoutMs / 1000}s waiting for run "${runId}" to finish pausing (still running or pausing). Check with: saifctl run ls`,
    );
    return;
  }

  // By now the run paused or we timed out
  const run = await runStorage.getRun(runId);
  consola.log(`Run ${runId} finished pausing (status: ${run?.status ?? 'unknown'}).`);
}

/**
 * Stop a run: asks a live run to shut down and waits, or tears down a paused sandbox immediately.
 * With `force: true`, stops waiting and cleans up what is known from the saved run (e.g. stuck on Stopping).
 */
export async function runStop(opts: {
  runId: string;
  projectDir: string;
  runStorage: RunStorage;
  waitTimeoutMs?: number;
  force?: boolean;
}): Promise<void> {
  const { runId, projectDir, runStorage, force } = opts;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_RUN_WAIT_TIMEOUT_MS;

  // Get run artifact from storage
  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }

  const pausedPath = artifact.pausedSandboxBasePath?.trim();

  if (artifact.status === 'paused' && pausedPath) {
    const codingEngine = createEngine(artifact.config.codingEnvironment);
    const storedCoding = artifact.liveInfra?.coding ?? null;
    await codingEngine.teardown({ runId: artifact.runId, infra: storedCoding, projectDir });

    // Destroy sandbox
    await destroySandbox(pausedPath);
    const rev = artifact.artifactRevision ?? 0;
    const t = new Date().toISOString();

    // Mark as failed, clearing live infra (teardown already completed above)
    await runStorage.saveRun(
      runId,
      {
        ...artifact,
        status: 'failed',
        controlSignal: null,
        pausedSandboxBasePath: null,
        liveInfra: null,
        updatedAt: t,
      },
      { ifRevisionEquals: rev },
    );
    consola.log(`Run "${runId}" stopped (failed); sandbox removed.`);
    return;
  }

  if (force) {
    consola.log(`Stopping run "${runId}" with --force…`);
    await bestEffortTeardownRunResources(artifact, projectDir);
    await persistForceStoppedRun(runStorage, runId);
    return;
  }

  if (artifact.status === 'paused' && !pausedPath) {
    throw new Error(
      `Run "${runId}" is paused but has no saved workspace path to remove. Try: saifctl run stop --force ${runId}`,
    );
  }

  const needsAsyncStop =
    artifact.status === 'running' ||
    artifact.status === 'starting' ||
    artifact.status === 'resuming' ||
    artifact.status === 'pausing' ||
    artifact.status === 'stopping';
  if (needsAsyncStop) {
    await runStorage.requestStop(runId);
    consola.log(`Stop requested for run "${runId}" — waiting for it to finish shutting down…`);
    const ok = await waitForAsyncStopSettled({ runStorage, runId, waitTimeoutMs });
    if (!ok) {
      consola.warn(
        `Timed out after ${waitTimeoutMs / 1000}s — run "${runId}" may still be stopping. Check: saifctl run ls`,
      );
      consola.warn(`If it looks stuck, run: saifctl run stop --force ${runId}`);
      return;
    }
    // By now the run stopped or we timed out
    const run = await runStorage.getRun(runId);
    if (run) {
      consola.log(`Run ${runId} finished stopping (status: ${run.status}).`);
    }
    return;
  }

  // Error: Neither running nor paused → cannot stop.
  throw new RunCannotStopError(runId, artifact.status);
}

/** Tears down Docker and sandbox paths recorded on the run (used by `run stop --force`). */
async function bestEffortTeardownRunResources(
  artifact: RunArtifact,
  projectDir: string,
): Promise<void> {
  try {
    const codingEngine = createEngine(artifact.config.codingEnvironment);
    await codingEngine.teardown({
      runId: artifact.runId,
      infra: artifact.liveInfra?.coding ?? null,
      projectDir,
    });
  } catch (err) {
    consola.warn(`Could not fully stop the coding environment for this run: ${String(err)}`);
  }
  try {
    const stagingEngine = createEngine(artifact.config.stagingEnvironment);
    await stagingEngine.teardown({
      runId: artifact.runId,
      infra: artifact.liveInfra?.staging ?? null,
      projectDir,
    });
  } catch (err) {
    consola.warn(`Could not fully stop the test/staging environment for this run: ${String(err)}`);
  }
  const pausedPath = artifact.pausedSandboxBasePath?.trim();
  if (pausedPath) {
    try {
      if (await pathExists(pausedPath)) {
        await destroySandbox(pausedPath);
      }
    } catch (err) {
      consola.warn(`Could not remove the run workspace folder: ${String(err)}`);
    }
  }
}

/** Writes post–force-stop fields (cleared stop request and Docker snapshot); keeps failed/completed as-is. */
async function persistForceStoppedRun(runStorage: RunStorage, runId: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cur = await runStorage.getRun(runId);
    if (!cur) return;
    const rev = cur.artifactRevision ?? 0;
    const t = new Date().toISOString();
    const keepTerminal = cur.status === 'failed' || cur.status === 'completed';
    try {
      await runStorage.saveRun(
        runId,
        {
          ...cur,
          status: keepTerminal ? cur.status : 'failed',
          controlSignal: null,
          pausedSandboxBasePath: null,
          liveInfra: null,
          inspectSession: null,
          updatedAt: t,
          lastFeedback: keepTerminal
            ? cur.lastFeedback
            : (cur.lastFeedback ?? 'Stopped with --force.'),
        },
        { ifRevisionEquals: rev },
      );
      if (keepTerminal) {
        consola.log(`Run "${runId}" cleaned up (still marked ${cur.status}).`);
      } else {
        consola.log(`Run "${runId}" force-stopped.`);
      }
      return;
    } catch (e) {
      if (e instanceof StaleArtifactError && attempt < maxAttempts - 1) continue;
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Mode 3b: inspect (Run → artifact worktree + sandbox + idle coder container)
// ---------------------------------------------------------------------------

/** Options for {@link runInspect}; same shape as {@link FromArtifactOpts} plus an inspect-only Leash flag. */
export type InspectOpts = FromArtifactOpts & {
  /**
   * When true, run the inspect container under Leash/Cedar like the coding agent.
   * Default (false/omitted) uses plain `docker run` so operations blocked by Cedar (e.g. git commit) work.
   */
  inspectLeash?: boolean;
};

/**
 * Opens an idle coding container for a Run.
 *
 * Reuses the full {@link fromArtifactCore} → {@link runStartCore} → `runIterativeLoop` path
 * with `maxRuns: 1` and `runStorage: null`. The coding agent is replaced by an idle
 * `sleep infinity` container via {@link RunAgentOpts#inspectMode}; the user interacts with
 * the container directly. When Ctrl+C is pressed, code changes are extracted and saved back
 * to the original run artifact.
 */
export async function runInspect(opts: InspectOpts): Promise<void> {
  const {
    runId,
    projectDir,
    runStorage,
    cli,
    cliModelDelta,
    config,
    saifctlDir,
    inspectLeash,
    engineCli,
  } = opts;

  if (!runStorage) {
    throw new Error('Run inspect requires run storage (do not use --storage with runs=none).');
  }

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }
  if (artifact.status === 'inspecting') {
    throw new Error(
      `Run "${runId}" is already in inspect mode. Finish the other session (Ctrl+C in that terminal) or clear the artifact.`,
    );
  }
  if (blocksRunInspect(artifact.status)) {
    throw new Error(
      `Run "${runId}" cannot be inspected while status is "${artifact.status}". ` +
        `Wait for it to finish, stop it, or if the process died, edit the artifact under .saifctl/runs/.`,
    );
  }

  // Resolve full orchestrator opts to check the engine type before entering the shared path.
  const deserialized = deserializeArtifactConfig(artifact.config);
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
    artifact,
    engineCli,
  });

  if (mergedOpts.codingEnvironment.engine === 'local') {
    throw new Error(
      'Run inspect does not support coding engine "local" (host-based agent). ' +
        'Use environments.coding with docker (or omit --engine local) for inspect.',
    );
  }

  // Inspect runs plain docker by default so the user can `git commit` inside the container.
  // --leash flag opts in to the Cedar-constrained Leash path.
  mergedOpts.dangerousNoLeash = inspectLeash !== true;

  // The loop must not write to run storage — inspect manages its own artifact save after
  // the session ends (preserving the original status rather than writing 'completed'/'failed').
  mergedOpts.runStorage = null;

  // Single pass: the loop exits after one "coding attempt" (the idle inspect container).
  mergedOpts.maxRuns = 1;

  const statusBeforeInspect = artifact.status;
  let expectedRevision = artifact.artifactRevision ?? 0;
  const prevCommitsJson = JSON.stringify(artifact.runCommits);
  const patchExclude = buildPatchExcludeRules({
    saifctlDir,
    patchExclude: mergedOpts.patchExclude,
    allowSaifctlInPatch: mergedOpts.allowSaifctlInPatch,
  });
  let inspectSaveError: unknown;

  // Commits extracted inside onReady (while the sandbox is still alive) for post-loop save.
  let extractedCommits: RunCommit[] | null = null;

  // Wire up inspectMode: replaces the coding agent with an idle container + user-signal wait.
  mergedOpts.inspectMode = {
    async onReady(session, ctx) {
      // Snapshot HEAD before the user makes any changes — this is the diff base for patch extraction.
      const preInspectHead = (await git({ cwd: ctx.codePath, args: ['rev-parse', 'HEAD'] })).trim();

      const inspectSession: RunInspectSession = {
        containerId: session.containerId,
        containerName: session.containerName,
        workspacePath: session.workspacePath,
        startedAt: new Date().toISOString(),
      };
      expectedRevision = await runStorage.setStatusInspecting(runId, inspectSession);

      consola.log(`\n[inspect] MODE: inspect — ${artifact.config.featureName} (run ${runId})`);
      consola.log(`\n[inspect] Attach your editor with Dev Containers or \`docker exec -it\`:`);
      consola.log(`  Container: \`${session.containerName}\``);
      consola.log(`  Workspace: \`${session.workspacePath}\``);
      consola.log('[inspect] Press Ctrl+C when done to save changes and clean up.\n');

      await new Promise<void>((resolve) => {
        const onExit = (sig: string) => {
          consola.log(
            `\n[inspect] ${sig} received — stopping session and cleaning up Docker (this may take a few seconds)...`,
          );
          // Suppress further SIGINT/SIGTERM so pnpm's signal forwarding can't kill the
          // process while we're doing async cleanup (patch extraction, container stop, etc.).
          const ignore = () => {};
          process.on('SIGINT', ignore);
          process.on('SIGTERM', ignore);
          resolve();
        };
        process.once('SIGINT', () => onExit('SIGINT'));
        process.once('SIGTERM', () => onExit('SIGTERM'));
      });

      try {
        const cur = await runStorage.getRun(runId);
        if (cur?.status === 'inspecting') {
          expectedRevision = await runStorage.saveRun(
            runId,
            {
              ...cur,
              status: statusBeforeInspect,
              inspectSession: null,
              updatedAt: new Date().toISOString(),
            },
            { ifRevisionEquals: cur.artifactRevision ?? 0 },
          );
        }
      } catch (e) {
        consola.warn('[inspect] Could not clear inspect state in storage (non-fatal):', e);
        const cur = await runStorage.getRun(runId);
        if (cur?.artifactRevision != null) {
          expectedRevision = cur.artifactRevision;
        }
      }

      // Extract patch NOW — while the sandbox (bind-mounted codePath) is still alive.
      // session.stop() and sandbox destruction happen after onReady returns.
      const { commits } = await extractIncrementalRoundPatch(ctx.codePath, {
        preRoundHeadSha: preInspectHead,
        attempt: 1,
        message: 'saifctl: inspect session',
        exclude: patchExclude,
      });
      extractedCommits = commits;
    },
  };

  // ── Replicate fromArtifactCore preamble: worktree + fromArtifact context ──
  // We cannot call fromArtifactCore directly because it calls resolveOrchestratorOpts internally
  // and would overwrite the mergedOpts we already built (maxRuns, inspectMode, dangerousNoLeash).
  const { worktreePath, branchName, baseSnapshotPath } = await createArtifactRunWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runCommits: artifact.runCommits,
  });

  mergedOpts.fromArtifact = {
    sandboxSourceDir: worktreePath,
    baseSnapshotPath,
    seedRunCommits: artifact.runCommits,
    seedRoundSummaries: artifact.roundSummaries,
    runContext: {
      baseCommitSha: artifact.baseCommitSha,
      basePatchDiff: artifact.basePatchDiff,
      rules: cloneRunRules(artifact.rules),
    },
    initialErrorFeedback: artifact.lastFeedback,
    persistedRunId: runId,
    artifactRevisionWhenFromArtifact: artifact.artifactRevision ?? 0,
    resumedCodingInfra: null,
    seedSubtasks: artifact.subtasks.map((s) => ({ ...s })),
    currentSubtaskIndex: artifact.currentSubtaskIndex,
    sandboxHostAppliedCommitCount: artifact.sandboxHostAppliedCommitCount,
  };

  // Use a bare CleanupRegistry (no SIGINT wiring — signal handling is done inside onReady).
  // The registry still tracks engines for emergency teardown on unexpected throws.
  const registry = new CleanupRegistry();

  try {
    await runStartCore(mergedOpts, registry);
  } catch (err) {
    // Only swallow errors that occurred after onReady ran (i.e. during teardown after the user
    // pressed Ctrl+C). If onReady was never called, the error happened before the container was
    // ready and must be re-thrown so the user sees it.
    if (extractedCommits === null) {
      throw err;
    }
    // Otherwise: teardown/abort error after a successful session — log and continue to save.
    consola.warn('[inspect] Teardown error after session (non-fatal):', err);
  } finally {
    await cleanupArtifactRunWorktree({ worktreePath, projectDir, branchName }, () => {
      consola.warn(`[orchestrator] Could not clean up worktree at ${worktreePath}`);
    });
  }

  // ── Post-session: save extracted commits back to the original artifact ──

  if (extractedCommits === null) {
    // onReady was never called (e.g. container setup failed before it was ready).
    ensureStdoutNewline();
    return;
  }

  const inspectCommits: RunCommit[] = extractedCommits;

  try {
    const nextCommits =
      inspectCommits.length > 0 ? [...artifact.runCommits, ...inspectCommits] : artifact.runCommits;
    const nextJson = JSON.stringify(nextCommits);

    if (nextJson !== prevCommitsJson) {
      const {
        runStorage: _rs,
        fromArtifact: _fa,
        inspectMode: _im,
        ...artifactLoopOpts
      } = mergedOpts;
      const newArtifact = buildRunArtifact({
        runId,
        baseCommitSha: artifact.baseCommitSha,
        basePatchDiff: artifact.basePatchDiff,
        runCommits: nextCommits,
        sandboxHostAppliedCommitCount: artifact.sandboxHostAppliedCommitCount,
        subtasks: artifact.subtasks.map((s) => ({ ...s })),
        currentSubtaskIndex: artifact.currentSubtaskIndex,
        lastFeedback: artifact.lastFeedback,
        rules: cloneRunRules(artifact.rules),
        roundSummaries: artifact.roundSummaries,
        status: artifact.status,
        controlSignal: artifact.controlSignal,
        pausedSandboxBasePath: artifact.pausedSandboxBasePath,
        opts: artifactLoopOpts as BuildRunArtifactOpts,
        liveInfra: artifact.liveInfra ?? null,
        inspectSession: null,
      });
      try {
        await runStorage.saveRun(runId, newArtifact, { ifRevisionEquals: expectedRevision });
        consola.log('[inspect] Saved updated run commits to storage.');
      } catch (e) {
        if (e instanceof StaleArtifactError) {
          consola.warn(`[inspect] ${(e as Error).message}`);
          const fallback = join(projectDir, `.saifctl-inspect-stale-${runId}.json`);
          await writeUtf8(fallback, nextJson);
          consola.warn(
            `[inspect] Wrote working tree commits to ${fallback} — merge manually after reloading the run.`,
          );
        } else {
          inspectSaveError = e;
        }
      }
    } else {
      consola.log('[inspect] No patch changes; skipping save.');
    }
  } catch (e) {
    inspectSaveError = e;
  }

  if (inspectSaveError) throw inspectSaveError;

  ensureStdoutNewline();
}

// ---------------------------------------------------------------------------
// Mode 3c: apply (Run → host branch + optional push/PR, no sandbox/tests)
// ---------------------------------------------------------------------------

/**
 * Reconstructs the run's codebase state, pushes changes to a branch,
 * and optionally pushes to a remote repository + opens a pull request.
 */
async function runApplyCore(
  opts: FromArtifactOpts,
  _registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const { runId, projectDir, runStorage, cli, cliModelDelta, config, saifctlDir, engineCli } = opts;
  if (!runStorage) {
    throw new Error('Run storage is disabled (--storage none). Cannot apply a Run.');
  }

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }

  const commits = artifact.runCommits;
  if (commits.length === 0) {
    return {
      status: 'failed',
      attempts: 0,
      runId,
      message: 'Run has no commits to apply to the host repository.',
    };
  }

  assertRunCommitsSafeForHost(commits);

  consola.log(`\n[orchestrator] MODE: apply — ${artifact.config.featureName} (run ${runId})`);

  const deserialized = deserializeArtifactConfig(artifact.config);
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
    artifact,
    engineCli,
  });

  const branchName = resolveHostApplyBranchName({
    featureName: feature.name,
    runId,
    commits,
    targetBranch: mergedOpts.targetBranch,
  });

  const { worktreePath, branchName: wtBranch } = await createArtifactRunWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runCommits: commits,
    outputBranchName: branchName,
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'saifctl',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'saifctl@safeaifactory.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'saifctl',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'saifctl@safeaifactory.com',
  };

  const patchFile = join(SAIFCTL_TEMP_ROOT, `saifctl-apply-pr-${runId}.diff`);
  await mkdir(SAIFCTL_TEMP_ROOT, { recursive: true });
  const patchContent = commits.map((c) => c.diff).join('\n');
  await writeUtf8(patchFile, patchContent.endsWith('\n') ? patchContent : `${patchContent}\n`);

  try {
    await pushHostApplyBranch({
      cwd: projectDir,
      projectDir,
      branchName: wtBranch,
      feature,
      runId,
      patchFile,
      push: mergedOpts.push,
      pr: mergedOpts.pr,
      gitProvider: mergedOpts.gitProvider,
      llm: mergedOpts.llm,
      env: gitEnv,
    });
  } finally {
    await unlink(patchFile).catch(() => {});
    await cleanupArtifactRunWorktree(
      { worktreePath, projectDir, branchName: wtBranch, deleteBranch: false },
      () => {
        consola.warn(`[orchestrator] Could not remove apply worktree at ${worktreePath}`);
      },
    );
  }

  return {
    status: 'success',
    attempts: 1,
    runId,
    message: `Patch applied on branch "${wtBranch}"${mergedOpts.push ? ' (pushed)' : ''}.`,
  };
}

/** Options for {@link runExport}. */
export interface RunExportOpts {
  runId: string;
  runStorage: RunStorage;
  /** Repo root (for HEAD vs baseCommitSha warning). */
  projectDir: string;
  /**
   * Output path (default: ./saifctl-<featureName>-<runId>-<diffHash>.patch in cwd;
   * basename matches the default target branch `saifctl/<feature>-<runId>-<hash>`.
   */
  output?: string;
}

/**
 * Export run's changes as a single diff (one unified patch for `git apply` on the working tree).
 */
export async function runExport(opts: RunExportOpts): Promise<OrchestratorResult> {
  const { runId, runStorage, projectDir, output } = opts;
  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    return {
      status: 'failed',
      attempts: 0,
      runId,
      message: `Run not found: ${runId}. List runs with: saifctl run ls`,
    };
  }

  const commits = artifact.runCommits;
  if (!commits.length) {
    return {
      status: 'failed',
      attempts: 0,
      runId,
      message: `Run "${runId}" has no commits to export.`,
    };
  }

  // Reject patches that would touch host .git/hooks (same guard as run apply).
  assertRunCommitsSafeForHost(commits);

  // One multi-patch diff file: stored commits were recorded in order; trailing newline helps git apply.
  const patchContent = commits.map((c) => c.diff).join('\n');
  const normalized = patchContent.endsWith('\n') ? patchContent : `${patchContent}\n`;
  const outTrim = typeof output === 'string' ? output.trim() : '';
  const featureName =
    typeof artifact.config.featureName === 'string' && artifact.config.featureName.trim()
      ? artifact.config.featureName.trim()
      : 'unknown';
  const diffHash = computeRunCommitsDiffHash(commits);
  const defaultPatchBasename = `saifctl-${featureName}-${runId}-${diffHash}.patch`;
  const outPath = outTrim
    ? resolve(process.cwd(), outTrim)
    : join(process.cwd(), defaultPatchBasename);
  await writeUtf8(outPath, normalized);

  // Patches assume the tree matches run start; warn if the user’s branch has moved on.
  try {
    const head = (await git({ cwd: projectDir, args: ['rev-parse', 'HEAD'] })).trim();
    if (head && head !== artifact.baseCommitSha) {
      consola.warn(
        `[run export] Current HEAD (${head.slice(0, 7)}) differs from run base (${artifact.baseCommitSha.slice(0, 7)}). Patch may not apply cleanly.`,
      );
    }
  } catch {
    // not a git repo or unreadable — skip
  }

  const message = [
    `Patch written to: ${outPath}`,
    '',
    'Apply to working tree:',
    `  git apply ${outPath}`,
    '',
    'Stage the diff:',
    `  git apply --cached ${outPath}`,
    '',
    'Dry-run:',
    `  git apply --check ${outPath}`,
  ].join('\n');

  return {
    status: 'success',
    attempts: 1,
    runId,
    message,
  };
}

// ---------------------------------------------------------------------------
// Mode 4: test
// ---------------------------------------------------------------------------

/** Options for {@link runTestsFromRun}; same shape as {@link FromArtifactOpts}. */
export type TestFromRunOpts = FromArtifactOpts;

/**
 * Re-tests the patch from a Run without running the coding agent loop.
 *
 * Useful after a run completes/fails/pauses to re-run just the test phase with
 * updated tests, a different test profile, or to promote a passing patch to a PR.
 *
 * Same pipeline as {@link fromArtifact} with {@link OrchestratorOpts#testOnly}: materialize worktree,
 * sandbox, staging tests, optional host apply — and persist results like from-artifact runs.
 */
async function runTestsFromRunCore(
  opts: TestFromRunOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  return fromArtifactCore({ ...opts, testOnly: true }, registry);
}

/**
 * Resolves the directory `createSandbox` rsyncs FROM.
 *
 * - **Start:** the main project directory (`opts.projectDir`).
 * - **From artifact:** the ephemeral worktree path under `/tmp/worktrees/`
 *   (`opts.fromArtifact.sandboxSourceDir`), materialized from the run artifact.
 */
export function getSandboxSourceDir(opts: {
  projectDir: string;
  fromArtifact: { sandboxSourceDir: string; pausedSandbox?: Sandbox } | null;
}): string {
  if (opts.fromArtifact?.pausedSandbox) {
    return opts.fromArtifact.pausedSandbox.codePath;
  }
  return opts.fromArtifact?.sandboxSourceDir ?? opts.projectDir;
}

/**
 * Checks if the feature tests successfully failed.
 *
 * Skips `sidecar:health` tests (infra health-check).
 */
function hasFeatureSuccessfullyFailed(result: TestsResult): boolean {
  const testSuites: AssertionSuiteResult[] | undefined = parseJUnitXmlString(result.rawJunitXml);
  if (!testSuites) return result.status === 'failed';
  for (const suite of testSuites) {
    for (const assertion of suite.assertionResults) {
      if (assertion.ancestorTitles.includes('sidecar:health')) continue;
      if (assertion.status === 'failed') return true;
    }
  }
  return false;
}
