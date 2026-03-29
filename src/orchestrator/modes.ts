/**
 * Orchestration modes for the Software Factory.
 *
 *  1. fail2pass      — Verify at least one feature test fails on current codebase (sanity check; partial overlap OK)
 *  2. start          — Create a fresh sandbox and run the iterative agent loop
 *  3. fromArtifact   — Start again from a stored run (artifact) then runs the same loop as `start`
 *  4. test           — Re-test a stored run's patch without running the coding agent loop
 *  5. inspect        — Idle coding container for a stored run (changes made in the container are saved)
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveAgentProfile } from '../agent-profiles/index.js';
import type { SaifctlConfig } from '../config/schema.js';
import { createEngine } from '../engines/index.js';
import { defaultEngineLog } from '../engines/logs.js';
import {
  type AssertionSuiteResult,
  type CoderInspectSessionHandle,
  type LiveInfra,
  type TestsResult,
} from '../engines/types.js';
import { parseJUnitXmlString } from '../engines/utils/test-parser.js';
import { getHatchetClient } from '../hatchet/client.js';
import { serializeOrchestratorOpts } from '../hatchet/utils/serialize-opts.js';
import {
  type ConvergenceOutput,
  createFeatRunWorkflow,
  type FeatRunSerializedInput,
} from '../hatchet/workflows/feat-run.workflow.js';
import { type ModelOverrides, resolveAgentLlmConfig } from '../llm-config.js';
import { consola } from '../logger.js';
import { cloneRunRules, rulesForPrompt } from '../runs/rules.js';
import { type RunStorage } from '../runs/storage.js';
import {
  type OuterAttemptSummary,
  RunAlreadyRunningError,
  RunCannotStopError,
  type RunCommit,
  StaleArtifactError,
} from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import { deserializeArtifactConfig } from '../runs/utils/serialize.js';
import { resolveFeature } from '../specs/discover.js';
import { CleanupRegistry } from '../utils/cleanup.js';
import { git } from '../utils/git.js';
import { pathExists, writeUtf8 } from '../utils/io.js';
import { buildCoderContainerEnv } from './agent-env.js';
import { buildTaskPrompt } from './agent-task.js';
import { createAgentStdoutPipe, createDefaultAgentLog } from './logs.js';
import {
  buildInitialTask,
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
import { getArgusBinaryPath } from './sidecars/reviewer/argus.js';
import {
  captureBaseGitState,
  cleanupArtifactRunWorktree,
  createArtifactRunWorktree,
  saveRunOnError,
} from './worktree.js';

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
    /** Prior {@link RunArtifact#roundSummaries} when continuing from a stored run */
    seedRoundSummaries?: OuterAttemptSummary[];
    /**
     * `run resume` when paused sandbox still exists: reuse sandbox dir + Docker bridge from `run pause` (skips createSandbox).
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

export const runFail2Pass = withCleanupRegistry(runFail2PassCore);
export const runStart = withCleanupRegistry(runStartCore);
export const fromArtifact = withCleanupRegistry(fromArtifactCore);
export const runResume = withCleanupRegistry(runResumeCore);
export const runTestsFromRun = withCleanupRegistry(runTestsFromRunCore);
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
    verbose: opts.verbose,
    includeDirty: opts.includeDirty,
  });
  registry.setEmergencySandboxPath(sandbox.sandboxBasePath);
  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
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
    consola.log('[orchestrator] Hatchet token detected — dispatching via Hatchet workflow.');

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
      verbose: opts.verbose,
      runCommits: opts.fromArtifact?.seedRunCommits ?? [],
      runId: opts.fromArtifact?.persistedRunId,
      includeDirty: opts.includeDirty,
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
        specRef: feature.relativePath,
        rules: runContext.rules,
        status: 'running',
        opts: loopOpts,
        pausedSandboxBasePath: null,
        controlSignal: null,
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

export interface FromArtifactOpts {
  runId: string;
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  runStorage: RunStorage;
  cli: OrchestratorCliInput;
  cliModelDelta: ModelOverrides | undefined;
  engineCli: string | undefined;
}

/**
 * Starts again from a stored run. Fetches the artifact, prepares workspace from
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

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }
  if (artifact.status === 'running') {
    throw new Error(
      `Run "${runId}" is already running (status: "running"). ` +
        `If the process died, manually edit or delete the run artifact (e.g. .saifctl/runs/${runId}.json).`,
    );
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
 * Resume a paused run when the sandbox directory and Docker bridge (and coder container) still
 * exist; otherwise clears pause metadata and continues via {@link fromArtifactCore} (same as `run start`).
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
    return fromArtifactCore(opts, registry);
  }

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
    artifactRevisionWhenFromArtifact: artifact.artifactRevision ?? 0,
    seedRoundSummaries: artifact.roundSummaries,
    pausedSandbox: resumeSandbox,
    resumedCodingInfra,
  };

  return runStartCore(mergedOpts, registry);
}

// ---------------------------------------------------------------------------
// Pause: running → paused
// ---------------------------------------------------------------------------

/** Poll interval while waiting for a run to leave `"running"` (pause / stop). */
const RUN_WAIT_POLL_MS = 1000;

