/**
 * Four orchestration modes for the Software Factory.
 *
 *  1. fail2pass      — Verify at least one feature test fails on current codebase (sanity check; partial overlap OK)
 *  2. start          — Create a fresh sandbox and run the iterative agent loop
 *  3. resume         — Resume a failed run from storage then calls start
 *  4. test           — Re-test a stored run's patch without running the coding agent loop
 */

import { join } from 'node:path';

import { getHatchetClient } from '../hatchet/client.js';
import { serializeOrchestratorOpts } from '../hatchet/utils/serialize-opts.js';
import {
  createFeatRunWorkflow,
  type FeatRunSerializedInput,
} from '../hatchet/workflows/feat-run.workflow.js';
import { consola } from '../logger.js';
import { hasFeatureSuccessfullyFailed } from '../provisioners/docker/index.js';
import { createProvisioner } from '../provisioners/index.js';
import { type TestsResult } from '../provisioners/types.js';
import { deserializeArtifactConfig, type RunStorage } from '../runs/index.js';
import { type Feature, resolveFeature } from '../specs/discover.js';
import { CleanupRegistry } from '../utils/cleanup.js';
import { pathExists, writeUtf8 } from '../utils/io.js';
import {
  type IterativeLoopOpts,
  type OrchestratorResult,
  prepareTestRunnerOpts,
  runIterativeLoop,
  type RunStorageContext,
  runVagueSpecsCheckerForFailure,
} from './loop.js';
import { applyPatchToHost } from './phases/apply-patch.js';
import {
  captureBaseGitState,
  cleanupResumeWorkspace,
  createResumeWorktree,
  mergeResumeOpts,
  saveRunOnError,
} from './resume.js';
import { applyPatch, createSandbox, destroySandbox } from './sandbox.js';

export interface OrchestratorOpts extends IterativeLoopOpts {
  /**
   * Base directory where sandbox entries are created.
   */
  sandboxBaseDir: string;
  /**
   * Content of the gate script to run after each OpenHands round. In leash mode the script is
   * written to sandboxBasePath/gate.sh and mounted read-only at /saifac/gate.sh inside the
   * container. In --dangerous-debug mode it runs directly on the host via bash.
   *
   * It must exit 0 to pass; non-zero causes the inner loop to retry with the output as feedback.
   *
   * Resolved by the CLI: defaults to the gate.sh from the resolved sandbox profile when --gate-script is not set.
   */
  gateScript: string;
  /**
   * Content of the startup script to run once before the agent loop begins.
   * Written to sandboxBasePath/startup.sh and mounted read-only at /saifac/startup.sh
   * inside the coder container (or run directly on the host in --dangerous-debug mode).
   *
   * Use for workspace setup that requires the workspace to be mounted first:
   * pnpm install, pip install -r requirements.txt, cargo fetch, etc.
   *
   * Resolved by the CLI: set via --profile or --startup-script. When neither is
   * provided, the profile's installation script is used.
   */
  startupScript: string;
  /**
   * Content of the agent setup script to write into the sandbox as `agent-start.sh`.
   * Mounted read-only at `/saifac/agent-start.sh` inside the coder container and executed
   * once by `coder-start.sh` after the startup script, before the agent loop begins.
   *
   * Use to install the coding agent at runtime (e.g. `pipx install aider-chat`).
   *
   * Resolved by the CLI: defaults to the agent profile's agent-start.sh.
   */
  agentStartScript: string;
  /**
   * Content of the agent script to write into the sandbox as `agent.sh`.
   * Mounted read-only at `/saifac/agent.sh` inside the coder container and invoked
   * by `coder-start.sh` once per inner round. The script must read the task from
   * `$SAIFAC_TASK_PATH`.
   *
   * Resolved by the CLI: defaults to the agent profile's agent.sh (OpenHands) when
   * --agent and --agent-script are not set.
   */
  agentScript: string;
  /**
   * Content of the staging script mounted read-only in the staging container at /saifac/stage.sh.
   * Invoked by staging-start.sh after the installation script and the sidecar have run.
   *
   * Resolved by the CLI: set via --profile or --stage-script. When neither is provided,
   * the profile's stage script is used.
   */
  stageScript: string;
  /**
   * Run storage for persisting failed runs. Resolved by CLI via parseRunStorage.
   * Default: local (.saifac/runs/) when --storage is omitted. Set to null for --storage runs=none.
   */
  runStorage: RunStorage | null;
  /**
   * When set, runStartCore operates in resume mode: use sandboxSourceDir for createSandbox,
   * skip base git capture, and pass initialErrorFeedback to the loop.
   * Only used when runResumeCore delegates to runStartCore.
   */
  resume: {
    sandboxSourceDir: string;
    runContext: RunStorageContext;
    initialErrorFeedback?: string;
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
    // It also saves the run state to runStorage so the user can resume later.
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
export const runResume = withCleanupRegistry(runResumeCore);
export const runTestsFromRun = withCleanupRegistry(runTestsFromRunCore);

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
  | 'saifDir'
  | 'projectName'
  | 'sandboxBaseDir'
  | 'testImage'
  | 'stagingEnvironment'
  | 'startupScript'
  | 'gateScript'
  | 'agentStartScript'
  | 'agentScript'
  | 'stageScript'
  | 'testScript'
  | 'verbose'
>;

async function runFail2PassCore(
  opts: Fail2PassOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    testImage,
    stagingEnvironment,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    testScript,
  } = opts;

  consola.log(`\n[orchestrator] MODE: fail2pass — ${feature.name}`);

  const sandbox = await createSandbox({
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    verbose: opts.verbose,
  });
  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  const provisioner = createProvisioner(stagingEnvironment);
  registry.registerProvisioner(provisioner, sandbox.runId);

  try {
    await provisioner.setup({
      runId: sandbox.runId,
      projectName,
      featureName: feature.name,
      projectDir,
    });

    const stagingHandle = await provisioner.startStaging({
      sandboxProfileId,
      codePath: sandbox.codePath,
      projectDir,
      stagingEnvironment,
      feature,
      projectName,
      startupPath: sandbox.startupPath,
      stagePath: sandbox.stagePath,
    });

    const result = await provisioner.runTests({
      ...testRunnerOpts,
      stagingHandle,
      testImage,
      runId: sandbox.runId,
      feature,
      projectName,
      reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
    });

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
        success: true,
        attempts: 1,
        message: 'Tests correctly fail on current codebase. Ready to start the iterative loop.',
      };
    } else {
      consola.error(
        '\n[orchestrator] ✗ FAIL2PASS REJECTED — no feature tests failed on current codebase',
      );
      consola.error('Either the feature already exists or the tests are invalid.');
      return {
        success: false,
        attempts: 1,
        message:
          'No feature tests failed on current codebase — feature may already be implemented or tests are invalid.',
      };
    }
  } finally {
    registry.deregisterProvisioner(provisioner);
    await provisioner.teardown({ runId: sandbox.runId });
    await destroySandbox(sandbox.sandboxBasePath);
  }
}

