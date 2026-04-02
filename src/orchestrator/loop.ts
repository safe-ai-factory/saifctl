/**
 * Iterative agent loop and related utilities.
 * Used by mode 'start' (and 'fromArtifact' via runStartCore).
 */

import { join } from 'node:path';

import { isCancel, text } from '@clack/prompts';

import { resolveAgentProfile } from '../agent-profiles/index.js';
import type { SupportedAgentProfileId } from '../agent-profiles/types.js';
import type {
  NormalizedCodingEnvironment,
  NormalizedStagingEnvironment,
} from '../config/schema.js';
import { runDesignTests } from '../design-tests/design.js';
import { TestCatalogSchema } from '../design-tests/schema.js';
import { generateTests } from '../design-tests/write.js';
import { createEngine } from '../engines/index.js';
import { defaultEngineLog } from '../engines/logs.js';
import {
  type AssertionSuiteResult,
  type LiveInfra,
  type RunAgentOpts,
  type RunTestsOpts,
  type TestsResult,
} from '../engines/types.js';
import { parseJUnitXmlString } from '../engines/utils/test-parser.js';
import type { GitProvider } from '../git/types.js';
import { type LlmOverrides } from '../llm-config.js';
import { consola } from '../logger.js';
import {
  activeOnceRuleIds,
  markOnceRulesConsumed,
  reconcileRunRulesWithStorage,
  rulesForPrompt,
} from '../runs/rules.js';
import {
  type OuterAttemptSummary,
  type RunCommit,
  type RunControlSignal,
  type RunLiveInfra,
  type RunRule,
  type RunStatus,
  StaleArtifactError,
} from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import type { TestProfile } from '../test-profiles/types.js';
import type { CleanupRegistry } from '../utils/cleanup.js';
import { git, gitClean, gitResetHard } from '../utils/git.js';
import { appendUtf8, pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { runVagueSpecsChecker } from './agents/vague-specs-check.js';
import type { OrchestratorOpts } from './modes.js';
import { applyPatchToHost } from './phases/apply-patch.js';
import { runCodingPhase } from './phases/run-coding-phase.js';
import {
  destroySandbox,
  extractIncrementalRoundPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  type Sandbox,
} from './sandbox.js';
import { buildOuterAttemptSummary } from './stats.js';

/**
 * Builds `extractPatch` exclude rules: fixed guardrails plus optional caller rules.
 *
 * Always excludes:
 * - `{saifctlDir}/**` — reward-hacking prevention (agent must not modify its own test specs).
 * - `.git/hooks/**` — prevents a malicious patch from installing hooks that execute on the host
 *   when the orchestrator runs `git commit` in applyPatchToHost.
 * - `.saifctl/**` — factory-internal workspace state (e.g. per-round task file), not product code.
 */
export function buildPatchExcludeRules(
  saifctlDir: string,
  patchExclude?: PatchExcludeRule[],
): PatchExcludeRule[] {
  return [
    { type: 'glob', pattern: `${saifctlDir}/**` },
    { type: 'glob', pattern: '.git/hooks/**' },
    { type: 'glob', pattern: '.saifctl/**' },
    ...(patchExclude ?? []),
  ];
}

/**
 * True when the disposable sandbox git repo has any commit after its initial import commit
 * (`rev-list --max-parents=0`).
 *
 * The sandbox doesn't inherit host's git history, instead we do a fresh git init + "Base state".
 * So any new commits beyond the first one are changes made by the agent.
 */
export async function sandboxHasCommitsBeyondInitialImport(codePath: string): Promise<boolean> {
  try {
    const rootsRaw = (
      await git({ cwd: codePath, args: ['rev-list', '--max-parents=0', 'HEAD'] })
    ).trim();
    const root = rootsRaw
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    if (!root) return false;
    const countStr = (
      await git({ cwd: codePath, args: ['rev-list', '--count', `${root}..HEAD`] })
    ).trim();
    const n = Number.parseInt(countStr, 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared: Iterative Loop (used by 'start' and 'continue')
// ---------------------------------------------------------------------------

/**
 * Options used by runIterativeLoop (modes 'start' and 'fromArtifact').
 */
export interface IterativeLoopOpts {
  /** Sandbox profile id (e.g. 'node-pnpm-python'). Used to resolve Dockerfile.coder for the staging container when tests.json does not specify build.dockerfile. */
  sandboxProfileId: SupportedSandboxProfileId;
  /**
   * Coding agent profile id (e.g. 'openhands', 'debug'). Persisted in run artifacts for accurate
   * from-artifact/info; scripts are resolved from this profile unless overridden via --agent-script.
   */
  agentProfileId: SupportedAgentProfileId;
  /** Resolved feature (name, absolutePath, relativePath). */
  feature: Feature;
  /** Absolute path to the project directory */
  projectDir: string;
  /** Max full pipeline runs before giving up. Default: 5 */
  maxRuns: number;
  /**
   * Effective LLM config (--model, --base-url) after config → artifact → CLI merge.
   *
   * The orchestrator uses this to resolve the coder agent's model via
   * `resolveAgentLlmConfig('coder', llm)` and passes it through to Mastra agents
   * (vague-specs-check, pr-summarizer, tests pipeline).
   *
   * When empty, agents fall back to env-var tier defaults then auto-discovery.
   */
  llm: LlmOverrides;
  /**
   * Saifctl directory name relative to repo root (e.g. 'saifctl').
   * Resolved by caller (e.g. readSaifctlDirFromCli + resolveSaifctlDirRelative).
   */
  saifctlDir: string;
  /**
   * Project name prefix for sandbox directory names (e.g. 'crawlee-one').
   * Resolved by caller (e.g. resolveProjectName from -p/--project or package.json).
   */
  projectName: string;
  /**
   * Test Docker image tag (default: 'saifctl-test-<profileId>:latest').
   *
   * Override via --test-image CLI flag.
   */
  testImage: string;
  /**
   * Decides action when tests fail due to ambiguous specs:
   * - `'off'`    — No action, failing tests are NOT analysed for ambiguity.
   * - `'prompt'` — Runs ambiguity analysis. If ambiguous, pause and ask the human to confirm/edit the clarification before regenerating tests and continuing.
   * - `'ai'`     — Runs ambiguity analysis. If ambiguous, automatically append AI agent's proposed clarification to specification.md and regenerate runner.spec.ts without human input.
   */
  resolveAmbiguity: 'off' | 'prompt' | 'ai';
  /**
   * When true, skip Leash and run the coder container with `docker run` instead of the Leash CLI.
   * Uses the same image, bind mounts, env vars, and container name as Leash (`leash-target-…`),
   * but no Cedar policy or Leash network proxy — useful to isolate Leash-related failures.
   */
  dangerousNoLeash: boolean;
  /**
   * Absolute path to the Cedar policy file used to load {@link cedarScript} and for artifact / `--cedar` replay.
   * Leash receives the copy under the sandbox (`<saifctlPath>/policy.cedar`), not this path directly.
   *
   * Defaults to default.cedar in src/orchestrator/policies/.
   * Ignored when dangerousNoLeash=true or with `--engine local`.
   */
  cedarPolicyPath: string;
  /**
   * Cedar policy text persisted on the Run and written next to sandbox scripts as `policy.cedar`.
   * Matches the file at {@link cedarPolicyPath} when resolved from disk.
   */
  cedarScript: string;
  /**
   * Docker image for the coder container.
   * Resolved from the sandbox profile (default: node-pnpm-python). Override via --coder-image.
   * Ignored when the coding engine is local (no container).
   */
  coderImage: string;
  /**
   * Remote target to push the feature branch to after all tests pass.
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
   * When set, use this branch name when tests have passed and we're applying the patch
   * agent's changes to the user's project.
   *
   * Same as `--branch` on feat run / run start / run test.
   */
  targetBranch: string | null;
  /**
   * Git hosting provider to use for push URL resolution and PR creation.
   *
   * The required auth token is read from the corresponding env var (e.g. GITHUB_TOKEN).
   */
  gitProvider: GitProvider;
  /**
   * Maximum number of gate retries (agent → gate → feedback) per run.
   * Forwarded as SAIFCTL_GATE_RETRIES to coder-start.sh.
   *
   * Resolved by the CLI: defaults to 10 when --gate-retries is not set.
   */
  gateRetries: number;
  /**
   * Extra environment variables to forward into the agent container (Leash / docker run)
   *
   * Parsed from --agent-env KEY=VALUE flags and --agent-env-file <path> by the CLI.
   * Reserved factory variables (SAIFCTL_*, LLM_*, REVIEWER_LLM_*) are stripped in
   * {@link buildCoderContainerEnv} when building the process env (this map may still list them for logging).
   */
  agentEnv: Record<string, string>;
  /**
   * Host env var **names** whose values are copied from `process.env` into the coder container's
   * secret env (not logged as values). From `config.defaults.agentSecretKeys` and `--agent-secret`.
   * Persisted in run artifacts as names only; values are re-read from the host when starting from a Run.
   */
  agentSecretKeys: string[];
  /**
   * Project-relative paths to `.env`-style files with `KEY=value` secret pairs — same format as
   * `--agent-env-file`. Persisted in run artifacts; when starting from a Run the files are read again (values are
   * not stored in the artifact).
   */
  agentSecretFiles: string[];
  /**
   * Content of the test script to write into the sandbox and bind-mount at
   * /usr/local/bin/test.sh inside the Test Runner container (read-only).
   *
   * Always set — defaults to DEFAULT_TEST_SCRIPT (test-default.sh) when --test-script is not
   * provided. Override via --test-script CLI flag (accepts a file path; content is read by CLI).
   */
  testScript: string;
  /**
   * Test profile to use for the test runner.
   *
   * Resolved by the CLI: defaults to DEFAULT_TEST_PROFILE (vitest) when --test-profile is not set.
   */
  testProfile: TestProfile;
  /**
   * How many times to re-run the full test suite on failed tests. Useful for flaky test environments.
   * Applies to modes 'fail2pass', 'start', 'fromArtifact', and 'test'.
   * Default: 1 (run once; no retries).
   */
  testRetries: number;
  /**
   * Additional file sections to strip from the extracted patch before it is
   * applied to the host repo. The saifctlDir/ glob is always prepended
   * automatically — passing rules here adds to that, not replaces it.
   */
  patchExclude?: PatchExcludeRule[];
  /**
   * When true, run the semantic AI reviewer (Argus) after static checks pass.
   * Requires the Argus binary. Disable with --no-reviewer.
   * Default: true.
   */
  reviewerEnabled: boolean;
  /**
   * When true, copy untracked and uncommitted files into the sandbox (rsync). When false (default),
   * only the committed tree at `HEAD` is copied (`git archive`).
   */
  includeDirty: boolean;
  /**
   * Normalized staging environment — always present (defaults to `{ engine: 'docker' }` when
   * `environments.staging` is absent in config). Contains `app` (with DEFAULT_STAGING_APP
   * defaults) and `appEnvironment` (defaults to `{}`). Used to configure the staging container
   * and to instantiate the engine.
   */
  stagingEnvironment: NormalizedStagingEnvironment;
  /**
   * Normalized coding environment — always present (defaults to `{ engine: 'docker' }` when
   * `environments.coding` is absent in config).
   *
   * When a docker-compose `file` is provided, the orchestrator starts the declared Compose stack
   * before each agent run and attaches the Leash container to the same Docker network so the agen
   * can reach services (e.g. databases, mock APIs) by their service-name hostnames.
   * The stack is torn down cleanly after each agent run regardless of outcome.
   */
  codingEnvironment: NormalizedCodingEnvironment;
  /**
   * When true, verbose logs are enabled.
   */
  verbose?: boolean;
  /**
   * When starting from a Run, seed {@link RunArtifact#runCommits} (replayed in sandbox before the loop).
   */
  seedRunCommits?: RunCommit[];
  /**
   * When starting from a Run, seed {@link RunArtifact#roundSummaries} so new outer attempts append after prior history.
   */
  seedRoundSummaries?: OuterAttemptSummary[];
  /**
   * When true, skip the coding agent and run only staging + tests (+ optional apply to host on pass).
   * Used by `saifctl run test` (Run re-verification).
   */
  testOnly?: boolean;
  /**
   * Internal: set by `runInspect` to run an idle container (`sleep infinity`) instead of the
   * coding agent. Threaded through to {@link RunAgentOpts#inspectMode}.
   */
  inspectMode?: RunAgentOpts['inspectMode'];
}

/** Outcome of {@link runIterativeLoop} and other orchestrator entry points (distinct from stored {@link RunArtifact} status). */
export type OrchestratorOutcomeStatus = 'success' | 'failed' | 'paused' | 'stopped';

export interface OrchestratorResult {
  status: OrchestratorOutcomeStatus;
  attempts: number;
  /** Run ID for starting again when run storage is enabled (artifact under .saifctl/runs/) */
  runId?: string;
  /** Path to the winning patch.diff when {@link OrchestratorResult#status} is `success`. */
  patchPath?: string;
  message: string;
}

/** Result of the inner test-retry + vague-specs loop (shared by agent loop and test-only mode). */
export type StagingTestVerificationResult =
  | { kind: 'passed'; lastRunId: string }
  | { kind: 'aborted' }
  | {
      kind: 'exhausted';
      /** Present when resolveAmbiguity ran on a failed attempt */
      lastVagueSpecsCheckResult?: { ambiguityResolved: boolean; sanitizedHint: string };
      testAttempts: number;
    };

/**
 * Runs staging + tests with {@link OrchestratorOpts#testRetries} and optional vague-specs handling.
 * Does not apply the patch to the host — caller does that on `kind: 'passed'`.
 */
export async function runStagingTestVerification(params: {
  sandbox: Sandbox;
  orchestratorOpts: OrchestratorOpts;
  registry: CleanupRegistry | null;
  testRunnerOpts: Awaited<ReturnType<typeof prepareTestRunnerOpts>>;
  /** Outer loop attempt index (1-based), used in test run IDs. */
  outerAttempt: number;
  /**
   * Called immediately after the staging engine is set up and the first {@link LiveInfra}
   * snapshot is available. Allows the caller to persist the live resource list before
   * `startStaging` / `runTests` runs, so a crash mid-test still has an accurate record.
   */
  onStagingInfraReady?: (infra: LiveInfra) => Promise<void>;
  /**
   * Called after staging teardown completes so the caller can clear the persisted
   * staging infra (resources are gone). Only called when {@link onStagingInfraReady} is set.
   */
  onStagingTeardownComplete?: () => Promise<void>;
}): Promise<StagingTestVerificationResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    projectName,
    testImage,
    resolveAmbiguity,
    testProfile,
    llm,
    testRetries,
    stagingEnvironment,
  } = params.orchestratorOpts;
  const {
    sandbox,
    registry,
    testRunnerOpts,
    outerAttempt,
    onStagingInfraReady,
    onStagingTeardownComplete,
  } = params;

  let testAttempts = 0;
  let lastRunId = '';
  let lastVagueSpecsCheckResult:
    | Awaited<ReturnType<typeof runVagueSpecsCheckerForFailure>>
    | undefined;

  while (testAttempts < testRetries) {
    testAttempts++;
    lastRunId = `${sandbox.runId}-${outerAttempt}-${testAttempts}`;
    consola.log(
      `\n[orchestrator] Test attempt ${testAttempts}/${testRetries} (outer attempt ${outerAttempt})`,
    );

    const stagingEngine = createEngine(stagingEnvironment);

    // Track latest live infra for this engine: SIGINT cleanup and teardown() need
    // the same snapshot. Each operation like Engine.setup() may mutate the live infra shape.
    let stagingInfraRef: LiveInfra | null = null;

    // Register before setup so an early signal still sees infra once setup()
    // has assigned stagingInfraRef.
    registry?.registerEngine({
      engine: stagingEngine,
      runId: lastRunId,
      label: lastRunId,
      projectDir,
      getInfra: () => stagingInfraRef,
    });

    // Provision staging engine network (and optional compose) for this test attempt.
    const { infra: stAfterSetup } = await stagingEngine.setup({
      runId: lastRunId,
      projectName,
      featureName: feature.name,
      projectDir,
    });
    stagingInfraRef = stAfterSetup;
    if (onStagingInfraReady) {
      await onStagingInfraReady(stAfterSetup);
    }

    const result: TestsResult = await (async (): Promise<TestsResult> => {
      try {
        // Bring up the staging profile (sidecar / app) against the sandbox workspace.
        const { stagingHandle, infra: stAfterStaging } = await stagingEngine.startStaging({
          runId: lastRunId,
          sandboxProfileId,
          codePath: sandbox.codePath,
          projectDir,
          stagingEnvironment,
          feature,
          projectName,
          saifctlPath: sandbox.saifctlPath,
          onLog: defaultEngineLog,
          infra: stAfterSetup,
        });
        stagingInfraRef = stAfterStaging;

        // Execute the feature test suite inside the staging environment.
        const { tests, infra: stAfterTests } = await stagingEngine.runTests({
          ...testRunnerOpts,
          stagingHandle,
          testImage,
          runId: lastRunId,
          feature,
          projectName,
          onLog: defaultEngineLog,
          infra: stAfterStaging,
        });
        stagingInfraRef = stAfterTests;
        return tests;
      } finally {
        // Deregister first; then teardown when we have an infra snapshot
        // (null ⇒ failed setup ⇒ teardown no-ops / warns).
        registry?.deregisterEngine(stagingEngine);
        await stagingEngine.teardown({
          runId: lastRunId,
          infra: stagingInfraRef,
          projectDir,
        });
        // Resources are gone — clear the persisted staging infra record.
        if (onStagingTeardownComplete) {
          await onStagingTeardownComplete();
        }
      }
    })();

    if (result.runnerError) {
      throw new Error(
        `Test runner error on attempt ${outerAttempt}: ${result.runnerError}\n` +
          `Check that runner.spec.ts and tests.json are present and valid.\n` +
          `Stderr:\n${result.stderr}`,
      );
    }

    if (result.status === 'passed') {
      return { kind: 'passed', lastRunId };
    }
    if (result.status === 'aborted') {
      return { kind: 'aborted' };
    }

    // Failure path - Check for spec ambiguity.
    //    If spec is ambiguous, the agent CANNOT faithfully completed the task
    //    to match the hidden tests.
    //    We use AI agent to determine if the spec is ambiguous:
    //    - yes, we ask the human (or AI) for clarification and update specs and tests.
    //    - no, we treat errors as genuine code errors and continue the loop.
    const testSuites = parseJUnitXmlString(result.rawJunitXml);
    if (resolveAmbiguity !== 'off' && testSuites) {
      const vagueResult = await runVagueSpecsCheckerForFailure({
        projectName,
        projectDir,
        feature,
        testSuites,
        resolveAmbiguity,
        testProfile,
        llm,
      });

      if (vagueResult.ambiguityResolved) {
        consola.log('[orchestrator] Spec ambiguity resolved — retrying tests with updated tests.');
        // Spec was updated and tests regenerated — retry tests with updated suite.
        // Don't count this attempt against testRetries since the spec was at fault.
        testAttempts--;
        continue;
      }
      lastVagueSpecsCheckResult = vagueResult;
    }
  }

  return {
    kind: 'exhausted',
    lastVagueSpecsCheckResult,
    testAttempts,
  };
}

export interface RunStorageContext {
  /** Part to re-create the base state of the feature branch - last commit SHA */
  baseCommitSha: string;
  /** Part to re-create the base state of the feature branch - unstaged + staged diff */
  basePatchDiff?: string;
  /** Mutable: set by loop for save-on-Ctrl+C */
  lastErrorFeedback?: string;
  /**
   * User rules for this run (from artifact when continuing; empty on fresh start).
   * Mutated when `once` rules are consumed after each coding round.
   */
  rules: RunRule[];
  /**
   * Holds the revision to use for the next optimistic locking write.
   * Undefined when that write was skipped or failed.
   */
  expectedArtifactRevision?: number;
}

export async function runIterativeLoop(
  sandbox: Sandbox,
  opts: OrchestratorOpts & {
    runContext: RunStorageContext | null;
    /** When starting from a Run: seed the first agent round with this feedback */
    initialErrorFeedback: string | null;
    registry: CleanupRegistry;
  },
): Promise<OrchestratorResult> {
  const {
    feature,
    projectDir,
    maxRuns,
    llm,
    saifctlDir,
    projectName,
    registry,
    dangerousNoLeash,
    coderImage,
    push,
    pr,
    targetBranch,
    gitProvider,
    gateRetries,
    agentEnv,
    agentProfileId,
    testScript,
    reviewerEnabled,
    codingEnvironment,
    runStorage,
    runContext,
    seedRunCommits,
    seedRoundSummaries,
    initialErrorFeedback,
    testOnly,
    verbose,
    agentSecretKeys,
    agentSecretFiles,
    fromArtifact,
    patchExclude: optsPatchExclude,
    inspectMode,
  } = opts;

  const runId = sandbox.runId;

  //////////////////////////////////////////////////
  // Globals
  //////////////////////////////////////////////////

  // TODO
  // TODO - NOT GREAT! All this 'global' makes it hard to reason about the code.
  //        It will be hard to decouple when moving to Hatchet workflow.
  //        We'll need to take every loop, every file write, each 'global' variable,
  //        and define Hatchet workflows around them
  // TODO

  /**
   * After `run resume`: coding infra from the paused artifact. Consumed on the first coding round
   * so we skip {@link Engine.setup} and preserve the existing Docker network / compose stack.
   */
  let resumedCodingInfra: LiveInfra | null = fromArtifact?.resumedCodingInfra ?? null;

  /** Accumulated run commits (seeded from Run + each successful coding round). */
  let runCommitsAccum: RunCommit[] = [...(seedRunCommits ?? [])];
  let lastErrorFeedback = '';
  let roundSummaries: OuterAttemptSummary[] = [...(seedRoundSummaries ?? [])];

  let errorFeedback = initialErrorFeedback ?? '';
  let attempts = 0;
  let sandboxDestroyed = false;

  let pauseSnapshotLiveInfra: RunLiveInfra | null = null;

  //////////////////////////////////////////////////
  // Helpers
  //////////////////////////////////////////////////

  // Strip loop-internal fields from opts once; the remainder is safe to persist.
  const { registry: _reg, runStorage: _rs, runContext: _rc, fromArtifact: _fa, ...loopOpts } = opts;

  /**
   * Builds and saves a {@link RunArtifact} to storage with optimistic-locking revision tracking.
   *
   * Handles the boilerplate shared by all three save paths (running / paused / terminal):
   * - constructs the artifact from current loop state merged with the caller-supplied overrides
   * - saves with `ifRevisionEquals` when a revision is known
   * - updates `runContext.expectedArtifactRevision` so the next save uses the new revision
   * - swallows {@link StaleArtifactError} with a warning (another writer won the race; not fatal)
   *
   * @param overrides  Fields that differ between the three save paths (status, liveInfra, etc.)
   * @param failureContext  Human-readable label used in the warning log when an unexpected error occurs.
   */
  const persistArtifact = async (
    overrides: {
      status: RunStatus;
      controlSignal: RunControlSignal | null;
      pausedSandboxBasePath: string | null;
      liveInfra: RunLiveInfra | null;
      lastFeedback?: string;
    },
    failureContext: string,
  ): Promise<void> => {
    if (!runStorage || !runContext) return;
    try {
      const artifact = buildRunArtifact({
        runId,
        baseCommitSha: runContext.baseCommitSha,
        basePatchDiff: runContext.basePatchDiff,
        runCommits: runCommitsAccum,
        specRef: feature.relativePath,
        lastFeedback: overrides.lastFeedback,
        rules: runContext.rules,
        roundSummaries,
        status: overrides.status,
        controlSignal: overrides.controlSignal,
        pausedSandboxBasePath: overrides.pausedSandboxBasePath,
        liveInfra: overrides.liveInfra,
        inspectSession: null,
        opts: loopOpts as BuildRunArtifactOpts,
      });
      const expectedRev = runContext.expectedArtifactRevision;
      const newRev = await runStorage.saveRun(
        runId,
        artifact,
        expectedRev !== undefined ? { ifRevisionEquals: expectedRev } : undefined,
      );
      runContext.expectedArtifactRevision = newRev;
    } catch (err) {
      if (err instanceof StaleArtifactError) {
        consola.warn(`[orchestrator] ${err.message}`);
      } else {
        consola.warn(`[orchestrator] Failed to save ${failureContext}:`, err);
      }
    }
  };

  /**
   * Incremental save during an active run.
   *
   * - `controlSignal` is re-read from storage so concurrent `saifctl run pause/stop` writes are
   *   not overwritten (last-write-wins for control signals).
   * - `liveInfra` is supplied by the caller (current in-flight snapshot) so crash recovery has
   *   an accurate resource list even before the round completes and `pauseSnapshotLiveInfra` is set.
   *   When omitted (calls outside a coding round) the stored value is preserved.
   */
  const saveRunningArtifact = async (
    failureContext: string,
    currentLiveInfra?: RunLiveInfra | null,
  ) => {
    if (!runStorage || !runContext) return;
    const latest = await runStorage.getRun(runId);
    const latestStatus = latest?.status;
    /** Preserve transitional statuses from concurrent pause/stop/start handshakes; default to `running`. */
    const persistedStatus: RunStatus =
      latestStatus === 'pausing' ||
      latestStatus === 'stopping' ||
      latestStatus === 'starting' ||
      latestStatus === 'resuming'
        ? latestStatus
        : 'running';
    await persistArtifact(
      {
        status: persistedStatus,
        controlSignal: latest?.controlSignal ?? null,
        pausedSandboxBasePath: null,
        liveInfra: currentLiveInfra !== undefined ? currentLiveInfra : (latest?.liveInfra ?? null),
        lastFeedback: lastErrorFeedback || undefined,
      },
      failureContext,
    );
  };

  const saveRoundProgress = async () => saveRunningArtifact('round progress');

  const savePausedArtifact = async () => {
    await persistArtifact(
      {
        status: 'paused',
        controlSignal: null,
        pausedSandboxBasePath: sandbox.sandboxBasePath,
        liveInfra: pauseSnapshotLiveInfra,
        lastFeedback: lastErrorFeedback || undefined,
      },
      'paused run state',
    );
    consola.log(`[orchestrator] Run paused — resume with: saifctl run resume ${runId}`);
    registry.clearEmergencySandboxPath();
  };

  const cleanupAndSaveRun = async (input: { status: OrchestratorOutcomeStatus }) => {
    const { status } = input;
    const didSucceed = status === 'success';

    // Always persist a run artifact when storage is enabled (completed or failed) so `run ls`
    // and downstream tooling see every run.
    if (runStorage && runContext) {
      await persistArtifact(
        {
          status: didSucceed ? 'completed' : 'failed',
          controlSignal: null,
          pausedSandboxBasePath: null,
          liveInfra: null,
          lastFeedback: didSucceed ? undefined : lastErrorFeedback || undefined,
        },
        'run state',
      );
      if (didSucceed) {
        consola.log(`[orchestrator] Run artifact saved (completed). Run ID: ${runId}`);
      } else {
        consola.log(
          `[orchestrator] Run artifact saved (failed). Start again with: saifctl run start ${runId}`,
        );
      }
    }
    if (!sandboxDestroyed) {
      await destroySandbox(sandbox.sandboxBasePath);
    }
    registry.clearEmergencySandboxPath();
  };

  // Wrapper for the main loop so we can derive didSucceed from returned value and cleanup on error.
  const withCleanup = async (fn: () => Promise<OrchestratorResult>) => {
    let resultStatus: OrchestratorOutcomeStatus = 'failed';
    try {
      const result = await fn();
      resultStatus = result.status;
      return result;
    } finally {
      if (resultStatus === 'paused') {
        await savePausedArtifact();
      } else {
        await cleanupAndSaveRun({ status: resultStatus });
      }
    }
  };

  /** Builds a stopped/paused {@link OrchestratorResult} for the current attempt count. */
  const controlResult = (
    status: OrchestratorOutcomeStatus,
    message: string,
  ): OrchestratorResult => ({
    status,
    attempts,
    runId,
    message,
  });

  //////////////////////////////////////////////////
  // Main - Wrapped in cleanup logic
  //////////////////////////////////////////////////

  return await withCleanup(async () => {
    const testRunnerOpts = await prepareTestRunnerOpts({
      feature,
      sandboxBasePath: sandbox.sandboxBasePath,
      testScript,
    });

    // Resolve the coder agent's LLM config once per loop.
    const patchExclude = buildPatchExcludeRules(saifctlDir, optsPatchExclude);

    //////////////////////////////////////////////////
    // 'run test'
    //
    // TODO - We should use single Hatchet workflow, whether we call
    //        'run test' or 'run start'.
    //////////////////////////////////////////////////

    if (testOnly) {
      consola.log(
        '\n[orchestrator] test-only — skipping coding agent; verifying stored patch with staging tests.',
      );
      await writeUtf8(
        join(sandbox.sandboxBasePath, 'run-commits.json'),
        JSON.stringify(runCommitsAccum),
      );

      const verifyOnly = await runStagingTestVerification({
        sandbox,
        orchestratorOpts: opts,
        registry,
        testRunnerOpts,
        outerAttempt: 1,
        onStagingInfraReady: async (infra) => {
          await saveRunningArtifact('staging infra provisioned', { coding: null, staging: infra });
        },
        onStagingTeardownComplete: async () => {
          await saveRunningArtifact('staging infra torn down', { coding: null, staging: null });
        },
      });

      if (verifyOnly.kind === 'passed') {
        consola.log('\n[orchestrator] ✓ ALL TESTS PASSED — applying patch to host');
        await applyPatchToHost({
          codePath: sandbox.codePath,
          projectDir,
          feature,
          runId,
          commits: runCommitsAccum,
          hostBasePatchPath: sandbox.hostBasePatchPath,
          push,
          pr,
          gitProvider,
          llm,
          verbose,
          targetBranch,
          startCommit: runContext?.baseCommitSha?.trim() || undefined,
        });
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;

        return {
          status: 'success',
          attempts: 1,
          runId,
          message: 'Run verified; patch applied to host repository.',
        };
      }

      if (verifyOnly.kind === 'aborted') {
        consola.log('\n[orchestrator] Tests aborted.');
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;
        return {
          status: 'failed',
          attempts: 1,
          runId,
          message: 'Tests were aborted.',
        };
      }

      const base = 'An external service attempted to use this project and failed. ';
      const hint =
        verifyOnly.lastVagueSpecsCheckResult?.sanitizedHint ??
        'Re-read the plan and specification, and fix the implementation.';
      const feedback = base + hint;
      lastErrorFeedback = feedback;
      if (runContext) runContext.lastErrorFeedback = feedback;

      return {
        status: 'failed',
        attempts: 1,
        runId,
        message: `Tests failed after ${verifyOnly.testAttempts} run(s). Last error:\n${feedback}`,
      };
    }

    //////////////////////////////////////////////////
    // Main Loop - 'run start'
    //////////////////////////////////////////////////

    while (attempts < maxRuns) {
      attempts++;
      consola.log(`\n[orchestrator] ===== ATTEMPT ${attempts}/${maxRuns} (run ${runId}) =====`);

      //////////////////////////////////////////////////
      // Prep
      //////////////////////////////////////////////////

      const attemptStartedAt = new Date().toISOString();

      // Snapshot HEAD before this coding round: used as the diff base for
      // `extractIncrementalRoundPatch` and as the reset target when staging tests fail
      // (discard this attempt's work without losing earlier rounds or seeded commits).
      const preRoundHead = (
        await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
      ).trim();

      // Part of real-time human feedback and 'run stop' / 'run pause' control signals.
      // To detect if we received some actions from the user, we refresh the Run artifact
      // on each attempt (outer loop). It stores info on pending control signals (pause / stop)
      // or new Run rules that were created during the previous attempt.
      let controlBeforeRound: 'pause' | 'stop' | null = null;
      if (runStorage && runContext) {
        const freshArtifact = await runStorage.getRun(runId);
        if (freshArtifact) {
          // Check for control signals (pause / stop)
          const a = freshArtifact.controlSignal?.action;
          if (a === 'pause' || a === 'stop') {
            controlBeforeRound = a;
          }
          // Check for new Run rules
          runContext.rules = reconcileRunRulesWithStorage({
            inMemory: runContext.rules,
            fromStorage: freshArtifact.rules ?? [],
          });
          // Update the expected artifact revision
          if (freshArtifact.artifactRevision !== undefined) {
            runContext.expectedArtifactRevision = freshArtifact.artifactRevision;
          }
        }
      }

      // Act on control signals (pause / stop) from storage
      if (controlBeforeRound === 'stop')
        return controlResult('stopped', 'Run stopped by request (before coding round).');
      if (controlBeforeRound === 'pause')
        return controlResult('paused', 'Run paused by request (before coding round).');

      // Some Run rules are marked as "once" and should be consumed after the coding round.
      // Thus these rules are included in the task prompt only on the first round.
      const onceIdsThisRound = runContext ? activeOnceRuleIds(runContext.rules) : [];
      const task = await buildInitialTask({
        feature,
        saifctlDir,
        rules: runContext ? rulesForPrompt(runContext.rules) : [],
      });

      //////////////////////////////////////////////////
      // Run agent
      //////////////////////////////////////////////////

      // Run agent (fresh context every iteration — Ralph Wiggum)
      // The coding engine sets up its network + compose services, runs the coder agent,
      // then tears itself down (or pauses) depending on control signals.
      const codingResult = await runCodingPhase({
        sandbox,
        attempt: attempts,
        errorFeedback,
        task,
        resumedCodingInfra,
        storage: runStorage && runContext ? { runStorage, runContext } : null,
        registry: registry ?? null,
        preRoundHeadSha: preRoundHead,
        patchExclude,
        onInfraReady: async (infra) => {
          await saveRunningArtifact('coding infra provisioned', { coding: infra, staging: null });
        },
        opts: {
          llm,
          projectDir,
          projectName,
          feature,
          dangerousNoLeash,
          coderImage,
          gateRetries,
          agentEnv,
          agentSecretKeys,
          agentSecretFiles,
          agentProfileId,
          reviewerEnabled,
          codingEnvironment,
          saifctlDir,
          inspectMode,
        },
      });

      // Consume resumed infra after the first round (setup was skipped; next round provisions fresh).
      resumedCodingInfra = null;

      // Act on control signals (pause / stop) received during the coding round.
      // For 'stop' and 'pause' we preserve the changes made by the agent
      // by saving the commits to the run artifact.
      switch (codingResult.outcome) {
        case 'stopped': {
          const { commits } = codingResult;
          runCommitsAccum = [...runCommitsAccum, ...commits];
          return controlResult('stopped', 'Run stopped by request.');
        }
        case 'paused': {
          const { commits, liveInfra } = codingResult;
          runCommitsAccum = [...runCommitsAccum, ...commits];
          pauseSnapshotLiveInfra = { coding: liveInfra, staging: null };
          return controlResult('paused', 'Run paused by request.');
        }
        default:
          break;
      }
      // Inspect session ended — skip tests, git branch creation, and further iterations.
      if (codingResult.outcome === 'inspected')
        return controlResult('stopped', 'Inspect session complete.');

      //////////////////////////////////////////////////
      // Run completed; extract patch
      //////////////////////////////////////////////////

      const { innerRounds } = codingResult;

      // Mark once rules as consumed if they were used this round, then persist so storage
      // stays authoritative before the next reconcile (start of next outer attempt).
      if (runContext && onceIdsThisRound.length > 0) {
        markOnceRulesConsumed(runContext.rules, onceIdsThisRound);
        await saveRunningArtifact('consumed rules');
      }

      // Extract incremental patch(es) for this round
      // (one RunCommit per sandbox commit + optional WIP).
      const { patch: patchContent, commits: roundCommits } = await extractIncrementalRoundPatch(
        sandbox.codePath,
        {
          preRoundHeadSha: preRoundHead,
          attempt: attempts,
          exclude: patchExclude,
        },
      );

      // Detect if there has been any changes made to the sandbox by the agent.
      // Previously we checked only the current patch, but changes may be already committed.
      // So to truly know if no changes were made, we need to also look at the sandbox history.
      const roundCommitCount = roundCommits.length;
      const roundPatchEmpty = roundCommitCount === 0 || !patchContent.trim();
      const hasPriorWorkInSandbox = await sandboxHasCommitsBeyondInitialImport(sandbox.codePath);

      // No changes whatsoever - no patch, no commits
      if (roundPatchEmpty && !hasPriorWorkInSandbox) {
        consola.warn('[orchestrator] Agent produced no changes (empty patch). Skipping tests.');
        errorFeedback =
          'No changes were made. Please implement the feature as described in the plan.';
        lastErrorFeedback = errorFeedback;
        if (runContext) {
          runContext.lastErrorFeedback = errorFeedback;
        }

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            phase: 'no_changes',
            innerRounds,
            commitCount: 0,
            patchBytes: 0,
            errorFeedback,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();
        continue;
      }

      // No changes this round, but the sandbox already has commits (e.g. seeded runCommits)
      if (roundPatchEmpty && hasPriorWorkInSandbox) {
        consola.log(
          '[orchestrator] No new changes this coding round, but the sandbox already has commits (e.g. seeded runCommits) — running tests on the current tree.',
        );
        if (runCommitsAccum.length > 0) {
          await writeUtf8(
            join(sandbox.sandboxBasePath, 'run-commits.json'),
            JSON.stringify(runCommitsAccum),
          );
        }
      }

      // Changes this round — append round commits to the accumulator and write to file
      if (!roundPatchEmpty) {
        runCommitsAccum = [...runCommitsAccum, ...roundCommits];
        await writeUtf8(
          join(sandbox.sandboxBasePath, 'run-commits.json'),
          JSON.stringify(runCommitsAccum),
        );

        consola.log(`[orchestrator] Extracted patch (${patchContent.length} bytes)`);

        const patchPaths = listFilePathsInUnifiedDiff(patchContent);
        if (patchPaths.length === 0) {
          consola.warn(
            '[orchestrator] No paths parsed from patch diff --git headers — patch may be malformed or empty of file sections.',
          );
        } else {
          consola.log(
            `[orchestrator] Files in patch content (${patchPaths.length}): ${patchPaths.join(', ')}`,
          );
        }
      }

      //////////////////////////////////////////////////
      // Run tests
      //////////////////////////////////////////////////

      // Mutual Verification (with test retries for flaky environments)
      const verify = await runStagingTestVerification({
        sandbox,
        orchestratorOpts: opts,
        registry,
        testRunnerOpts,
        outerAttempt: attempts,
        onStagingInfraReady: async (infra) => {
          // Coding infra is already torn down at this point; record only staging resources
          // so crash recovery can clean up the live staging containers/network.
          await saveRunningArtifact('staging infra provisioned', { coding: null, staging: infra });
        },
        onStagingTeardownComplete: async () => {
          await saveRunningArtifact('staging infra torn down', { coding: null, staging: null });
        },
      });

      // Success path - apply patch to host as git branch (optionally open PR)
      if (verify.kind === 'passed') {
        consola.log('\n[orchestrator] ✓ ALL TESTS PASSED — applying patch to host');

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            phase: 'tests_passed',
            innerRounds,
            commitCount: roundCommits.length,
            patchBytes: patchContent.length,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();

        await applyPatchToHost({
          codePath: sandbox.codePath,
          projectDir,
          feature,
          runId,
          commits: runCommitsAccum,
          hostBasePatchPath: sandbox.hostBasePatchPath,
          push,
          pr,
          gitProvider,
          llm,
          verbose,
          targetBranch,
          startCommit: runContext?.baseCommitSha?.trim() || undefined,
        });
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;

        return {
          status: 'success',
          attempts,
          runId,
          message: `Feature implemented successfully in ${attempts} attempt(s).`,
        };
      }

      // Tests aborted - discard this attempt's work and reset to the pre-round HEAD
      if (verify.kind === 'aborted') {
        consola.log(`\n[orchestrator] Tests aborted after ${attempts} attempt(s).`);

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            phase: 'aborted',
            innerRounds,
            commitCount: roundCommits.length,
            patchBytes: patchContent.length,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();

        if (roundCommitCount > 0) {
          runCommitsAccum = runCommitsAccum.slice(0, -roundCommitCount);
        }
        await writeUtf8(
          join(sandbox.sandboxBasePath, 'run-commits.json'),
          JSON.stringify(runCommitsAccum),
        );
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;
        return {
          status: 'failed',
          attempts,
          message: `Tests were aborted after ${attempts} attempt(s).`,
        };
      }

      //////////////////////////////////////////////////
      // Exhausted test retries within one outer attempt.
      //
      // Treat as failure; send feedback to the agent.
      //////////////////////////////////////////////////

      // NOTE: Never mention tests - That's why we return the "sanitizedHint" - it's
      //       AI summarisation of the error(s) that avoids talking about the specifics
      //       of what was assessed.
      //       The error message is framed as something "external" that's out of reach for the agent
      //       (e.g. "An external service attempted to use this project and failed"),
      //       so the agent doesn't think it can fix the failure by changing tests.
      const base = 'An external service attempted to use this project and failed. ';
      const hint =
        verify.lastVagueSpecsCheckResult?.sanitizedHint ??
        'Re-read the plan and specification, and fix the implementation.';
      errorFeedback = base + hint;

      lastErrorFeedback = errorFeedback;
      if (runContext) runContext.lastErrorFeedback = errorFeedback;

      roundSummaries = [
        ...roundSummaries,
        buildOuterAttemptSummary({
          attempt: attempts,
          phase: 'tests_failed',
          innerRounds,
          commitCount: roundCommits.length,
          patchBytes: patchContent.length,
          errorFeedback,
          startedAt: attemptStartedAt,
        }),
      ];
      await saveRoundProgress();

      consola.log(
        `\n[orchestrator] Attempt ${attempts} FAILED (tests failed after ${verify.testAttempts} run(s)).`,
      );

      if (roundCommitCount > 0) {
        runCommitsAccum = runCommitsAccum.slice(0, -roundCommitCount);
      }
      await writeUtf8(
        join(sandbox.sandboxBasePath, 'run-commits.json'),
        JSON.stringify(runCommitsAccum),
      );

      // Reset to state at start of this attempt (Ralph: discard failed round only; keep stored-run seed)
      await gitResetHard({ cwd: sandbox.codePath, ref: preRoundHead });
      await gitClean({ cwd: sandbox.codePath });
    }

    //////////////////////////////////////////////////
    // Max attempts reached
    //////////////////////////////////////////////////

    consola.error(`\n[orchestrator] Max runs (${maxRuns}) reached without success.`);

    return controlResult('failed', `Failed after ${maxRuns} runs. Last error:\n${errorFeedback}`);
  });
}

// ---------------------------------------------------------------------------
// Vague Specs Checker: check for ambiguity vs genuine failure on tests failures
// ---------------------------------------------------------------------------

interface RunVagueSpecsCheckerForFailureOpts {
  projectName: string;
  /** Absolute path to the project directory */
  projectDir: string;
  feature: Feature;
  testProfile: TestProfile;
  testSuites: AssertionSuiteResult[];
  /**
   * Decides action when tests fail due to ambiguous specs:
   * - `ai`: auto-append clarification to specs, regenerate tests, continue.
   * - `prompt`: pause and ask human to confirm/edit proposed clarification before updating.
   */
  resolveAmbiguity: 'prompt' | 'ai';
  /** Effective LLM config — forwarded to vague-specs-check and tests pipeline. */
  llm: LlmOverrides;
}

interface VagueSpecsCheckerForFailureResult {
  /** True when the spec was genuinely ambiguous AND the ambiguity was resolved */
  ambiguityResolved: boolean;
  /** Sanitized behavioral hint for the agent (empty if ambiguityResolved=true) */
  sanitizedHint: string;
}

/**
 * Resolve how to continue after a failing test suite. Test failures may
 * be actually caused by ambiguous specs.
 *
 * In `ai` mode: if the spec is ambiguous, appends the proposed clarification
 * to specification.md and regenerates runner.spec.ts without human input.
 *
 * In `prompt` mode: shows the proposed clarification to the human and asks for
 * confirmation before updating the spec. If the human declines, treats the
 * failure as genuine.
 *
 * Returns `ambiguityResolved: true` when the spec was updated so the caller can
 * reset the attempt counter.
 */
export async function runVagueSpecsCheckerForFailure(
  opts: RunVagueSpecsCheckerForFailureOpts,
): Promise<VagueSpecsCheckerForFailureResult> {
  const { projectDir, feature, testSuites, resolveAmbiguity, testProfile, projectName, llm } = opts;

  const specPath = join(feature.absolutePath, 'specification.md');
  const specContent = (await pathExists(specPath))
    ? await readUtf8(specPath)
    : '(specification.md not found)';

  consola.log('[vague-specs-check] Running ambiguity check...');

  // Stream vague-specs-check thinking in real-time (similar to [think]/[agent] style from OpenHands)
  let thinkBuf = '';
  const onVagueSpecsCheckThought = (delta: string) => {
    thinkBuf += delta;
    const lines = thinkBuf.split('\n');
    thinkBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) process.stdout.write(`[vague-specs-check:think] ${trimmed.slice(0, 200)}\n`);
    }
  };
  const onVagueSpecsCheckEvent = (chunk: { type: string; payload: unknown }) => {
    if (chunk.type === 'tool-call') {
      const p = chunk.payload as { toolName?: string };
      process.stdout.write(`[vague-specs-check] tool: ${p.toolName ?? '?'}\n`);
    }
  };

  const verdict = await runVagueSpecsChecker({
    specContent,
    failingSuites: testSuites,
    llm,
    onThought: onVagueSpecsCheckThought,
    onEvent: onVagueSpecsCheckEvent,
  });
  // Flush any remaining partial thought line
  if (thinkBuf.trim()) {
    process.stdout.write(`[vague-specs-check:think] ${thinkBuf.trim().slice(0, 200)}\n`);
  }

  consola.log(`[vague-specs-check] isAmbiguous=${verdict.isAmbiguous}`);
  consola.log(`[vague-specs-check] Reason: ${verdict.reason}`);

  if (!verdict.isAmbiguous) {
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  // --- Ambiguous spec detected ---
  consola.log(`[vague-specs-check] Proposed spec addition:\n  "${verdict.proposedSpecAddition}"`);

  if (resolveAmbiguity === 'prompt') {
    consola.log(`\n[vague-specs-check] Ambiguity detected. Reason: ${verdict.reason}`);
    consola.log(
      `[vague-specs-check] Vague Specs Checker suggests: "${verdict.proposedSpecAddition}"`,
    );

    const answer = await text({
      message: 'What is the correct behavior? (describe it; we will add it to specification.md)',
      placeholder: verdict.proposedSpecAddition,
    });

    if (isCancel(answer) || !answer?.trim()) {
      consola.log('[vague-specs-check] Human skipped — treating failure as genuine.');
      return {
        ambiguityResolved: false,
        sanitizedHint: verdict.sanitizedHintForAgent,
      };
    }

    // Override the proposed spec addition with what the human actually said
    verdict.proposedSpecAddition = answer.trim();
  }

  // Append clarification to specification.md
  if (await pathExists(specPath)) {
    const addition = `\n\n<!-- Vague Specs Checker clarification (auto-added) -->\n${verdict.proposedSpecAddition}\n`;
    await appendUtf8(specPath, addition);
    consola.log(`[vague-specs-check] Appended clarification to ${specPath}`);
  } else {
    consola.warn('[vague-specs-check] specification.md not found — cannot update spec.');
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  // Regenerate tests from the updated spec (design pipeline writes tests.json,
  // then scaffold generates the spec files via the coder agent).
  consola.log('[vague-specs-check] Regenerating tests with updated spec...');
  try {
    await runDesignTests({
      feature,
      projectDir,
      testProfile,
      projectName,
      llm,
    });
    await generateTests({ feature, testProfile, llm });
    consola.log('[vague-specs-check] Tests regenerated successfully.');
  } catch (err) {
    consola.warn(`[vague-specs-check] Test regeneration failed (non-fatal): ${String(err)}`);
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  return { ambiguityResolved: true, sanitizedHint: '' };
}

interface BuildInitialTaskOpts {
  feature: Feature;
  saifctlDir: string;
  /** User rules to inject (already filtered and orderedempty to skip section. */
  rules: readonly RunRule[];
}

export async function buildInitialTask(opts: BuildInitialTaskOpts): Promise<string> {
  const { feature, saifctlDir, rules } = opts;
  const planPath = join(feature.absolutePath, 'plan.md');
  const specPath = join(feature.absolutePath, 'specification.md');

  const parts = [
    `Implement the feature '${feature.name}' as described in the plan below.`,
    `Write code in the /workspace directory. Do NOT modify files in the /${saifctlDir}/ directory.`,
    'When complete, ensure the code compiles and passes linting.',
  ];

  if (await pathExists(planPath)) {
    parts.push('', '## Plan', '', await readUtf8(planPath));
  }

  if (await pathExists(specPath)) {
    parts.push('', '## Specification', '', await readUtf8(specPath));
  }

  if (rules.length > 0) {
    parts.push('', '## User feedback', '');
    for (const r of rules) {
      const label = r.scope === 'once' ? '(this round only)' : '(always)';
      parts.push(`- [${label}] ${r.content}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities (used by loop and by modes)
// ---------------------------------------------------------------------------

interface LoadCatalogOpts {
  feature: Feature;
}

export async function loadCatalog(opts: LoadCatalogOpts) {
  const { feature } = opts;
  const testsJsonPath = join(feature.absolutePath, 'tests', 'tests.json');
  if (!(await pathExists(testsJsonPath))) {
    throw new Error(
      `tests.json not found at ${testsJsonPath}. Run 'saifctl feat design -n ${feature.name}' first.`,
    );
  }
  const raw = JSON.parse(await readUtf8(testsJsonPath)) as unknown;
  const result = TestCatalogSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `tests.json schema validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}

interface PrepareTestRunnerOptsArgs {
  feature: Feature;
  /** Sandbox root — the test runner writes results.xml here (via /test-runner-output bind-mount). */
  sandboxBasePath: string;
  /**
   * Content of the test script (default or custom). Always written to
   * `{sandboxBasePath}/test.sh` and bind-mounted at /usr/local/bin/test.sh
   * inside the Test Runner container (read-only).
   */
  testScript: string;
}

/**
 * Prepares the test runner filesystem inputs for a feature run.
 *
 * Returns `testsDir` (the tests/ directory for the feature), `reportDir` (sandbox root,
 * so that `runTests` can find results.xml at `{sandboxRoot}/results.xml`), and
 * `testScriptPath` (always set — written from DEFAULT_TEST_SCRIPT or a custom override).
 *
 * Spec files are expected to already exist — generated by `saifctl feat design`.
 */
export async function prepareTestRunnerOpts({
  feature,
  sandboxBasePath,
  testScript,
}: PrepareTestRunnerOptsArgs): Promise<
  Pick<RunTestsOpts, 'testsDir' | 'reportDir' | 'testScriptPath'>
> {
  const testsDir = join(feature.absolutePath, 'tests');

  const testScriptPath = join(sandboxBasePath, 'test.sh');
  await writeUtf8(testScriptPath, testScript, { mode: 0o755 });
  consola.log(`[orchestrator] test.sh written to ${testScriptPath}`);

  return { testsDir, reportDir: sandboxBasePath, testScriptPath };
}

/** Settings banner for `feat run` and `run start` (after merge), using resolved orchestrator opts. */
export function logIterativeLoopSettings(opts: OrchestratorOpts, meta?: { runId?: string }): void {
  const agentProfile = resolveAgentProfile(opts.agentProfileId);
  consola.log(`\nStarting iterative loop: ${opts.feature.name}`);
  if (meta?.runId) {
    consola.log(`  Run ID: ${meta.runId}`);
  }
  consola.log(`  Max runs: ${opts.maxRuns}`);
  consola.log(`  Test retries: ${opts.testRetries}`);
  consola.log(`  Spec ambiguity resolution: ${opts.resolveAmbiguity}`);
  consola.log(`  Test image: ${opts.testImage}`);
  if (opts.codingEnvironment.engine === 'local') {
    consola.log('  Leash: disabled (host execution)');
  } else if (opts.dangerousNoLeash) {
    consola.log(`  Leash: disabled (direct docker run; image: ${opts.coderImage})`);
  } else {
    consola.log(`  Leash: enabled (image: ${opts.coderImage})`);
    consola.log(`  Cedar policy: ${opts.cedarPolicyPath}`);
  }
  consola.log(`  Startup script: ${opts.sandboxProfileId} profile default`);
  consola.log(`  Gate script: ${opts.sandboxProfileId} profile default`);
  consola.log(`  Agent: ${agentProfile.displayName} (profile: ${agentProfile.id})`);
  consola.log(`  Stage script: ${opts.sandboxProfileId} profile default`);
  consola.log('  Test script: built-in (test-default.sh)');
  consola.log(`  Agent env vars: ${Object.keys(opts.agentEnv).join(', ') || 'none'}`);
  consola.log(
    `  Agent secret keys (host → container): ${opts.agentSecretKeys.join(', ') || 'none'}`,
  );
  consola.log(
    `  Agent secret file(s): ${opts.agentSecretFiles.join(', ') || 'none'} (KEY=value .env format; re-read when starting from a Run)`,
  );
  consola.log(`  Gate retries: ${opts.gateRetries}`);
  if (opts.push) {
    consola.log(`  Push: ${opts.push}${opts.pr ? ` (+ PR via ${opts.gitProvider.id})` : ''}`);
  }
  if (opts.targetBranch) {
    consola.log(`  Host apply target branch: ${opts.targetBranch}`);
  }
  if (opts.verbose === true) consola.log('  Verbose: enabled');
  if (opts.includeDirty) {
    consola.log('  Sandbox copy: uncommitted + untracked included (--include-dirty)');
  }
  if (opts.testOnly) consola.log('  Test-only: skip coding agent (verification / `run test`)');
}
