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
  type RunSubtask,
  type RunSubtaskInput,
  SAIFCTL_PAUSE_ABORT_REASON,
  SAIFCTL_STOP_ABORT_REASON,
  StaleArtifactError,
} from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import {
  cleanupFindingsForFixRow,
  ensureCriticFindingsParentDir,
} from '../specs/phases/critic-findings.js';
import { createSandboxFileResolver, renderCriticPrompt } from '../specs/phases/critic-prompt.js';
import type { TestProfile } from '../test-profiles/types.js';
import type { CleanupRegistry } from '../utils/cleanup.js';
import { git, gitClean, gitResetHard } from '../utils/git.js';
import { appendUtf8, pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { AGENT_WORKSPACE_CONTAINER, AGENT_WORKSPACE_HOST, buildTaskPrompt } from './agent-task.js';
import { runVagueSpecsChecker } from './agents/vague-specs-check.js';
import type { OrchestratorOpts } from './modes.js';
import { formatImmutableViolations, inspectImmutableTestChanges } from './mutability-check.js';
import { applyPatchToHost } from './phases/apply-patch.js';
import { runCodingPhase } from './phases/run-coding-phase.js';
import { applySandboxExtractToHost, type SandboxExtractMode } from './phases/sandbox-extract.js';
import type { SubtaskCodingResult, SubtaskDriverAction } from './phases/subtask-driver-types.js';
import { loadPhaseSpecFilenames, surfaceModifiedPathsAfterRound } from './post-round-warnings.js';
import {
  destroySandbox,
  extractIncrementalRoundPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  prepareSubtaskSignalDir,
  type Sandbox,
  updateSandboxSubtaskScripts,
} from './sandbox.js';
import { buildOuterAttemptSummary } from './stats.js';
import {
  type ResolvedSubtaskTestScope,
  resolveSubtaskTestScope,
  synthesizeMergedTestsDir,
} from './test-scope.js';

/**
 * Builds `extractPatch` exclude rules: fixed guardrails plus optional caller rules.
 *
 * By default excludes:
 * - `{saifctlDir}/**` — reward-hacking prevention (agent must not modify its own test specs).
 * - `.git/hooks/**` — prevents a malicious patch from installing hooks that execute on the host
 *   when the orchestrator runs `git commit` in applyPatchToHost.
 * - `.saifctl/**` — factory-internal workspace state (e.g. per-round task file), not product code.
 *
 * When {@link BuildPatchExcludeRulesOpts#allowSaifctlInPatch} is true, the `{saifctlDir}/**` rule
 * is omitted (POC runs that write spec files under saifctl/features/).
 */
export interface BuildPatchExcludeRulesOpts {
  saifctlDir: string;
  patchExclude?: PatchExcludeRule[];
  allowSaifctlInPatch?: boolean;
}

/**
 * Returns the standard patch-exclude rule set ({@link saifctlDir}, `.git/hooks/`,
 * `.saifctl/`) plus any caller-supplied rules. See module docstring for rationale.
 */
export function buildPatchExcludeRules(opts: BuildPatchExcludeRulesOpts): PatchExcludeRule[] {
  const { saifctlDir, patchExclude, allowSaifctlInPatch } = opts;
  const base: PatchExcludeRule[] = [];
  if (!allowSaifctlInPatch) {
    base.push({ type: 'glob', pattern: `${saifctlDir}/**` });
  }
  base.push(
    { type: 'glob', pattern: '.git/hooks/**' },
    { type: 'glob', pattern: '.saifctl/**' },
    ...(patchExclude ?? []),
  );
  return base;
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
   * When true, do not exclude `{saifctlDir}/**` from extracted patches so commits
   * touching saifctl (e.g. POC designer output) are recorded on the Run.
   * Default: false.
   */
  allowSaifctlInPatch?: boolean;
  /**
   * Subtask inputs for this run (resolved from plan/spec, `subtasks.json`, or `--subtasks`).
   * Run rules are appended to the active subtask’s {@link RunSubtaskInput#content} each outer attempt
   * via {@link resolveIterativeLoopTaskFromSubtask}.
   */
  subtasks: RunSubtaskInput[];
  /** 0-based index into {@link subtasks} / runtime {@link RunSubtask} rows for the active unit of work. */
  currentSubtaskIndex: number;
  /**
   * When true, injects `SAIFCTL_ENABLE_SUBTASK_SEQUENCE` and subtask signal paths so `coder-start.sh`
   * stays alive between subtasks. Set from `subtasks.length > 1` in {@link resolveOrchestratorOpts}.
   */
  enableSubtaskSequence: boolean;
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
   * Block 7 (§5.6): project-wide default for `tests.mutable`. `true` (default)
   * keeps feature/phase test dirs immutable unless overridden; `false` flips
   * the default to mutable. Resolved via `--strict` / `--no-strict` →
   * `defaults.strict` → built-in default `true`. `saifctl/tests/` stays
   * immutable regardless.
   */
  strict: boolean;
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
   * When true, skip the staging container and test runner after the agent finishes.
   *
   * Used by `saifctl sandbox` and the POC designer.
   */
  skipStagingTests?: boolean;
  /**
   * When {@link skipStagingTests} is true, how to apply extracted commits to the host working tree.
   *
   * Default: `'none'`.
   */
  sandboxExtract?: SandboxExtractMode;
  /**
   * Repo-relative path prefix to keep when `sandboxExtract` is `'host-apply-filtered'`.
   */
  sandboxExtractInclude?: string;
  /**
   * Repo-relative path prefix to exclude when `sandboxExtract` is `'host-apply-filtered'`.
   */
  sandboxExtractExclude?: string;
  /**
   * Internal: set by `runInspect` to run an idle container (`sleep infinity`) instead of the
   * coding agent. Threaded through to {@link RunAgentOpts#inspectMode}.
   */
  inspectMode?: RunAgentOpts['inspectMode'];
  /**
   * When true, the container runs `sandbox-start.sh` (startup + agent-install, then sleep) instead
   * of `coder-start.sh`. Task/gate/subtask env vars are omitted from the container environment.
   * Set by `sandbox --interactive`. Combined with `inspectMode` to use the idle container + exec pattern.
   */
  sandboxInteractive?: boolean;
}

/** Outcome of {@link runIterativeLoop} and other orchestrator entry points (distinct from stored {@link RunArtifact} status). */
export type OrchestratorOutcomeStatus = 'success' | 'failed' | 'paused' | 'stopped';

/** Final outcome returned by every orchestrator entry point ({@link runStart}, {@link fromArtifact}, etc.). */
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

/**
 * Mutable per-run state the iterative loop reads/writes for resume semantics:
 * git base for replay, accumulating user rules, last error feedback, and the
 * optimistic-locking revision used for run-storage saves.
 */
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

/**
 * The shared inner orchestration loop used by `start` and `fromArtifact` modes.
 * Drives outer attempts: run the coding agent, extract the patch, run staging
 * tests (with vague-specs handling), then either apply to the host or feed
 * stderr back as feedback for the next round. Honours pause / stop / abort
 * routing via {@link OrchestratorOpts.runStorage} and the cleanup registry.
 */
export async function runIterativeLoop(
  sandbox: Sandbox,
  opts: OrchestratorOpts & {
    runContext: RunStorageContext | null;
    /** When starting from a Run: seed the first agent round with this feedback */
    initialErrorFeedback: string | null;
    registry: CleanupRegistry;
    /** Subtask rows persisted on the run artifact (fresh seed or from stored run). */
    loopRunSubtasks: RunSubtask[];
    /** 0-based index into {@link loopRunSubtasks} for the active subtask. */
    loopCurrentSubtaskIndex: number;
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
    testProfile,
    reviewerEnabled,
    codingEnvironment,
    runStorage,
    runContext,
    seedRunCommits,
    seedRoundSummaries,
    initialErrorFeedback,
    testOnly,
    skipStagingTests,
    sandboxExtract: sandboxExtractOpt,
    sandboxExtractInclude,
    sandboxExtractExclude,
    verbose,
    agentSecretKeys,
    agentSecretFiles,
    fromArtifact,
    patchExclude: optsPatchExclude,
    inspectMode,
    sandboxInteractive,
    strict,
    loopRunSubtasks,
    loopCurrentSubtaskIndex,
    gateScript: runGateScriptContent,
  } = opts;

  const runId = sandbox.runId;

  // Block 8 (§9): resolve per-phase spec filename overrides ONCE at loop init.
  // Most projects use the built-in default (`spec.md`), but a project that
  // sets `phases.defaults.spec: SPEC.md` in feature.yml should still have
  // deviations under that filename surfaced. Loading per-round would re-read
  // feature.yml + every phase.yml on a hot path; loading once amortises it.
  // Failures here are non-fatal — the worst case is the classifier falls back
  // to `'spec.md'`, which is the dominant case anyway.
  const phaseSpecFilenames = await loadPhaseSpecFilenames(feature.absolutePath);

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
  // Start from the number of already-completed rounds so attempt numbers are
  // monotonically increasing across multiple 'run start' / 'run resume' calls.
  let attempts = seedRoundSummaries?.length ?? 0;
  let sandboxDestroyed = false;

  /**
   * How many leading {@link runCommitsAccum} entries are already applied to the host via
   * {@link applySandboxExtractToHost}. Seeded from the run artifact when resuming so we do not
   * double-apply after incremental per-subtask extract in sandbox mode.
   */
  let lastExtractedCommitCount = fromArtifact ? fromArtifact.sandboxHostAppliedCommitCount : 0;

  let pauseSnapshotLiveInfra: RunLiveInfra | null = null;

  //////////////////////////////////////////////////
  // Helpers
  //////////////////////////////////////////////////

  // Strip loop-internal fields from opts once; the remainder is safe to persist.
  const {
    registry: _reg,
    runStorage: _rs,
    runContext: _rc,
    fromArtifact: _fa,
    loopRunSubtasks: _lrs,
    loopCurrentSubtaskIndex: _lci,
    ...loopOpts
  } = opts;

  /** Mutable cursor persisted on the artifact while the run progresses. */
  let subtaskCursorIndex = loopCurrentSubtaskIndex;

  const subtaskAttemptNumber = (subtaskIndex: number) =>
    1 + roundSummaries.filter((s) => s.subtaskIndex === subtaskIndex).length;

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
        sandboxHostAppliedCommitCount: lastExtractedCommitCount,
        subtasks: loopRunSubtasks.map((s) => ({ ...s })),
        currentSubtaskIndex: subtaskCursorIndex,
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
    // Per-subtask test scope (Block 2 of TODO_phases_and_critics): the legacy
    // path passes no scope and gets the feature's whole tests/ dir. Phased
    // features (Block 3) emit `testScope` on each subtask; we re-derive the
    // runner opts at every subtask transition so the gate sees only that
    // phase's cumulative test set.
    const refreshTestRunnerOpts = async (): Promise<
      Awaited<ReturnType<typeof prepareTestRunnerOpts>>
    > => {
      const scope = resolveSubtaskTestScope({
        subtasks: loopRunSubtasks,
        currentSubtaskIndex: subtaskCursorIndex,
      });
      return await prepareTestRunnerOpts({
        feature,
        sandboxBasePath: sandbox.sandboxBasePath,
        testScript,
        testProfile,
        testScope: scope.sources.length > 0 ? scope : null,
      });
    };

    let testRunnerOpts = await refreshTestRunnerOpts();

    // Resolve the coder agent's LLM config once per loop.
    const patchExclude = buildPatchExcludeRules({
      saifctlDir,
      patchExclude: optsPatchExclude,
      allowSaifctlInPatch: opts.allowSaifctlInPatch,
    });

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

    // Snapshot HEAD before this coding round: used as the diff base for
    // `extractIncrementalRoundPatch` and as the reset target when staging tests fail
    // (discard this attempt's work without losing earlier rounds or seeded commits).
    let perSubtaskPreRoundHead = (
      await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
    ).trim();
    /**
     * `git rev-parse HEAD` at coding session start — pause/stop commit extraction base.
     * For {@link runCodingPhase} — fixed at session start, not per subtask, so mid-run pause
     * captures every commit since the coding session began (all completed subtasks plus
     * in-progress work). Updating this each subtask would drop earlier subtask commits
     * from the abort snapshot.
     */
    const pausePreRoundHead = perSubtaskPreRoundHead;
    /** "Once" rule ids to consume after the first successful inner completion in this session. */
    let pendingOnceIds = runContext ? activeOnceRuleIds(runContext.rules) : [];

    /** Holder so TS sees assignments from `onSubtaskComplete` (async callback) as observable after `await`. */
    const runTerminal: { result: OrchestratorResult | null } = { result: null };
    const codingAbort = new AbortController();

    /**
     * Block 4: capture the git rev-parse HEAD at the start of each phase's
     * impl subtask. Critics in the same phase render `{{phase.baseRef}}`
     * against this value. Idempotent — only sets when not already set, so
     * resume from `seedSubtasks` (which preserves `phaseBaseRef` on the
     * runtime row) doesn't overwrite a baseRef from a prior session.
     */
    const recordPhaseBaseRefIfImpl = (idx: number, head: string): void => {
      const row = loopRunSubtasks[idx];
      if (!row) return;
      if (row.phaseId && !row.criticPrompt && !row.phaseBaseRef) {
        row.phaseBaseRef = head;
      }
    };
    recordPhaseBaseRefIfImpl(subtaskCursorIndex, perSubtaskPreRoundHead);

    /**
     * Block 4: render a critic subtask's raw `content` (the verbatim
     * `critics/<id>.md` body) into the final prompt by mustache-binding the
     * closed variable set + the runtime `phase.baseRef`.
     *
     * The impl subtask for the same phase carries `phaseBaseRef`. Critics
     * look it up here. Throws loudly if missing — that means the loop saw a
     * critic subtask before its phase's impl ran, which would be a bug in
     * the compiler ordering or a manually-edited subtasks.json.
     */
    const renderCriticContent = (row: RunSubtask): string => {
      if (!row.criticPrompt || !row.phaseId) return row.content;
      const impl = loopRunSubtasks.find((s) => s.phaseId === row.phaseId && !s.criticPrompt);
      const baseRef = impl?.phaseBaseRef;
      if (!baseRef) {
        throw new Error(
          `[orchestrator] Critic subtask '${row.title ?? row.id}' has no captured ` +
            `phase.baseRef for phase '${row.phaseId}'. Phase impl subtask must run ` +
            `(or be seeded from a paused artifact) before critic subtasks render.`,
        );
      }
      return renderCriticPrompt({
        template: row.content,
        vars: {
          feature: row.criticPrompt.vars.feature,
          phase: { ...row.criticPrompt.vars.phase, baseRef },
          critic: {
            id: row.criticPrompt.criticId,
            round: row.criticPrompt.round,
            totalRounds: row.criticPrompt.totalRounds,
            step: row.criticPrompt.step,
            findingsPath: row.criticPrompt.findingsPath,
          },
        },
        // The agent runs in the container with /workspace mounted to
        // sandbox.codePath. `{{> file <p>}}` paths are workspace-relative;
        // the sandbox-aware resolver canonicalises both root and target via
        // realpath and refuses any path that resolves outside the sandbox
        // (blocks symlink-escape reads of host files).
        readFile: createSandboxFileResolver(sandbox.codePath),
      });
    };

    const buildFullSubtaskPrompt = async (row: RunSubtask, err: string): Promise<string> => {
      // Block 4b: ensure the findings-file parent dir exists before any
      // critic subtask runs. The discover step writes
      // `/workspace/.saifctl/critic-findings/<phase>--<critic>--r<n>.md`;
      // an agent that does `cat > path` (no implicit mkdir) would fail
      // silently, and fix would then read a missing file and no-op away
      // the whole critic round. Idempotent + best-effort.
      await ensureCriticFindingsParentDir({ codePath: sandbox.codePath, row });
      const base = await resolveIterativeLoopTaskFromSubtask({
        content: renderCriticContent(row),
        rules: runContext ? rulesForPrompt(runContext.rules) : [],
      });
      return buildTaskPrompt({
        codePath: sandbox.codePath,
        task: base,
        saifctlDir,
        feature,
        errorFeedback: err.trim() ? err : '',
        // `--engine local` runs the agent on the host (cwd: codePath); other
        // engines bind-mount codePath at /workspace inside the coder
        // container. The directive must reference whichever path the agent
        // actually reaches.
        workspace:
          codingEnvironment.engine === 'local' ? AGENT_WORKSPACE_HOST : AGENT_WORKSPACE_CONTAINER,
      });
    };

    const onSubtaskComplete = async (
      completedSubtask: SubtaskCodingResult,
    ): Promise<SubtaskDriverAction> => {
      const { subtaskIndex, innerExitCode, innerRounds } = completedSubtask;

      attempts++;
      const attemptStartedAt = new Date().toISOString();
      consola.log(
        `\n[orchestrator] ===== ATTEMPT ${attempts} (run ${runId}, subtask ${subtaskIndex + 1}/${loopRunSubtasks.length}, subtask attempt ${subtaskAttemptNumber(subtaskIndex)}) =====`,
      );

      if (innerExitCode !== 0) {
        consola.warn(
          `[orchestrator] Subtask ${subtaskIndex + 1} inner loop exited ${innerExitCode} (gate/reviewer exhausted or agent failure). Outer loop will still verify / retry per max runs.`,
        );
      }

      // Part of real-time human feedback and 'run stop' / 'run pause' control signals.
      // To detect if we received some actions from the user, we refresh the Run artifact
      // on each attempt (outer loop). It stores info on pending control signals (pause / stop)
      // or new Run rules that were created during the previous attempt.
      let controlBefore: 'pause' | 'stop' | null = null;
      if (runStorage && runContext) {
        const freshArtifact = await runStorage.getRun(runId);
        if (freshArtifact) {
          // Check for control signals (pause / stop)
          const a = freshArtifact.controlSignal?.action;
          if (a === 'pause' || a === 'stop') {
            controlBefore = a;
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
      if (controlBefore === 'stop') {
        codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
        return { kind: 'abort' };
      }
      if (controlBefore === 'pause') {
        codingAbort.abort(SAIFCTL_PAUSE_ABORT_REASON);
        return { kind: 'abort' };
      }

      // Mark once rules as consumed if they were used this round, then persist so storage
      // stays authoritative before the next reconcile (start of next outer attempt).
      if (runContext && pendingOnceIds.length > 0) {
        markOnceRulesConsumed(runContext.rules, pendingOnceIds);
        pendingOnceIds = [];
        await saveRunningArtifact('consumed rules');
      }

      const st = loopRunSubtasks[subtaskIndex];
      if (!st) {
        runTerminal.result = controlResult(
          'failed',
          `Missing subtask at index ${subtaskIndex} (have ${loopRunSubtasks.length}).`,
        );
        codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
        return { kind: 'abort' };
      }

      // Extract incremental patch(es) for this round
      // (one RunCommit per sandbox commit + optional WIP).
      const { patch: patchContent, commits: roundCommits } = await extractIncrementalRoundPatch(
        sandbox.codePath,
        {
          preRoundHeadSha: perSubtaskPreRoundHead,
          attempt: attempts,
          exclude: patchExclude,
        },
      );

      // Block 7 (§5.6 / §9 "diff-inspection"): if the agent committed anything
      // this round, check whether they touched any test path that resolves as
      // immutable per the three-layer model. We do this BEFORE staging tests
      // run (the agent could otherwise silently rewrite the contract tests
      // they're being judged against). On violations: roll back the round to
      // `perSubtaskPreRoundHead`, send the violation list as feedback, and
      // either retry or abort per the subtask budget — same shape as a
      // staging-test failure.
      if (roundCommits.length > 0) {
        const inspection = await inspectImmutableTestChanges({
          codePath: sandbox.codePath,
          projectDir,
          saifctlDir,
          featureAbsolutePath: feature.absolutePath,
          projectDefaultStrict: strict,
          preRoundHead: perSubtaskPreRoundHead,
        });

        // Block 8 (§9 "modification-surfacing warning"): independent of the
        // mutability gate above, surface any plan/spec/test modifications to
        // the run log + a per-run JSONL breadcrumb. Fire this BEFORE the
        // violation branch so warnings persist even when the round will be
        // rolled back — the user wants to see attempted deviations, not just
        // the ones that survived the gate. `inspection.changedPaths` is the
        // same `git diff --name-only` shape the warning module expects, so
        // we reuse it instead of re-shelling out to git.
        await surfaceModifiedPathsAfterRound({
          round: attempts,
          subtaskIndex,
          phaseId: st.phaseId ?? null,
          criticId: st.criticPrompt?.criticId ?? null,
          changedPaths: inspection.changedPaths,
          saifctlDir,
          featureRelativePath: feature.relativePath.replaceAll('\\', '/'),
          phaseSpecFilenames,
          projectDir,
          runId,
        });

        if (inspection.violations.length > 0) {
          const msg = formatImmutableViolations(inspection.violations);
          consola.error(`\n[orchestrator] ${msg}`);
          errorFeedback = msg;
          lastErrorFeedback = errorFeedback;
          if (runContext) runContext.lastErrorFeedback = errorFeedback;

          roundSummaries = [
            ...roundSummaries,
            buildOuterAttemptSummary({
              attempt: attempts,
              subtaskIndex,
              subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
              phase: 'tests_failed',
              innerRounds,
              commitCount: roundCommits.length,
              patchBytes: patchContent.length,
              errorFeedback,
              startedAt: attemptStartedAt,
            }),
          ];
          await saveRoundProgress();

          // Reset round commits from this attempt — same rollback the
          // staging-test-failure path uses below.
          await gitResetHard({ cwd: sandbox.codePath, ref: perSubtaskPreRoundHead });
          await gitClean({ cwd: sandbox.codePath });

          if (subtaskAttemptNumber(subtaskIndex) > maxRuns) {
            consola.error(
              `\n[orchestrator] Max attempts (${maxRuns}) reached for subtask ${subtaskIndex + 1}/${loopRunSubtasks.length} due to immutable-test violations.`,
            );
            runTerminal.result = controlResult(
              'failed',
              `Subtask ${subtaskIndex + 1} failed: agent persistently modified immutable test files.\n${msg}`,
            );
            codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
            return { kind: 'abort' };
          }
          return {
            kind: 'retry',
            prompt: await buildFullSubtaskPrompt(st, errorFeedback),
          };
        }
      }

      // Detect if there has been any changes made to the sandbox by the agent.
      // Previously we checked only the current patch, but changes may be already committed.
      // So to truly know if no changes were made, we need to also look at the sandbox history.
      const roundCommitCount = roundCommits.length;
      const roundPatchEmpty = roundCommitCount === 0 || !patchContent.trim();
      const hasPriorWorkInSandbox = await sandboxHasCommitsBeyondInitialImport(sandbox.codePath);

      // No changes whatsoever - no patch, no commits
      if (roundPatchEmpty && !hasPriorWorkInSandbox) {
        consola.warn('[orchestrator] Agent produced no changes (empty patch). Skipping tests.');

        // Sandbox mode may make no changes in the container (e.g. user just needed
        // to run a non-coding agent in isolation).
        // So we return early with a success status.
        if (skipStagingTests && subtaskIndex === loopRunSubtasks.length - 1) {
          roundSummaries = [
            ...roundSummaries,
            buildOuterAttemptSummary({
              attempt: attempts,
              subtaskIndex,
              subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
              phase: 'no_changes',
              innerRounds,
              commitCount: 0,
              patchBytes: 0,
              errorFeedback: '',
              startedAt: attemptStartedAt,
            }),
          ];
          await saveRoundProgress();
          runTerminal.result = {
            status: 'success',
            attempts,
            runId,
            message: 'Sandbox run complete (no git changes).',
          };
          return { kind: 'exit' };
        }

        const innerHint =
          innerExitCode !== 0
            ? `Inner validation did not complete successfully (exit ${innerExitCode}). `
            : '';
        errorFeedback =
          innerHint +
          'No changes were made. Please implement the feature as described in the plan.';
        lastErrorFeedback = errorFeedback;
        if (runContext) {
          runContext.lastErrorFeedback = errorFeedback;
        }

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            subtaskIndex,
            subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
            phase: 'no_changes',
            innerRounds,
            commitCount: 0,
            patchBytes: 0,
            errorFeedback,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();

        // Empty patch on this outer attempt: fail if budget for this subtask is exhausted; else retry.
        if (subtaskAttemptNumber(subtaskIndex) > maxRuns) {
          consola.error(
            `\n[orchestrator] Max attempts (${maxRuns}) reached for subtask ${subtaskIndex + 1}/${loopRunSubtasks.length} without success.`,
          );
          runTerminal.result = controlResult(
            'failed',
            `Subtask ${subtaskIndex + 1} failed after ${subtaskAttemptNumber(subtaskIndex)} attempt(s). Last error:\n${errorFeedback}`,
          );
          codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
          return { kind: 'abort' };
        }
        return {
          kind: 'retry',
          prompt: await buildFullSubtaskPrompt(st, errorFeedback),
        };
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
        if (patchPaths.length === 0 && patchContent.trim()) {
          consola.warn(
            '[orchestrator] No paths parsed from patch diff --git headers — patch may be malformed or empty of file sections.',
          );
        } else if (patchPaths.length > 0) {
          consola.log(
            `[orchestrator] Files in patch content (${patchPaths.length}): ${patchPaths.join(', ')}`,
          );
        }
      }

      //////////////////////////////////////////////////
      // Sandbox mode: skip staging + tests; optional git apply to host
      //////////////////////////////////////////////////

      if (skipStagingTests) {
        consola.log('\n[orchestrator] Sandbox mode — skipping staging tests.');
        const extractMode = sandboxExtractOpt ?? 'none';

        /** Apply only commits not yet on the host (`git apply` is not idempotent across the full list). */
        const applyIncrementalHostExtract = async (): Promise<void> => {
          if (extractMode !== 'host-apply' && extractMode !== 'host-apply-filtered') return;
          const newCommits = runCommitsAccum.slice(lastExtractedCommitCount);
          if (newCommits.length === 0) return;
          const ok = await applySandboxExtractToHost({
            runCommits: newCommits,
            projectDir,
            runId,
            mode: extractMode,
            includePrefix: sandboxExtractInclude,
            excludePrefix: sandboxExtractExclude,
          });
          if (ok) {
            lastExtractedCommitCount = runCommitsAccum.length;
            try {
              await writeUtf8(
                join(sandbox.sandboxBasePath, 'sandbox-host-applied-commit-count.txt'),
                `${lastExtractedCommitCount}\n`,
              );
            } catch {
              // best-effort — Ctrl+C save may still read prior artifact count
            }
          }
        };

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            subtaskIndex,
            subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
            phase: roundPatchEmpty ? 'no_changes' : 'sandbox_complete',
            innerRounds,
            commitCount: roundCommits.length,
            patchBytes: patchContent.length,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();

        // Multi-subtask sandbox: advance cursor, reset incremental patch base, refresh "once" rules — driver returns `next` with new scripts/prompt.
        const nextIdx = subtaskIndex + 1;
        if (nextIdx < loopRunSubtasks.length) {
          subtaskCursorIndex = nextIdx;
          const nextSt = loopRunSubtasks[nextIdx];
          if (!nextSt) {
            runTerminal.result = controlResult(
              'failed',
              `Missing subtask at index ${nextIdx} (have ${loopRunSubtasks.length}).`,
            );
            codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
            return { kind: 'abort' };
          }
          await applyIncrementalHostExtract();
          perSubtaskPreRoundHead = (
            await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
          ).trim();
          recordPhaseBaseRefIfImpl(subtaskCursorIndex, perSubtaskPreRoundHead);
          pendingOnceIds = runContext ? activeOnceRuleIds(runContext.rules) : [];
          return {
            kind: 'next',
            gateScript: nextSt.gateScript ?? runGateScriptContent,
            agentScript: nextSt.agentScript,
            gateRetries: nextSt.gateRetries,
            prompt: await buildFullSubtaskPrompt(nextSt, ''),
          };
        }

        await applyIncrementalHostExtract();
        runTerminal.result = {
          status: 'success',
          attempts,
          runId,
          message:
            extractMode !== 'none'
              ? 'Sandbox run complete; host working tree updated where applicable.'
              : 'Sandbox run complete (no staging tests; no host apply).',
        };
        return { kind: 'exit' };
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
        consola.log('\n[orchestrator] ✓ ALL TESTS PASSED — staging complete for this subtask');

        // Block 4b: orchestrator-owned findings-file lifecycle. Earlier
        // drafts had the BUILTIN_FIX_TEMPLATE delete the file before
        // verifying tests, which silently lost data on the test-failure-
        // then-retry path (file gone, retry reads missing → no-op).
        // Saifctl deletes after the fix subtask passes its gate; on
        // failure we leave the file in place so the retry sees the same
        // findings. No-op for non-fix rows.
        await cleanupFindingsForFixRow({ codePath: sandbox.codePath, row: st });

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            subtaskIndex,
            subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
            phase: 'tests_passed',
            innerRounds,
            commitCount: roundCommits.length,
            patchBytes: patchContent.length,
            startedAt: attemptStartedAt,
          }),
        ];
        await saveRoundProgress();

        const nextIdx = subtaskIndex + 1;
        if (nextIdx < loopRunSubtasks.length) {
          subtaskCursorIndex = nextIdx;
          const nextSt = loopRunSubtasks[nextIdx];
          if (!nextSt) {
            runTerminal.result = controlResult(
              'failed',
              `Missing subtask at index ${nextIdx} (have ${loopRunSubtasks.length}).`,
            );
            codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
            return { kind: 'abort' };
          }
          perSubtaskPreRoundHead = (
            await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })
          ).trim();
          recordPhaseBaseRefIfImpl(subtaskCursorIndex, perSubtaskPreRoundHead);
          pendingOnceIds = runContext ? activeOnceRuleIds(runContext.rules) : [];
          // Per-subtask test scope (Block 2): refresh testsDir for the next
          // subtask. Legacy / no-scope subtasks fall back to feature/tests/.
          testRunnerOpts = await refreshTestRunnerOpts();
          return {
            kind: 'next',
            gateScript: nextSt.gateScript ?? runGateScriptContent,
            agentScript: nextSt.agentScript,
            gateRetries: nextSt.gateRetries,
            prompt: await buildFullSubtaskPrompt(nextSt, ''),
          };
        }

        runTerminal.result = {
          status: 'success',
          attempts,
          runId,
          message: `Feature implemented successfully in ${attempts} attempt(s).`,
        };
        return { kind: 'exit' };
      }

      // Tests aborted - discard this attempt's work and reset to the pre-round HEAD
      if (verify.kind === 'aborted') {
        consola.log(`\n[orchestrator] Tests aborted after ${attempts} attempt(s).`);

        roundSummaries = [
          ...roundSummaries,
          buildOuterAttemptSummary({
            attempt: attempts,
            subtaskIndex,
            subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
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
        runTerminal.result = {
          status: 'failed',
          attempts,
          runId,
          message: `Tests were aborted after ${attempts} attempt(s).`,
        };
        codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
        return { kind: 'abort' };
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
          subtaskIndex,
          subtaskAttempt: subtaskAttemptNumber(subtaskIndex),
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
      await gitResetHard({ cwd: sandbox.codePath, ref: perSubtaskPreRoundHead });
      await gitClean({ cwd: sandbox.codePath });

      // Staging failed after rollback: stop if per-subtask attempt budget is exhausted; else retry.
      if (subtaskAttemptNumber(subtaskIndex) > maxRuns) {
        consola.error(
          `\n[orchestrator] Max attempts (${maxRuns}) reached for subtask ${subtaskIndex + 1}/${loopRunSubtasks.length} without success.`,
        );
        runTerminal.result = controlResult(
          'failed',
          `Subtask ${subtaskIndex + 1} failed after ${subtaskAttemptNumber(subtaskIndex)} attempt(s). Last error:\n${errorFeedback}`,
        );
        codingAbort.abort(SAIFCTL_STOP_ABORT_REASON);
        return { kind: 'abort' };
      }

      return {
        kind: 'retry',
        prompt: await buildFullSubtaskPrompt(st, errorFeedback),
      };
    };

    // Sync control + rules from storage, then exit early if user asked pause/stop before another coding phase.
    {
      let controlBeforeRound: 'pause' | 'stop' | null = null;
      if (runStorage && runContext) {
        const freshArtifact = await runStorage.getRun(runId);
        if (freshArtifact) {
          const a = freshArtifact.controlSignal?.action;
          if (a === 'pause' || a === 'stop') controlBeforeRound = a;
          runContext.rules = reconcileRunRulesWithStorage({
            inMemory: runContext.rules,
            fromStorage: freshArtifact.rules ?? [],
          });
          if (freshArtifact.artifactRevision !== undefined) {
            runContext.expectedArtifactRevision = freshArtifact.artifactRevision;
          }
        }
      }
      if (controlBeforeRound === 'stop')
        return controlResult('stopped', 'Run stopped by request (before coding round).');
      if (controlBeforeRound === 'pause')
        return controlResult('paused', 'Run paused by request (before coding round).');
    }

    // Current subtask row for this outer iteration; push its gate/agent scripts and clear signal files (non-inspect).
    const activeRow = loopRunSubtasks[subtaskCursorIndex];
    if (!activeRow) {
      throw new Error(
        `[orchestrator] No subtask at index ${subtaskCursorIndex} (have ${loopRunSubtasks.length}).`,
      );
    }

    if (!inspectMode) {
      await updateSandboxSubtaskScripts({
        saifctlPath: sandbox.saifctlPath,
        gateScript: activeRow.gateScript ?? runGateScriptContent,
        agentScript: activeRow.agentScript,
      });

      await prepareSubtaskSignalDir(sandbox.sandboxBasePath);
    }

    //////////////////////////////////////////////////
    // Run agent
    //////////////////////////////////////////////////

    const task = await buildFullSubtaskPrompt(activeRow, errorFeedback);

    // Run agent (fresh context every iteration — Ralph Wiggum)
    // The coding engine sets up its network + compose services, runs the coder agent,
    // then tears itself down (or pauses) depending on control signals.
    const codingResult = await runCodingPhase({
      sandbox,
      attempt: attempts + 1,
      errorFeedback,
      task,
      subtasks: loopRunSubtasks.slice(subtaskCursorIndex),
      startSubtaskIndex: subtaskCursorIndex,
      onSubtaskComplete: inspectMode ? async () => ({ kind: 'abort' as const }) : onSubtaskComplete,
      resumedCodingInfra,
      storage: runStorage && runContext ? { runStorage, runContext } : null,
      registry: registry ?? null,
      preRoundHeadSha: pausePreRoundHead,
      patchExclude,
      codingAbortController: codingAbort,
      signal: codingAbort.signal,
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
        sandboxInteractive,
        // Matches shell `SAIFCTL_ENABLE_SUBTASK_SEQUENCE`: driver + exit/next signaling whenever
        // we run a real coding session (inspect uses an idle container, no subtask protocol).
        enableSubtaskSequence: !inspectMode,
      },
    });

    resumedCodingInfra = null;

    // Terminal outcome set inside `onSubtaskComplete` (success/fail/stop): full runs apply commits to host; success always destroys the sandbox here.
    if (runTerminal.result) {
      const done = runTerminal.result;
      if (done.status === 'success' && !skipStagingTests) {
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
      }
      if (done.status === 'success') {
        await destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;
      }
      return done;
    }

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

    return controlResult(
      'failed',
      `Coding phase ended without success. Last error:\n${errorFeedback || lastErrorFeedback || '(none)'}`,
    );
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

/**
 * Builds the agent task string for one outer attempt: subtask body plus optional run rules
 * (same “User feedback” section shape as before).
 */
export async function resolveIterativeLoopTaskFromSubtask(opts: {
  content: string;
  rules: readonly RunRule[];
}): Promise<string> {
  const body = opts.content.trim();
  const parts = [body];
  if (opts.rules.length > 0) {
    parts.push('', '## User feedback', '');
    for (const r of opts.rules) {
      const label = r.scope === 'once' ? '(this round only)' : '(always)';
      parts.push(`- [${label}] ${r.content}`);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities (used by loop and by modes)
// ---------------------------------------------------------------------------

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
  /**
   * Active test profile. Used by the multi-source merger to know which
   * helpers/infra/example filenames to materialize per-source label.
   */
  testProfile: TestProfile;
  /**
   * Per-subtask test scope (Block 2 of TODO_phases_and_critics).
   *
   * - `null` / omitted: legacy behavior — gate runs the feature's whole
   *   `tests/` dir.
   * - `{ sources: [...] }` from {@link resolveSubtaskTestScope}: gate runs
   *   only the listed source dirs (single-source short-circuit, multi-source
   *   merged via symlinks under `<sandbox>/test-scope/`).
   *
   * `testScript` is unaffected by scope.
   */
  testScope?: ResolvedSubtaskTestScope | null;
}

/**
 * Prepares the test runner filesystem inputs for a feature run.
 *
 * Returns `testsDir` (the tests/ directory the runner should bind-mount —
 * either the feature's `tests/`, a single phase's `tests/`, or a synthesized
 * merged dir under the sandbox), `reportDir` (sandbox root, so that
 * `runTests` can find results.xml at `{sandboxRoot}/results.xml`), and
 * `testScriptPath` (always set — written from DEFAULT_TEST_SCRIPT or a
 * custom override).
 *
 * Spec files are expected to already exist — generated by `saifctl feat design`.
 *
 * Per-subtask scope is honored via `testScope`. Without phase-compiled
 * subtasks (legacy / non-phased path), `testScope` is omitted and the
 * function returns `<feature>/tests/` exactly as before. With phases, the
 * caller must call this function fresh at every subtask transition (the
 * loop does this — see the `refreshTestRunnerOpts` closure inside
 * `runIterativeLoop`).
 */
export async function prepareTestRunnerOpts({
  feature,
  sandboxBasePath,
  testScript,
  testProfile,
  testScope,
}: PrepareTestRunnerOptsArgs): Promise<
  Pick<RunTestsOpts, 'testsDir' | 'reportDir' | 'testScriptPath'>
> {
  let testsDir: string;
  if (testScope && testScope.sources.length > 0) {
    testsDir = await synthesizeMergedTestsDir({
      sources: testScope.sources,
      destDir: join(sandboxBasePath, 'test-scope-merged'),
      testProfile,
    });
    consola.log(
      `[orchestrator] testsDir scoped to ${testScope.sources.length} source(s); resolved to ${testsDir}`,
    );
  } else {
    testsDir = join(feature.absolutePath, 'tests');
  }

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
  if (opts.skipStagingTests) {
    const ex = opts.sandboxExtract ?? 'none';
    consola.log(`  Sandbox mode: skip staging tests (sandboxExtract=${ex})`);
  }
}