// ---------------------------------------------------------------------------
// Mode 2: start
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
    saifDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
    runStorage,
  } = opts;

  consola.log(`\n[orchestrator] MODE: start — ${feature.name}`);

  const sandboxSourceDir = getSandboxSourceDir(opts);

  // ─── Run context (for save-on-Ctrl+C / save-on-failure) ────────────────────
  // Capture all the relevant state so that we can resume the run later.
  // Thus, if `runIterativeLoop` throws or user aborts with CTRL+C, the loop
  // will persist an artifact with all the relevant state so the user can
  // resume later with `saifac run resume <runId>`.
  let runContext: RunStorageContext;
  if (opts.resume) {
    // Resume: use the context from the stored artifact
    runContext = opts.resume.runContext;
  } else {
    // Start: capture the current git state so we can reconstruct it when resuming
    runContext = await captureBaseGitState(projectDir);
  }

  const sandbox = await createSandbox({
    feature,
    projectDir: sandboxSourceDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
    verbose: opts.verbose,
  });

  // ─── Save run artifact (on Ctrl+C / failure) ───────────────────────────────
  // This runs before teardown. If the agent produced any diff (patch.diff exists and is non-empty),
  // we persist an artifact to runStorage so the user can resume later with `saifac run resume <runId>`.
  if (runStorage) {
    registry.setBeforeCleanup(async () => {
      await saveRunOnError({
        sandbox,
        runContext,
        opts: opts as IterativeLoopOpts & {
          gitProvider: { id: string };
          testProfile: { id: string };
        },
        runStorage,
        saifDir,
      });
    });
  }

  // ─── Hatchet path ─────────────────────────────────────────────────────────
  // When HATCHET_CLIENT_TOKEN is set, dispatch via Hatchet (distributed mode).
  // Signal handling is skipped here — Hatchet owns the worker process lifecycle.
  //
  // OrchestratorOpts is not JSON-serializable (contains gitProvider/testProfile class
  // instances, patchExclude RegExp), so we serialize it at dispatch and reconstruct it
  // on the worker via deserializeOrchestratorOpts — no ambient in-process state needed.
  const hatchet = getHatchetClient();
  if (hatchet) {
    consola.log('[orchestrator] Hatchet token detected — dispatching via Hatchet workflow.');

    const serializedOpts = serializeOrchestratorOpts(opts);
    const featRunWorkflow = createFeatRunWorkflow();

    // Start an inline worker for this request. In production a persistent
    // worker process (`saifac worker start`) is preferred.
    const worker = await hatchet.worker('saifac-worker', { workflows: [featRunWorkflow] });
    await worker.start();

    try {
      const input: FeatRunSerializedInput = {
        serializedOpts,
        runContext: {
          baseCommitSha: runContext.baseCommitSha,
          basePatchDiff: runContext.basePatchDiff,
          lastErrorFeedback: runContext.lastErrorFeedback,
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await hatchet.run<FeatRunSerializedInput, any>(
        featRunWorkflow.name,
        input,
      )) as OrchestratorResult;
    } finally {
      // Note: There is finally, but not `catch` branch, so the error still throws
      // after the cleanup.
      await worker.stop();
    }
  }

  // ─── Existing in-process path ──────────────────────────────────────────────
  return runIterativeLoop(sandbox, {
    ...opts,
    saifDir,
    runStorage,
    runContext,
    initialErrorFeedback: opts.resume?.initialErrorFeedback ?? null,
    registry,
  });
}

