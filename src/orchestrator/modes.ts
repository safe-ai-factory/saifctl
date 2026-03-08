/**
 * Four orchestration modes for the Software Factory.
 *
 *  1. fail2pass  — Verify at least one feature test fails on current codebase (sanity check; partial overlap OK)
 *  2. start      — Create a fresh sandbox and run the iterative agent loop
 *  3. continue   — Resume an existing sandbox (skip rsync) and continue the loop
 *  4. assess     — Apply a candidate patch to a fresh sandbox and run mutual verification
 */

import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GitProvider } from '../git/types.js';
import { type ModelOverrides } from '../llm-config.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/index.js';
import type { TestProfile } from '../test-profiles/types.js';
import { CleanupRegistry, removeImageByTag, removeNetwork } from '../utils/docker.js';
import { createSandboxNetwork } from './docker/network.js';
import { debugStagingContainer, getStagingImageTag } from './docker/staging.js';
import { hasFeatureTestFailures, runAssessmentWithContainers } from './docker/test-runner.js';
import {
  applyPatchToHost,
  extractRunId,
  getTestRunnerOpts,
  loadCatalog,
  runIterativeLoop,
  runResultsJudgeForFailure,
} from './loop.js';
import {
  applyPatch,
  createSandbox,
  destroySandbox,
  type PatchExcludeRule,
  type SandboxPaths,
} from './sandbox.js';

/** Writes (or overwrites) gate.sh at the given path with the provided content. */
function writeGateScript(gatePath: string, gateScript: string): void {
  writeFileSync(gatePath, gateScript, 'utf8');
  chmodSync(gatePath, 0o755);
}

