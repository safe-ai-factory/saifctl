/**
 * Iterative agent loop and related utilities.
 * Used by mode 'start' (and 'fromArtifact' via runStartCore).
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  type RunTestsOpts,
  type TestsResult,
} from '../engines/types.js';
import { parseJUnitXmlString } from '../engines/utils/test-parser.js';
import type { GitProvider } from '../git/types.js';
import { type ModelOverrides, resolveAgentLlmConfig } from '../llm-config.js';
import { consola } from '../logger.js';
import {
  activeOnceRuleIds,
  appendMissingRunRules,
  formatRuleBlockForPending,
  markOnceRulesConsumed,
  pendingRulesPath,
  preparePendingRulesFile,
  reconcileRunRulesWithStorage,
  rulesForPrompt,
  startRulesWatcher,
} from '../runs/rules.js';
import {
  type InnerRoundSummary,
  type OuterAttemptSummary,
  type RunCommit,
  type RunRule,
  StaleArtifactError,
} from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import type { TestProfile } from '../test-profiles/types.js';
import type { CleanupRegistry } from '../utils/cleanup.js';
import { git, gitClean, gitResetHard } from '../utils/git.js';
import { appendUtf8, pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { buildCoderContainerEnv } from './agent-env.js';
import { buildTaskPrompt } from './agent-task.js';
import { runVagueSpecsChecker } from './agents/vague-specs-check.js';
import { createAgentStdoutPipe, createDefaultAgentLog } from './logs.js';
import type { OrchestratorOpts } from './modes.js';
import { applyPatchToHost } from './phases/apply-patch.js';
import {
  destroySandbox,
  extractIncrementalRoundPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  type Sandbox,
} from './sandbox.js';
import { getArgusBinaryPath } from './sidecars/reviewer/argus.js';
import {
  buildOuterAttemptSummary,
  prepareRoundsStatsFile,
  readInnerRounds,
  roundsStatsPath,
} from './stats.js';

/**
 * Builds `extractPatch` exclude rules: fixed guardrails plus optional caller rules.
 *
 * Always excludes:
 * - `{saifDir}/**` — reward-hacking prevention (agent must not modify its own test specs).
 * - `.git/hooks/**` — prevents a malicious patch from installing hooks that execute on the host
 *   when the orchestrator runs `git commit` in applyPatchToHost.
 * - `.saifctl/**` — factory-internal workspace state (e.g. per-round task file), not product code.
 */