// ---------------------------------------------------------------------------
// Mode 3: resume (from storage)
// ---------------------------------------------------------------------------

interface ResumeOpts extends OrchestratorOpts {
  runId: string;
  runStorage: RunStorage;
}

/**
 * Resumes a run from storage. Fetches the artifact, prepares workspace from
 * baseCommitSha + diffs, creates a fresh sandbox, and runs the loop.
 * Delegates to runStartCore with resume opts.
 */
async function runResumeCore(
  opts: ResumeOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const { runId, projectDir, runStorage, overrides } = opts;

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifac run ls`);
  }

  consola.log(`\n[orchestrator] MODE: resume — ${artifact.config.featureName} (run ${runId})`);

  // Create temp worktree in `.saifac/worktrees/resume-<runId>`
  // to reconstruct the state of the workspace at the time of the run (+ agent's changes)
  const { worktreePath, branchName } = await createResumeWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runPatchDiff: artifact.runPatchDiff,
  });

  // Load the original opts from the stored artifact and merge them with the CLI opts.
  // User gets all original settings by default but can override via CLI.
  // E.g. if user wants to keep all the same options except for the model, they can do:
  // `saifac run resume <runId> --model anthropic/claude-3-5-sonnet-latest`
  //
  // NOTE: This also sets `resume.sandboxSourceDir` to `worktreePath`. Thus, telling
  // runStartCore to use the worktree as the sandbox source directory.
  const mergedOpts = await mergeResumeOpts({
    artifact,
    opts,
    overrides,
    worktreePath,
  });

  try {
    // Finally, run the same flow as when we run `saifac feat start <featureName>`
    return await runStartCore(mergedOpts, registry);
  } finally {
    await cleanupResumeWorkspace({ worktreePath, projectDir, branchName }, () => {
      // Best-effort cleanup
    });
  }
}

// ---------------------------------------------------------------------------
// Mode 4: test
// ---------------------------------------------------------------------------

type SharedTestOpts = Pick<
  OrchestratorOpts,
  | 'sandboxProfileId'
  | 'projectDir'
  | 'testRetries'
  | 'saifDir'
  | 'projectName'
  | 'sandboxBaseDir'
  | 'testImage'
  | 'stagingEnvironment'
  | 'resolveAmbiguity'
  | 'startupScript'
  | 'gateScript'
  | 'agentStartScript'
  | 'agentScript'
  | 'stageScript'
  | 'testScript'
  | 'testProfile'
  | 'push'
  | 'pr'
  | 'gitProvider'
  | 'overrides'
  | 'reviewerEnabled'
  | 'verbose'
>;
export interface TestFromRunOpts extends SharedTestOpts {
  runId: string;
  runStorage: RunStorage;
}

/**
 * Re-tests the patch from a stored run without running the coding agent loop.
 *
 * 1. Fetches the run artifact from storage.
 * 2. Reconstructs the workspace (base commit + basePatchDiff + runPatchDiff) via a git worktree.
 * 3. Writes the agent patch to a temp file.
 * 4. Delegates to runTestsCore (staging → tests → optional downstream push/PR).
 *
 * Useful after a run completes/fails/pauses to re-run just the test phase with
 * updated tests, a different test profile, or to promote a passing patch to a PR.
 */
async function runTestsFromRunCore(
  opts: TestFromRunOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const { runId, projectDir, runStorage } = opts;

  const artifact = await runStorage.getRun(runId);
  if (!artifact) {
    throw new Error(`Run not found: ${runId}. List runs with: saifac run ls`);
  }

  consola.log(
    `\n[orchestrator] MODE: test-from-run — ${artifact.config.featureName} (run ${runId})`,
  );

  const { worktreePath, branchName } = await createResumeWorktree({
    projectDir,
    runId,
    baseCommitSha: artifact.baseCommitSha,
    basePatchDiff: artifact.basePatchDiff,
    runPatchDiff: artifact.runPatchDiff,
  });

  try {
    const deserialized = deserializeArtifactConfig(artifact.config);
    const feature = await resolveFeature({
      input: deserialized.featureName,
      projectDir,
      saifDir: deserialized.saifDir,
    });

    // Write the agent's patch diff to a temp file so runTestsCore can apply it.
    // The worktree is already at baseCommit+basePatch state; runPatchDiff is the
    // delta the coding agent produced. runTestsCore will apply it on top.
    const patchPath = join(worktreePath, '.saifac-run-test.patch');
    await writeUtf8(patchPath, artifact.runPatchDiff);

    return await runTestsCore(
      {
        ...opts,
        feature,
        projectDir: worktreePath,
        patchPath,
      },
      registry,
    );
  } finally {
    await cleanupResumeWorkspace({ worktreePath, projectDir, branchName }, () => {
      // Best-effort cleanup — log but don't throw
      consola.warn(`[orchestrator] Could not clean up worktree at ${worktreePath}`);
    });
  }
}

type TestOpts = SharedTestOpts & {
  feature: Feature;
  /**
   * Required for mode='test': path to a patch file to apply before tests.
   * (e.g. /path/to/patch.diff)
   */
  patchPath: string | null;
};

/**
 * Applies a candidate patch to a fresh sandbox and runs tests.
 *
 * If tests fail, retries up to testRetries (useful for flaky environments).
 * If tests pass, applies the patch to the host repo and opens a PR.
 */
async function runTestsCore(
  opts: TestOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    patchPath,
    testRetries,
    saifDir,
    projectName,
    sandboxBaseDir,
    testImage,
    stagingEnvironment,
    resolveAmbiguity,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    testScript,
    testProfile,
    push,
    pr,
    gitProvider,
    overrides,
    verbose,
  } = opts;

  if (!patchPath) {
    throw new Error("mode='test' requires --patch pointing to a patch file.");
  }
  if (!(await pathExists(patchPath))) {
    throw new Error(`Patch file not found: ${patchPath}`);
  }

  consola.log(`\n[orchestrator] MODE: test — ${feature.name}`);
  consola.log(`[orchestrator] Patch: ${patchPath}`);

  const sandbox = await createSandbox({
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    verbose,
  });
  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  // Apply the candidate patch
  await applyPatch(sandbox.codePath, patchPath);

  let lastStderr = '';
  let attempts = 0;

  try {
    while (attempts < testRetries) {
      attempts++;
      consola.log(`\n[orchestrator] Test attempt ${attempts}/${testRetries}`);

      const runId = `${sandbox.runId}-${attempts}`;
      const provisioner = createProvisioner(stagingEnvironment);
      registry.registerProvisioner(provisioner, runId);

      await provisioner.setup({ runId, projectName, featureName: feature.name, projectDir });

      const result: TestsResult = await (async (): Promise<TestsResult> => {
        try {
          const stagingHandle = await provisioner.startStaging({
            sandboxProfileId,
            codePath: sandbox.codePath,
            projectDir,
            stagingEnvironment,
            feature,
            projectName,
            startupPath: sandbox.startupPath,
            stagePath: sandbox.stagePath,
          });

          return await provisioner.runTests({
            ...testRunnerOpts,
            stagingHandle,
            testImage,
            runId,
            feature,
            projectName,
            reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
          });
        } finally {
          registry.deregisterProvisioner(provisioner);
          await provisioner.teardown({ runId });
        }
      })();

      lastStderr = result.stderr;

      if (result.runnerError) {
        throw new Error(
          `Test runner error on attempt ${attempts}: ${result.runnerError}\n` +
            `Check that runner.spec.ts and tests.json are present and valid.\n` +
            `Stderr:\n${result.stderr}`,
        );
      }

      if (result.status === 'passed') {
        consola.log('\n[orchestrator] ✓ ALL TESTS PASSED');
        await applyPatchToHost({
          codePath: sandbox.codePath,
          projectDir,
          feature,
          runId,
          push,
          pr,
          gitProvider,
          overrides,
          verbose,
        });
        return {
          success: true,
          attempts,
          patchPath,
          message: `Patch verified and applied to host repository after ${attempts} attempt(s).`,
        };
      } else if (result.status === 'aborted') {
        consola.log(`\n[orchestrator] Tests aborted after ${attempts} attempt(s).`);
        return {
          success: false,
          attempts,
          message: `Tests were aborted after ${attempts} attempt(s).`,
        };
      }

      consola.log(`\n[orchestrator] Test attempt ${attempts} FAILED`);

      if (resolveAmbiguity !== 'off' && result.testSuites) {
        const VagueSpecsCheckResult = await runVagueSpecsCheckerForFailure({
          projectDir,
          feature,
          testSuites: result.testSuites,
          resolveAmbiguity,
          testProfile,
          projectName,
          overrides,
        });

        if (VagueSpecsCheckResult.ambiguityResolved) {
          // Spec updated and tests regenerated — retry the same patch against the new tests.
          // Don't count this attempt against testRetries since the spec was at fault.
          consola.log(
            '[orchestrator] Spec ambiguity resolved — retrying tests with updated tests.',
          );
          attempts--;
        }
      }
    }

    return {
      success: false,
      attempts,
      message: `Tests failed after ${testRetries} attempt(s). Last stderr:\n${lastStderr}`,
    };
  } finally {
    await destroySandbox(sandbox.sandboxBasePath);
  }
}

// ---------------------------------------------------------------------------
// Debug mode
// ---------------------------------------------------------------------------

/**
 * Spins up the agent container (+ any ephemeral containers from tests.json)
 * and streams its logs live until Ctrl+C. No test runner, no test run.
 *
 * Useful for diagnosing startup failures: installation script output, sidecar boot
 * errors, missing binaries, etc.
 */
export async function runDebug(
  opts: Pick<
    OrchestratorOpts,
    | 'sandboxProfileId'
    | 'feature'
    | 'projectDir'
    | 'saifDir'
    | 'projectName'
    | 'sandboxBaseDir'
    | 'stagingEnvironment'
    | 'startupScript'
    | 'gateScript'
    | 'agentStartScript'
    | 'agentScript'
    | 'stageScript'
  >,
): Promise<void> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    stagingEnvironment,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  } = opts;

  consola.log(`\n[orchestrator] DEBUG MODE — ${feature.name}`);

  const sandbox = await createSandbox({
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  });
  const runId = sandbox.runId;
  const provisioner = createProvisioner(stagingEnvironment);

  // pnpm forwards SIGTERM immediately after Ctrl+C. Ignore both signals while
  // the finally block is running so Docker API calls aren't cut short.
  const ignoreSignal = () => {};
  process.on('SIGINT', ignoreSignal);
  process.on('SIGTERM', ignoreSignal);

  try {
    await provisioner.setup({ runId, projectName, featureName: feature.name, projectDir });

    const stagingHandle = await provisioner.startStaging({
      sandboxProfileId,
      codePath: sandbox.codePath,
      projectDir,
      stagingEnvironment,
      feature,
      projectName,
      startupPath: sandbox.startupPath,
      stagePath: sandbox.stagePath,
    });

    consola.log(`\n[debug] Staging app ready — target: ${stagingHandle.targetUrl}`);
    consola.log(`[debug] Sidecar: ${stagingHandle.sidecarUrl}`);
    consola.log('[debug] Press Ctrl+C to stop.\n');

    // Block until SIGINT
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        consola.log('\n[debug] SIGINT received — tearing down...');
        resolve();
      });
    });
  } finally {
    await provisioner.teardown({ runId });
    await destroySandbox(sandbox.sandboxBasePath);
    process.removeListener('SIGINT', ignoreSignal);
    process.removeListener('SIGTERM', ignoreSignal);
    consola.log('[debug] Cleanup complete.');
  }
}

/**
 * Resolves the directory `createSandbox` rsyncs FROM.
 *
 * - **Start:** the main project directory (`opts.projectDir`).
 * - **Resume:** the worktree with recreated state (`.saifac/worktrees/resume-<runId>`),
 *   i.e. `opts.resume.sandboxSourceDir`.
 */
export function getSandboxSourceDir(opts: {
  projectDir: string;
  resume: { sandboxSourceDir: string } | null;
}): string {
  return opts.resume?.sandboxSourceDir ?? opts.projectDir;
}