export interface OrchestratorOpts {
  changeName: string;
  /** Absolute path to the project directory */
  projectDir: string;
  /**
   * How many times to re-run the full test suite on a single assessment before
   * declaring it failed. Useful for flaky test environments.
   * Applies to modes 'fail2pass', 'start', 'continue', and 'assess'.
   * Default: 1 (run once; no retry).
   */
  assessRetries: number;
  /**
   * When true, the sandbox directory is preserved after a max-attempt failure
   * so the user can resume with mode='continue'.
   */
  keepSandbox: boolean;
  /**
   * Required for mode='continue': path to an existing sandbox created by a
   * previous 'start' run (e.g. /tmp/factory-sandbox/my-feat-abc1234).
   */
  sandboxPath: string | null;
  /**
   * Required for mode='assess': path to a patch file to apply before assessment.
   * (e.g. /path/to/patch.diff)
   */
  patchPath: string | null;
  /**
   * Additional file sections to strip from the extracted patch before it is
   * applied to the host repo. The openspecDir/ glob is always prepended
   * automatically — passing rules here adds to that, not replaces it.
   */
  patchExclude?: PatchExcludeRule[];
  /**
   * CLI-level LLM overrides (--model, --agent-model, --base-url, --agent-base-url).
   *
   * The orchestrator uses this to resolve the coder agent's model config via
   * `resolveAgentLlmConfig('coder', 'coder', overrides)` and to pass overrides
   * through to Mastra agents (results-judge, pr-summarizer, tests pipeline).
   *
   * When omitted, all agents fall back to env-var tier overrides then auto-discovery.
   */
  overrides: ModelOverrides;
  /**
   * Test Docker image tag (default: 'factory-test-<profileId>:latest').
   *
   * Override via --test-image CLI flag.
   */
  testImage: string;
  /**
   * Controls how the Results Judge handles assessment failures.
   *
   * - `'off'`    — Results Judge is disabled; the loop uses the generic feedback message (default).
   * - `'prompt'` — On ambiguous spec detection, pause and ask the human to confirm/edit the
   *               clarification before regenerating tests and continuing.
   * - `'auto'`   — Fully autonomous: automatically append the Results Judge's proposed clarification
   *               to specification.md and regenerate runner.spec.ts without human input.
   *
   * In both `'prompt'` and `'auto'` modes the Results Judge also produces a sanitized behavioral
   * hint for genuine failures, giving the agent better feedback without leaking holdout tests.
   */
  resolveAmbiguity: 'off' | 'prompt' | 'auto';
  /**
   * Openspec directory name relative to repo root (e.g. 'openspec').
   * Resolved by caller (e.g. agents CLI parseOpenspecDir).
   */
  openspecDir: string;
  /**
   * Project name prefix for sandbox directory names (e.g. 'crawlee-one').
   * Resolved by caller (e.g. agents CLI parseProjectName from -p/--project or package.json).
   */
  projectName: string;
  /**
   * Base directory where sandbox entries are created.
   */
  sandboxBaseDir: string;
  /**
   * When true, skip Leash and run OpenHands directly on the host.
   * Isolation is filesystem-only (rsync sandbox). No Cedar enforcement.
   * Default: false (Leash is enabled by default).
   */
  dangerousDebug: boolean;
  /**
   * Absolute path to a Cedar policy file for Leash.
   *
   * Defaults to leash-policy.cedar in src/orchestrator/.
   * Ignored when dangerousDebug=true.
   */
  cedarPolicyPath: string;
  /**
   * Sandbox profile id (e.g. 'node-pnpm-python'). Used to resolve Dockerfile.stage for the
   * staging container when tests.json does not specify build.dockerfile.
   */
  sandboxProfileId: SupportedSandboxProfileId;
  /**
   * Docker image for the coder container.
   * Resolved from the sandbox profile (default: node-pnpm-python). Override via --coder-image.
   * Ignored when dangerousDebug=true.
   */
  coderImage: string;
  /**
   * Remote target to push the feature branch to after a successful assessment.
   * Accepts a Git URL (https://github.com/owner/repo.git), a GitHub slug (owner/repo),
   * or a configured remote name (e.g. 'origin').
   * When omitted, the branch is created locally but not pushed.
   * A GITHUB_TOKEN env var is required when pushing via HTTPS to github.com.
   */
  push: string | null;
  /**
   * When true, open a Pull Request after pushing the feature branch.
   * Requires `push` to be set and the appropriate provider token env var.
   */
  pr: boolean;
  /**
   * Git hosting provider to use for push URL resolution and PR creation.
   *
   * The required auth token is read from the corresponding env var (e.g. GITHUB_TOKEN).
   */
  gitProvider: GitProvider;
  /**
   * Content of the gate script to run after each OpenHands round. In leash mode the script is
   * written to sandboxBasePath/gate.sh and mounted read-only at /factory/gate.sh inside the
   * container. In --dangerous-debug mode it runs directly on the host via bash.
   *
   * It must exit 0 to pass; non-zero causes the inner loop to retry with the output as feedback.
   *
   * Resolved by the CLI: defaults to the gate.sh from the resolved sandbox profile when --gate-script is not set.
   */
  gateScript: string;
  /**
   * Test profile to use for the test runner.
   *
   * Resolved by the CLI: defaults to DEFAULT_TEST_PROFILE (vitest) when --test-profile is not set.
   */
  testProfile: TestProfile;
  /**
   * Content of the test script to write into the sandbox and bind-mount at
   * /usr/local/bin/test.sh inside the Test Runner container (read-only).
   *
   * Always set — defaults to DEFAULT_TEST_SCRIPT (test-default.sh) when --test-script is not
   * provided. Override via --test-script CLI flag (accepts a file path; content is read by CLI).
   */
  testScript: string;
  /**
   * Content of the startup script to run once before the agent loop begins.
   * Written to sandboxBasePath/startup.sh and mounted read-only at /factory/startup.sh
   * inside the coder container (or run directly on the host in --dangerous-debug mode).
   *
   * Use for workspace setup that requires the workspace to be mounted first:
   * pnpm install, pip install -r requirements.txt, cargo fetch, etc.
   *
   * Resolved by the CLI: set via --profile or --startup-script. When neither is
   * provided, the profile's installation script is used.
   */
  startupScript: string;
  /** Max OpenHands iterations before giving up. Default: 10 */
  maxAttempts: number;
  /**
   * Maximum number of inner loop rounds (agent → gate → feedback) per single outer attempt.
   * Forwarded as FACTORY_INNER_ROUNDS to coder-start.sh.
   *
   * Resolved by the CLI: defaults to 5 when --inner-rounds is not set.
   */
  innerRounds: number;
  /**
   * Content of the agent setup script to write into the sandbox as `agent-start.sh`.
   * Mounted read-only at `/factory/agent-start.sh` inside the coder container and executed
   * once by `coder-start.sh` after the startup script, before the agent loop begins.
   *
   * Use to install the coding agent at runtime (e.g. `pipx install aider-chat`).
   *
   * Resolved by the CLI: defaults to the agent profile's agent-start.sh.
   */
  agentStartScript: string;
  /**
   * Content of the agent script to write into the sandbox as `agent.sh`.
   * Mounted read-only at `/factory/agent.sh` inside the coder container and invoked
   * by `coder-start.sh` once per inner round. The script must read the task from
   * `$FACTORY_TASK_PATH`.
   *
   * Resolved by the CLI: defaults to the agent profile's agent.sh (OpenHands) when
   * --agent and --agent-script are not set.
   */
  agentScript: string;
  /**
   * Content of the staging script mounted read-only in the staging container at /factory/stage.sh.
   * Invoked by staging-start.sh after the installation script and the sidecar have run.
   *
   * Resolved by the CLI: set via --profile or --stage-script. When neither is provided,
   * the profile's stage script is used.
   */
  stageScript: string;
  /**
   * Extra environment variables to forward into the agent container (Leash mode)
   * or inject into the host process env (--dangerous-debug mode).
   *
   * Parsed from --env KEY=VALUE flags and --env-file <path> by the CLI.
   * Reserved factory variables (FACTORY_*, WORKSPACE_BASE, LLM_API_KEY, LLM_MODEL,
   * LLM_PROVIDER, LLM_BASE_URL) are silently filtered out by the runner to prevent
   * accidental override.
   */
  agentEnv: Record<string, string>;
  /**
   * Controls how agent stdout is parsed and displayed.
   *
   * - `'openhands'` (default) — parse OpenHands --json event stream; pretty-print
   *   action events, thought blocks, and errors.
   * - `'raw'` — stream lines as-is with an `[agent]` prefix; suitable for any
   *   agent CLI that does not emit OpenHands-style JSON events.
   */
  agentLogFormat: 'openhands' | 'raw';
}