export function buildPatchExcludeRules(
  saifDir: string,
  patchExclude?: PatchExcludeRule[],
): PatchExcludeRule[] {
  return [
    { type: 'glob', pattern: `${saifDir}/**` },
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
   * CLI-level LLM overrides (--model, --base-url).
   *
   * The orchestrator uses this to resolve the coder agent's model config via
   * `resolveAgentLlmConfig('coder', 'coder', overrides)` and to pass overrides
   * through to Mastra agents (vague-specs-check, pr-summarizer, tests pipeline).
   *
   * When omitted, all agents fall back to env-var tier overrides then auto-discovery.
   */
  overrides: ModelOverrides;
  /**
   * Saifctl directory name relative to repo root (e.g. 'saifctl').
   * Resolved by caller (e.g. readSaifDirFromCli + resolveSaifDirRelative).
   */
  saifDir: string;
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
   * Absolute path to a Cedar policy file for Leash.
   *
   * Defaults to default.cedar in src/orchestrator/policies/.
   * Ignored when dangerousNoLeash=true or with `--engine local`.
   */
  cedarPolicyPath: string;
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
   * Persisted in run artifacts as names only; values are re-read from the host when starting from a stored run.
   */
  agentSecretKeys: string[];
  /**
   * Project-relative paths to `.env`-style files with `KEY=value` secret pairs — same format as
   * `--agent-env-file`. Persisted in run artifacts; when starting from a stored run the files are read again (values are
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
   * applied to the host repo. The saifDir/ glob is always prepended
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
   * When starting from a stored run, seed {@link RunArtifact#runCommits} (replayed in sandbox before the loop).
   */
  seedRunCommits?: RunCommit[];
  /**
   * When starting from a stored run, seed {@link RunArtifact#roundSummaries} so new outer attempts append after prior history.
   */
  seedRoundSummaries?: OuterAttemptSummary[];
  /**
   * When true, skip the coding agent and run only staging + tests (+ optional apply to host on pass).
   * Used by `saifctl run test` (stored run re-verification).
   */
  testOnly?: boolean;
}

export interface OrchestratorResult {
  success: boolean;
  attempts: number;
  /** Run ID for starting again when run storage is enabled (artifact under .saifctl/runs/) */
  runId?: string;
  /** Path to the winning patch.diff if success=true */
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
}): Promise<StagingTestVerificationResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    projectName,
    testImage,
    resolveAmbiguity,
    testProfile,
    overrides,
    testRetries,
    stagingEnvironment,
  } = params.orchestratorOpts;
  const { sandbox, registry, testRunnerOpts, outerAttempt } = params;

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
    registry?.registerEngine(stagingEngine, lastRunId);
    await stagingEngine.setup({
      runId: lastRunId,
      projectName,
      featureName: feature.name,
      projectDir,
    });

    const result: TestsResult = await (async (): Promise<TestsResult> => {
      try {
        const stagingHandle = await stagingEngine.startStaging({
          sandboxProfileId,
          codePath: sandbox.codePath,
          projectDir,
          stagingEnvironment,
          feature,
          projectName,
          saifctlPath: sandbox.saifctlPath,
          onLog: defaultEngineLog,
        });

        return await stagingEngine.runTests({
          ...testRunnerOpts,
          stagingHandle,
          testImage,
          runId: lastRunId,
          feature,
          projectName,
          onLog: defaultEngineLog,
        });
      } finally {
        registry?.deregisterEngine(stagingEngine);
        await stagingEngine.teardown({ runId: lastRunId });
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
        overrides,
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
    /** When starting from a stored run: seed the first agent round with this feedback */
    initialErrorFeedback: string | null;
    registry: CleanupRegistry;
  },
): Promise<OrchestratorResult> {
  const {
    feature,
    projectDir,
    maxRuns,
    overrides,
    saifDir,
    projectName,
    registry,
    dangerousNoLeash,
    cedarPolicyPath,
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
  } = opts;

  const runId = sandbox.runId;

  /** Accumulated run commits (seeded from stored run + each successful coding round). */
  let runCommitsAccum: RunCommit[] = [...(seedRunCommits ?? [])];
  let lastErrorFeedback = '';
  let roundSummaries: OuterAttemptSummary[] = [...(seedRoundSummaries ?? [])];

  // Resolve the coder agent's LLM config once per loop.
  const coderLlmConfig = resolveAgentLlmConfig('coder', overrides);
  const codingIsLocal = codingEnvironment.engine === 'local';
  const reviewer =
    reviewerEnabled && !codingIsLocal
      ? {
          llmConfig: resolveAgentLlmConfig('reviewer', overrides),
          argusBinaryPath: await getArgusBinaryPath(),
        }
      : null;
  const patchExclude = buildPatchExcludeRules(saifDir, opts.patchExclude);
  const agentProfile = resolveAgentProfile(agentProfileId);

  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  /**
   * Persists the current running artifact (rules with `consumedAt`, commits, round summaries,
   * last feedback). Used for incremental saves and immediately after marking once-rules consumed.
   */
  const saveRunningArtifact = async (failureContext: string) => {
    if (!runStorage || !runContext) return;
    try {
      const {
        registry: _reg,
        runStorage: _rs,
        runContext: _rc,
        fromArtifact: _fromArtifact,
        ...loopOpts
      } = opts;
      const artifact = buildRunArtifact({
        runId,
        baseCommitSha: runContext.baseCommitSha,
        basePatchDiff: runContext.basePatchDiff,
        runCommits: runCommitsAccum,
        specRef: feature.relativePath,
        lastFeedback: lastErrorFeedback || undefined,
        rules: runContext.rules,
        roundSummaries,
        status: 'running',
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

  const saveRoundProgress = async () => saveRunningArtifact('round progress');

  const cleanupAndSaveRun = async (input: { didSucceed: boolean }) => {
    const { didSucceed } = input;

    // Always persist a run artifact when storage is enabled (completed or failed) so `run ls`
    // and downstream tooling see every run.
    if (runStorage && runContext) {
      try {
        const {
          registry: _reg,
          runStorage: _rs,
          runContext: _rc,
          fromArtifact: _fromArtifact,
          ...loopOpts
        } = opts;
        const artifact = buildRunArtifact({
          runId,
          baseCommitSha: runContext.baseCommitSha,
          basePatchDiff: runContext.basePatchDiff,
          runCommits: runCommitsAccum,
          specRef: feature.relativePath,
          lastFeedback: didSucceed ? undefined : lastErrorFeedback || undefined,
          rules: runContext.rules,
          roundSummaries,
          status: didSucceed ? 'completed' : 'failed',
          opts: loopOpts as BuildRunArtifactOpts,
        });
        const expectedRev = runContext.expectedArtifactRevision;
        await runStorage.saveRun(
          runId,
          artifact,
          expectedRev !== undefined ? { ifRevisionEquals: expectedRev } : undefined,
        );
        if (didSucceed) {
          consola.log(`[orchestrator] Run artifact saved (completed). Run ID: ${runId}`);
        } else {
          consola.log(
            `[orchestrator] Run artifact saved (failed). Start again with: saifctl run start ${runId}`,
          );
        }
      } catch (err) {
        if (err instanceof StaleArtifactError) {
          consola.warn(`[orchestrator] ${err.message}`);
        } else {
          consola.warn('[orchestrator] Failed to save run state:', err);
        }
      }
    }
    if (!sandboxDestroyed) {
      await destroySandbox(sandbox.sandboxBasePath);
    }
    registry.clearEmergencySandboxPath();
  };

  // Wrapper for the main loop so we can derive didSucceed from returned value and cleanup on error.
  const withCleanup = async (fn: () => Promise<OrchestratorResult>) => {
    let didSucceed = false;
    try {
      const result = await fn();
      didSucceed = result.success;
      return result;
    } finally {
      await cleanupAndSaveRun({ didSucceed });
    }
  };

  let errorFeedback = initialErrorFeedback ?? '';
  let attempts = 0;
  let sandboxDestroyed = false;

  return await withCleanup(async () => {
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
          overrides,
          verbose,
          targetBranch,
          startCommit: runContext?.baseCommitSha?.trim() || undefined,
        });
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;

        return {
          success: true,
          attempts: 1,
          runId,
          message: 'Stored run verified; patch applied to host repository.',
        };
      }

      if (verifyOnly.kind === 'aborted') {
        consola.log('\n[orchestrator] Tests aborted.');
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;
        return {
          success: false,
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
        success: false,
        attempts: 1,
        runId,
        message: `Tests failed after ${verifyOnly.testAttempts} run(s). Last error:\n${feedback}`,
      };
    }

    while (attempts < maxRuns) {
      attempts++;
      consola.log(`\n[orchestrator] ===== ATTEMPT ${attempts}/${maxRuns} (run ${runId}) =====`);

      const attemptStartedAt = new Date().toISOString();

      const preRoundHead = (
        await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
      ).trim();

      // Part of real-time human feedback:
      // Refresh the Run artifact on each attempt (outer loop), so that if new Run rules
      // were created while tests ran on the previous attempt, we detect them and include them
      // in the task prompt for next inner round.
      if (runStorage && runContext) {
        const freshArtifact = await runStorage.getRun(runId);
        if (freshArtifact) {
          runContext.rules = reconcileRunRulesWithStorage({
            inMemory: runContext.rules,
            fromStorage: freshArtifact.rules ?? [],
          });
          if (freshArtifact.artifactRevision !== undefined) {
            runContext.expectedArtifactRevision = freshArtifact.artifactRevision;
          }
        }
      }

      // Some rules are marked as "once" and should be consumed after the coding round.
      // Thus these rules are included in the task prompt only on the first round.
      const onceIdsThisRound = runContext ? activeOnceRuleIds(runContext.rules) : [];
      const task = await buildInitialTask({
        feature,
        saifDir,
        rules: runContext ? rulesForPrompt(runContext.rules) : [],
      });

      // 1. Run agent (fresh context every iteration — Ralph Wiggum)
      //    The coding engine sets up its network + compose services, runs the agent,
      //    then tears itself down, regardless of outcome.
      const codingRunId = `${sandbox.runId}-coding-${attempts}`;
      const codingEngine = createEngine(codingEnvironment);
      registry?.registerEngine(codingEngine, codingRunId);

      let innerRounds: InnerRoundSummary[] = [];

      // Part of real-time human feedback:
      // Poll the saved Run artifact for new active rules and append them to the pending-rules file
      // so we can include them in the task prompt for the next inner round.
      const rulesWatcher = (() => {
        if (!runStorage || !runContext) return null;
        const rc = runContext;
        const knownRuleIds = new Set(
          runContext ? rulesForPrompt(runContext.rules).map((r) => r.id) : [],
        );
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
        });
      })();

      try {
        await codingEngine.setup({
          runId: codingRunId,
          projectName,
          featureName: feature.name,
          projectDir,
        });

        await prepareRoundsStatsFile(sandbox.sandboxBasePath);
        await preparePendingRulesFile(sandbox.sandboxBasePath);

        const logStrategy = agentProfile.stdoutStrategy;
        const { onAgentStdout, onAgentStdoutEnd } = createAgentStdoutPipe({
          stdoutStrategy: logStrategy,
          onAgentLog: createDefaultAgentLog({
            linePrefix: 'agent',
            stdoutStrategy: logStrategy,
          }),
        });

        const taskPrompt = await buildTaskPrompt({
          codePath: sandbox.codePath,
          task,
          saifDir,
          feature,
          errorFeedback,
        });

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
        });

        await codingEngine.runAgent({
          codePath: sandbox.codePath,
          sandboxBasePath: sandbox.sandboxBasePath,
          containerEnv,
          dangerousNoLeash,
          cedarPolicyPath,
          coderImage,
          saifctlPath: sandbox.saifctlPath,
          onAgentStdout,
          onAgentStdoutEnd,
          onLog: defaultEngineLog,
          reviewer: reviewer ? { argusBinaryPath: reviewer.argusBinaryPath } : null,
        });

        innerRounds = await readInnerRounds(roundsStatsPath(sandbox.sandboxBasePath));
      } finally {
        rulesWatcher?.stop();
        registry?.deregisterEngine(codingEngine);
        await codingEngine.teardown({ runId: codingRunId });
      }

      // Mark once rules as consumed if they were used this round, then persist so storage
      // stays authoritative before the next reconcile (start of next outer attempt).
      if (runContext && onceIdsThisRound.length > 0) {
        markOnceRulesConsumed(runContext.rules, onceIdsThisRound);
        await saveRunningArtifact('consumed rules');
      }

      // 2. Extract incremental patch(es) for this round (one RunCommit per sandbox commit + optional WIP).
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

      // 3. Mutual Verification (with test retries for flaky environments)
      const verify = await runStagingTestVerification({
        sandbox,
        orchestratorOpts: opts,
        registry,
        testRunnerOpts,
        outerAttempt: attempts,
      });

      if (verify.kind === 'passed') {
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

        // 4. Success path
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
          overrides,
          verbose,
          targetBranch,
          startCommit: runContext?.baseCommitSha?.trim() || undefined,
        });
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;

        return {
          success: true,
          attempts,
          runId,
          message: `Feature implemented successfully in ${attempts} attempt(s).`,
        };
      }

      if (verify.kind === 'aborted') {
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

        consola.log(`\n[orchestrator] Tests aborted after ${attempts} attempt(s).`);
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
          success: false,
          attempts,
          message: `Tests were aborted after ${attempts} attempt(s).`,
        };
      }

      // Exhausted test retries — treat as genunine failure and send feedback to the agent.
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

    // Max attempts reached
    consola.error(`\n[orchestrator] Max runs (${maxRuns}) reached without success.`);

    return {
      success: false,
      attempts,
      runId,
      message: `Failed after ${maxRuns} runs. Last error:\n${errorFeedback}`,
    };
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
  /** CLI-level model overrides — forwarded to vague-specs-check and tests pipeline. */
  overrides: ModelOverrides;
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
  const { projectDir, feature, testSuites, resolveAmbiguity, testProfile, projectName, overrides } =
    opts;

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
    overrides,
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
      overrides,
    });
    await generateTests({ feature, testProfile, overrides });
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
  saifDir: string;
  /** User rules to inject (already filtered and orderedempty to skip section. */
  rules: readonly RunRule[];
}

export async function buildInitialTask(opts: BuildInitialTaskOpts): Promise<string> {
  const { feature, saifDir, rules } = opts;
  const planPath = join(feature.absolutePath, 'plan.md');
  const specPath = join(feature.absolutePath, 'specification.md');

  const parts = [
    `Implement the feature '${feature.name}' as described in the plan below.`,
    `Write code in the /workspace directory. Do NOT modify files in the /${saifDir}/ directory.`,
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
    `  Agent secret file(s): ${opts.agentSecretFiles.join(', ') || 'none'} (KEY=value .env format; re-read when starting from a stored run)`,
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