/** Default max wait when `run pause` / `run stop` await orchestrator teardown (seconds → ms at CLI). */
const DEFAULT_RUN_WAIT_TIMEOUT_MS = 60_000;

async function waitForRunNotRunning(opts: {
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
    if (cur.status !== 'running') return true;
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

  const ok = await waitForRunNotRunning({ runStorage, runId, waitTimeoutMs });
  if (!ok) {
    consola.warn(
      `[orchestrator] Timed out after ${waitTimeoutMs / 1000}s waiting for run "${runId}" to leave status "running". Check with: saifctl run ls`,
    );
    return;
  }

  // By now the run paused or we timed out
  const run = await runStorage.getRun(runId);
  consola.log(`Run ${runId} finished pausing (status: ${run?.status ?? 'unknown'}).`);
}

/**
 * Stop a run: for `"running"`, sets {@link RunArtifact#controlSignal} `stop`
 * and waits until status changes (polling storage);
 * For `"paused"`, tears down Docker + sandbox synchronously and saves `failed`.
 */
export async function runStop(opts: {
  runId: string;
  projectDir: string;
  runStorage: RunStorage;
  waitTimeoutMs?: number;
}): Promise<void> {
  const { runId, projectDir, runStorage } = opts;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_RUN_WAIT_TIMEOUT_MS;

  // Get run artifact from storage
  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }

  // If the run is paused, tear down Docker + sandbox synchronously and save `failed`
  if (artifact.status === 'paused') {
    const pausedPath = artifact.pausedSandboxBasePath?.trim();
    if (!pausedPath) {
      throw new Error(
        `Run "${runId}" is paused but missing pausedSandboxBasePath; cannot tear down resources.`,
      );
    }

    // Tear down Docker (containers, docker-compose, networks, etc)
    const codingEngine = createEngine(artifact.config.codingEnvironment);
    const storedCoding = artifact.liveInfra?.coding ?? null;
    await codingEngine.teardown({ runId: artifact.runId, infra: storedCoding, projectDir });

    // Destroy sandbox
    await destroySandbox(pausedPath);
    const rev = artifact.artifactRevision ?? 0;
    const t = new Date().toISOString();

    // Mark as failed
    await runStorage.saveRun(
      runId,
      {
        ...artifact,
        status: 'failed',
        controlSignal: null,
        pausedSandboxBasePath: null,
        updatedAt: t,
      },
      { ifRevisionEquals: rev },
    );
    consola.log(
      `[orchestrator] Stopped paused run ${runId} — artifact status: failed, sandbox removed.`,
    );
    return;
  }

  // The agent is running. To stop the process, we need to request stop.
  // This is same logic as runPause.
  if (artifact.status === 'running') {
    // Request stop by changing state in storage
    // The running Run polls the storage and that's how it finds about our
    // stop request.
    await runStorage.requestStop(runId);
    consola.log(`Stop requested for run ${runId} — waiting for orchestrator to finish teardown...`);
    const ok = await waitForRunNotRunning({ runStorage, runId, waitTimeoutMs });
    if (!ok) {
      consola.warn(
        `[orchestrator] Timed out after ${waitTimeoutMs / 1000}s waiting for run "${runId}" to leave status "running". Check with: saifctl run ls`,
      );
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

// ---------------------------------------------------------------------------
// Mode 3b: inspect (stored run → artifact worktree + sandbox + idle coder container)
// ---------------------------------------------------------------------------

export type InspectOpts = FromArtifactOpts & {
  /**
   * When true, run the inspect container under Leash/Cedar like the coding agent.
   * Default (false/omitted) uses plain `docker run` so operations blocked by Cedar (e.g. git commit) work.
   */
  inspectLeash?: boolean;
};

/**
 * Opens the same coding environment as the first round of `run start`, with an idle container
 * (`sleep infinity`). When the process is stopped, code changes from the container are extracted
 * and saved the same way as when we run the coding agent. Thus, allowing the user
 * to manually code the feature and save the changes to the run storage.
 *
 * Not wrapped with the cleanup-registry decorator: SIGINT ends the wait and
 * runs a controlled teardown (save + destroy) instead of the global registry exit path.
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
  const inspectDangerousNoLeash = inspectLeash !== true;

  if (!runStorage) {
    throw new Error('Run inspect requires run storage (do not use --storage with runs=none).');
  }

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifctl run ls`);
  }
  if (artifact.status === 'running') {
    throw new Error(
      `Run "${runId}" is already running (status: "running"). ` +
        `If the process died, manually edit or delete the run artifact (e.g. .saifctl/runs/${runId}.json).`,
    );
  }

  consola.log(`\n[orchestrator] MODE: inspect — ${artifact.config.featureName} (run ${runId})`);

  const { worktreePath, branchName, baseSnapshotPath } = await createArtifactRunWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runCommits: artifact.runCommits,
  });

  const expectedRevision = artifact.artifactRevision ?? 0;
  const prevCommitsJson = JSON.stringify(artifact.runCommits);
  let inspectSaveError: unknown;

  try {
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

    mergedOpts.fromArtifact = {
      sandboxSourceDir: worktreePath,
      baseSnapshotPath,
      seedRunCommits: artifact.runCommits,
      runContext: {
        baseCommitSha: artifact.baseCommitSha,
        basePatchDiff: artifact.basePatchDiff,
        rules: cloneRunRules(artifact.rules),
      },
      initialErrorFeedback: artifact.lastFeedback,
      resumedCodingInfra: null,
    };

    const sandboxSourceDir = getSandboxSourceDir(mergedOpts);
    const sandbox = await createSandbox({
      feature,
      projectDir: sandboxSourceDir,
      codeSourceDir: mergedOpts.fromArtifact?.baseSnapshotPath ?? sandboxSourceDir,
      saifctlDir,
      projectName: mergedOpts.projectName,
      sandboxBaseDir: mergedOpts.sandboxBaseDir,
      gateScript: mergedOpts.gateScript,
      startupScript: mergedOpts.startupScript,
      agentInstallScript: mergedOpts.agentInstallScript,
      agentScript: mergedOpts.agentScript,
      stageScript: mergedOpts.stageScript,
      verbose: mergedOpts.verbose,
      runCommits: mergedOpts.fromArtifact?.seedRunCommits ?? [],
      includeDirty: mergedOpts.includeDirty,
    });

    logIterativeLoopSettings(mergedOpts, { runId });

    const preInspectHead = (
      await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
    ).trim();

    const patchExclude = buildPatchExcludeRules(saifctlDir, mergedOpts.patchExclude);

    const runContext = mergedOpts.fromArtifact.runContext;
    const inspectRunId = `${sandbox.runId}-inspect`;
    const codingEngine = createEngine(mergedOpts.codingEnvironment);

    const task = await buildInitialTask({
      feature,
      saifctlDir,
      rules: rulesForPrompt(runContext.rules),
    });
    const errorFeedback = artifact.lastFeedback ?? '';

    const coderLlmConfig = resolveAgentLlmConfig('coder', mergedOpts.overrides);
    const reviewer = mergedOpts.reviewerEnabled
      ? {
          llmConfig: resolveAgentLlmConfig('reviewer', mergedOpts.overrides),
          argusBinaryPath: await getArgusBinaryPath(),
        }
      : null;

    // Full task text: feature spec + rules + prior feedback (same shape as the coding agent).
    const taskPrompt = await buildTaskPrompt({
      codePath: sandbox.codePath,
      task,
      saifctlDir,
      feature,
      errorFeedback,
    });

    // Env vars and secrets passed into the inspect coder container.
    const inspectContainerEnv = await buildCoderContainerEnv({
      mode: { kind: 'container' },
      llmConfig: coderLlmConfig,
      reviewer: reviewer ? { llmConfig: reviewer.llmConfig } : null,
      agentEnv: mergedOpts.agentEnv,
      projectDir: mergedOpts.projectDir,
      agentSecretKeys: mergedOpts.agentSecretKeys,
      agentSecretFiles: mergedOpts.agentSecretFiles,
      taskPrompt,
      gateRetries: mergedOpts.gateRetries,
      runId,
    });

    let inspectHandle: CoderInspectSessionHandle | null = null;

    // Track latest live infra for engine.teardown() after the inspect session stops.
    // Each operation may mutate the live infra shape. There is no CleanupRegistry here:
    // SIGINT ends the wait and this finally path runs teardown explicitly.
    let inspectTeardownInfra: LiveInfra | null = null;

    try {
      try {
        // Provision network (and optional compose); Docker coding also includes
        // the leash container for teardown.
        const { infra: inspectSetupInfra } = await codingEngine.setup({
          runId: inspectRunId,
          projectName: mergedOpts.projectName,
          featureName: feature.name,
          projectDir: mergedOpts.projectDir,
          sandboxBasePath: sandbox.sandboxBasePath,
        });
        inspectTeardownInfra = inspectSetupInfra;

        // Stream inspect stdout/stderr according to profile (e.g. tee vs line-buffered logs).
        const inspectAgentProfile = resolveAgentProfile(mergedOpts.agentProfileId);
        const inspectLogStrategy = inspectAgentProfile.stdoutStrategy;
        const { onAgentStdout, onAgentStdoutEnd } = createAgentStdoutPipe({
          stdoutStrategy: inspectLogStrategy,
          onAgentLog: createDefaultAgentLog({
            linePrefix: 'inspect',
            stdoutStrategy: inspectLogStrategy,
          }),
        });

        // Idle coder container + workspace for manual editing; updates infra for teardown.
        const { session, infra: afterInspect } = await codingEngine.startInspect({
          codePath: sandbox.codePath,
          sandboxBasePath: sandbox.sandboxBasePath,
          containerEnv: inspectContainerEnv,
          coderImage: mergedOpts.coderImage,
          dangerousNoLeash: inspectDangerousNoLeash,
          cedarPolicyPath: mergedOpts.cedarPolicyPath,
          saifctlPath: sandbox.saifctlPath,
          onAgentStdout,
          onAgentStdoutEnd,
          onLog: defaultEngineLog,
          reviewer: reviewer ? { argusBinaryPath: reviewer.argusBinaryPath } : null,
          infra: inspectSetupInfra,
        });
        inspectHandle = session;
        inspectTeardownInfra = afterInspect;

        consola.log(`\n[inspect] Attach your editor with Dev Containers or \`docker exec -it\`:`);
        consola.log(`  Container: \`${inspectHandle.containerName}\``);
        consola.log(`  Workspace: \`${inspectHandle.workspacePath}\``);
        consola.log('[inspect] Press Ctrl+C when done to save changes and clean up.\n');

        await new Promise<void>((resolve) => {
          const onExit = (sig: string) => {
            consola.log(
              `\n[inspect] ${sig} received — stopping session and cleaning up Docker (this may take a few seconds)...`,
            );
            resolve();
          };
          process.once('SIGINT', () => onExit('SIGINT'));
          process.once('SIGTERM', () => onExit('SIGTERM'));
        });
      } finally {
        const ignore = () => {};
        process.on('SIGINT', ignore);
        process.on('SIGTERM', ignore);
        try {
          if (inspectHandle) {
            await inspectHandle.stop().catch((err: unknown) => {
              consola.warn('[inspect] inspect session stop:', err);
            });
          }
          // Teardown when we have an infra snapshot (null ⇒ failed setup ⇒ no-ops / warns).
          await codingEngine
            .teardown({
              runId: inspectRunId,
              infra: inspectTeardownInfra,
              projectDir: mergedOpts.projectDir,
            })
            .catch((err: unknown) => {
              consola.warn('[inspect] engine teardown:', err);
            });

          // Extract any changes made in the container
          const { commits: inspectCommits } = await extractIncrementalRoundPatch(sandbox.codePath, {
            preRoundHeadSha: preInspectHead,
            attempt: 1,
            message: 'saifctl: inspect session',
            exclude: patchExclude,
          });
          const nextCommits =
            inspectCommits.length > 0
              ? [...artifact.runCommits, ...inspectCommits]
              : artifact.runCommits;
          const nextJson = JSON.stringify(nextCommits);
          if (nextJson !== prevCommitsJson) {
            const { runStorage: _rs, fromArtifact: _fa, ...artifactLoopOpts } = mergedOpts;
            const newArtifact = buildRunArtifact({
              runId,
              baseCommitSha: runContext.baseCommitSha,
              basePatchDiff: runContext.basePatchDiff,
              runCommits: nextCommits,
              specRef: feature.relativePath,
              lastFeedback: artifact.lastFeedback,
              rules: runContext.rules,
              roundSummaries: artifact.roundSummaries,
              status: artifact.status,
              controlSignal: artifact.controlSignal,
              pausedSandboxBasePath: artifact.pausedSandboxBasePath,
              opts: artifactLoopOpts as BuildRunArtifactOpts,
              liveInfra: artifact.liveInfra ?? null,
            });
            try {
              await runStorage.saveRun(runId, newArtifact, {
                ifRevisionEquals: expectedRevision,
              });
              consola.log('[inspect] Saved updated run commits to storage.');
            } catch (e) {
              if (e instanceof StaleArtifactError) {
                consola.warn(`[inspect] ${e.message}`);
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
        } finally {
          process.removeListener('SIGINT', ignore);
          process.removeListener('SIGTERM', ignore);
        }
      }
    } finally {
      await destroySandbox(sandbox.sandboxBasePath);
    }
  } finally {
    await cleanupArtifactRunWorktree({ worktreePath, projectDir, branchName }, () => {
      consola.warn(`[orchestrator] Could not clean up worktree at ${worktreePath}`);
    });
  }

  if (inspectSaveError) throw inspectSaveError;
}

// ---------------------------------------------------------------------------
// Mode 3c: apply (stored run → host branch + optional push/PR, no sandbox/tests)
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
    throw new Error('Run storage is disabled (--storage none). Cannot apply a stored run.');
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
      overrides: mergedOpts.overrides,
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

export type TestFromRunOpts = FromArtifactOpts;

/**
 * Re-tests the patch from a stored run without running the coding agent loop.
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