export interface OrchestratorResult {
  success: boolean;
  attempts: number;
  /** Path to the sandbox (preserved when keepSandbox=true and !success) */
  sandboxPath?: string;
  /** Path to the winning patch.diff if success=true */
  patchPath?: string;
  message: string;
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

    const onSignal = (sig: string) => {
      if (isCleaningUp) return;
      isCleaningUp = true;

      console.log(`\n[orchestrator] ${sig} received — cleaning up...`);

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
          console.warn('[orchestrator] Cleanup error:', err);
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
export const runContinue = withCleanupRegistry(runContinueCore);
export const runAssess = withCleanupRegistry(runAssessCore);

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
  | 'changeName'
  | 'projectDir'
  | 'openspecDir'
  | 'projectName'
  | 'sandboxBaseDir'
  | 'testImage'
  | 'startupScript'
  | 'gateScript'
  | 'agentStartScript'
  | 'agentScript'
  | 'stageScript'
  | 'testScript'
>;

async function runFail2PassCore(
  opts: Fail2PassOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    testImage,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    testScript,
  } = opts;

  console.log(`\n[orchestrator] MODE: fail2pass — ${changeName}`);

  const sandbox = createSandbox({
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  });
  const catalog = loadCatalog({ projectDir, changeName, openspecDir });
  const testRunnerOpts = getTestRunnerOpts({
    projectDir,
    changeName,
    openspecDir,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  try {
    const runId = extractRunId(sandbox.sandboxBasePath);
    const result = await runAssessmentWithContainers({
      sandboxProfileId,
      codePath: sandbox.codePath,
      projectDir,
      changeName,
      projectName,
      catalog,
      testRunnerOpts,
      registry,
      testImage,
      runId,
      startupPath: sandbox.startupPath,
      stagePath: sandbox.stagePath,
      reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
    });

    if (result.runnerError) {
      throw new Error(
        `Test runner error (not a test failure): ${result.runnerError}\n` +
          `Check that runner.spec.ts and tests.json are present and valid.\n` +
          `Stderr:\n${result.stderr}`,
      );
    }

    if (hasFeatureTestFailures(result)) {
      console.log(
        '\n[orchestrator] ✓ FAIL2PASS CONFIRMED — feature tests correctly fail on current codebase',
      );
      return {
        success: true,
        attempts: 1,
        message: 'Tests correctly fail on current codebase. Ready to start the iterative loop.',
      };
    } else {
      console.error(
        '\n[orchestrator] ✗ FAIL2PASS REJECTED — no feature tests failed on current codebase',
      );
      console.error('Either the feature already exists or the tests are invalid.');
      return {
        success: false,
        attempts: 1,
        message:
          'No feature tests failed on current codebase — feature may already be implemented or tests are invalid.',
      };
    }
  } finally {
    destroySandbox(sandbox.sandboxBasePath);
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
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
  } = opts;

  console.log(`\n[orchestrator] MODE: start — ${changeName}`);

  const sandbox = createSandbox({
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
  });
  return runIterativeLoop(sandbox, { ...opts, openspecDir, registry });
}

// ---------------------------------------------------------------------------
// Mode 3: continue
// ---------------------------------------------------------------------------

/**
 * Resumes an existing sandbox (created by a previous 'start' run that hit maxAttempts).
 * Skips rsync and git init — uses the preserved sandbox as-is.
 */
async function runContinueCore(
  opts: OrchestratorOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    changeName,
    sandboxPath,
    openspecDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
  } = opts;

  if (!sandboxPath) {
    throw new Error(
      "mode='continue' requires --sandbox-path pointing to an existing sandbox directory.",
    );
  }

  if (!existsSync(sandboxPath)) {
    throw new Error(`Sandbox not found at ${sandboxPath}`);
  }

  console.log(`\n[orchestrator] MODE: continue — ${changeName}`);
  console.log(`[orchestrator] Resuming sandbox: ${sandboxPath}`);

  const codePath = join(sandboxPath, 'code');
  const gatePath = join(sandboxPath, 'gate.sh');
  const startupPath = join(sandboxPath, 'startup.sh');
  const agentStartPath = join(sandboxPath, 'agent-start.sh');
  const agentPath = join(sandboxPath, 'agent.sh');
  const stagePath = join(sandboxPath, 'stage.sh');

  if (!existsSync(codePath)) {
    throw new Error(`Expected 'code' directory not found inside sandbox: ${codePath}`);
  }

  // Re-write gate.sh so the user can supply a different gate script when resuming.
  writeGateScript(gatePath, gateScript);

  // Re-write startup.sh on resume so the user can change it between runs.
  writeFileSync(startupPath, startupScript, 'utf8');
  chmodSync(startupPath, 0o755);

  // Re-write agent-start.sh on resume so the user can change the agent setup between runs.
  writeFileSync(agentStartPath, agentStartScript, 'utf8');
  chmodSync(agentStartPath, 0o755);

  // Re-write agent.sh on resume so the user can change the agent between runs.
  writeFileSync(agentPath, agentScript, 'utf8');
  chmodSync(agentPath, 0o755);

  // Re-write stage.sh on resume so the user can change the staging script between runs.
  writeFileSync(stagePath, stageScript, 'utf8');
  chmodSync(stagePath, 0o755);

  const sandbox: SandboxPaths = {
    sandboxBasePath: sandboxPath,
    codePath,
    gatePath,
    startupPath,
    agentStartPath,
    agentPath,
    stagePath,
  };

  return runIterativeLoop(sandbox, { ...opts, openspecDir, registry });
}

// ---------------------------------------------------------------------------
// Mode 4: assess
// ---------------------------------------------------------------------------

type AssessOpts = Pick<
  OrchestratorOpts,
  | 'sandboxProfileId'
  | 'changeName'
  | 'projectDir'
  | 'patchPath'
  | 'assessRetries'
  | 'openspecDir'
  | 'projectName'
  | 'sandboxBaseDir'
  | 'testImage'
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
>;

/**
 * Applies a candidate patch to a fresh sandbox and runs Mutual Verification.
 * If tests fail, retries up to assessRetries (useful for flaky environments).
 * If tests pass, applies the patch to the host repo and opens a PR.
 */
async function runAssessCore(
  opts: AssessOpts,
  registry: CleanupRegistry,
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    changeName,
    projectDir,
    patchPath,
    assessRetries,
    openspecDir,
    projectName,
    sandboxBaseDir,
    testImage,
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
  } = opts;

  if (!patchPath) {
    throw new Error("mode='assess' requires --patch pointing to a patch file.");
  }
  if (!existsSync(patchPath)) {
    throw new Error(`Patch file not found: ${patchPath}`);
  }

  console.log(`\n[orchestrator] MODE: assess — ${changeName}`);
  console.log(`[orchestrator] Patch: ${patchPath}`);

  const sandbox = createSandbox({
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  });
  const catalog = loadCatalog({ projectDir, changeName, openspecDir });
  const testRunnerOpts = getTestRunnerOpts({
    projectDir,
    changeName,
    openspecDir,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  // Apply the candidate patch
  applyPatch(sandbox.codePath, patchPath);

  let lastStderr = '';
  let attempts = 0;

  try {
    while (attempts < assessRetries) {
      attempts++;
      console.log(`\n[orchestrator] Assessment attempt ${attempts}/${assessRetries}`);

      const runId = `${extractRunId(sandbox.sandboxBasePath)}-a${attempts}`;

      const result = await runAssessmentWithContainers({
        sandboxProfileId,
        codePath: sandbox.codePath,
        projectDir,
        changeName,
        projectName,
        catalog,
        testRunnerOpts,
        registry,
        testImage,
        runId,
        startupPath: sandbox.startupPath,
        stagePath: sandbox.stagePath,
        reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
      });
      lastStderr = result.stderr;

      if (result.runnerError) {
        throw new Error(
          `Test runner error on attempt ${attempts}: ${result.runnerError}\n` +
            `Check that runner.spec.ts and tests.json are present and valid.\n` +
            `Stderr:\n${result.stderr}`,
        );
      }

      if (result.passed) {
        console.log('\n[orchestrator] ✓ ASSESSMENT PASSED');
        await applyPatchToHost({
          codePath: sandbox.codePath,
          projectDir,
          changeName,
          runId,
          push,
          pr,
          gitProvider,
          openspecDir,
          overrides,
        });
        return {
          success: true,
          attempts,
          patchPath,
          message: `Patch verified and applied to host repository after ${attempts} attempt(s).`,
        };
      }

      console.log(`\n[orchestrator] Assessment attempt ${attempts} FAILED`);

      if (resolveAmbiguity !== 'off' && result.testSuites) {
        const resultsJudgeResult = await runResultsJudgeForFailure({
          projectDir,
          changeName,
          openspecDir,
          patchPath,
          testSuites: result.testSuites,
          resolveAmbiguity,
          testProfile,
          projectName,
          overrides,
        });

        if (resultsJudgeResult.ambiguityResolved) {
          // Spec updated and tests regenerated — retry the same patch against the new tests.
          // Don't count this attempt against assessRetries since the spec was at fault.
          console.log(
            '[orchestrator] Spec ambiguity resolved — retrying assessment with updated tests.',
          );
          attempts--;
        }
      }
    }

    return {
      success: false,
      attempts,
      sandboxPath: sandbox.sandboxBasePath,
      message: `Assessment failed after ${assessRetries} attempt(s). Last stderr:\n${lastStderr}`,
    };
  } finally {
    destroySandbox(sandbox.sandboxBasePath);
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
    | 'changeName'
    | 'projectDir'
    | 'openspecDir'
    | 'projectName'
    | 'sandboxBaseDir'
    | 'startupScript'
    | 'gateScript'
    | 'agentStartScript'
    | 'agentScript'
    | 'stageScript'
  >,
): Promise<void> {
  const {
    sandboxProfileId,
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  } = opts;

  console.log(`\n[orchestrator] DEBUG MODE — ${changeName}`);

  const sandbox = createSandbox({
    changeName,
    projectDir,
    openspecDir,
    projectName,
    sandboxBaseDir,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
  });
  const catalog = loadCatalog({ projectDir, changeName, openspecDir });
  const runId = extractRunId(sandbox.sandboxBasePath);

  const net = await createSandboxNetwork({ projectName, changeName, runId });

  // pnpm forwards SIGTERM immediately after Ctrl+C. Ignore both signals while
  // the finally block is running so Docker API calls aren't cut short.
  const ignoreSignal = () => {};
  process.on('SIGINT', ignoreSignal);
  process.on('SIGTERM', ignoreSignal);

  try {
    await debugStagingContainer({
      sandboxProfileId,
      codePath: sandbox.codePath,
      projectDir,
      changeName,
      projectName,
      catalog,
      networkName: net.networkName,
      startupPath: sandbox.startupPath,
      stagePath: sandbox.stagePath,
      runId,
    });
  } finally {
    await removeNetwork(net.networkName);
    const stagingImageTagD = getStagingImageTag(catalog, { projectName, changeName, runId });
    if (stagingImageTagD) {
      console.log(`[debug] Removing staging image: ${stagingImageTagD}`);
      await removeImageByTag({ imageTag: stagingImageTagD, missingOk: true });
    }
    destroySandbox(sandbox.sandboxBasePath);
    process.removeListener('SIGINT', ignoreSignal);
    process.removeListener('SIGTERM', ignoreSignal);
    console.log('[debug] Cleanup complete.');
  }
}
