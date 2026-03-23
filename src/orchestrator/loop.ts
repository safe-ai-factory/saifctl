/**
 * Iterative agent loop and related utilities.
 * Used by mode 'start' (and 'resume' via runStartCore).
 */

import { join } from 'node:path';

import { isCancel, text } from '@clack/prompts';

import type {
  NormalizedCodingEnvironment,
  NormalizedStagingEnvironment,
} from '../config/schema.js';
import { getSaifRoot } from '../constants.js';
import { runDesignTests } from '../design-tests/design.js';
import { TestCatalogSchema } from '../design-tests/schema.js';
import { generateTests } from '../design-tests/write.js';
import type { GitProvider } from '../git/types.js';
import { type ModelOverrides, resolveAgentLlmConfig } from '../llm-config.js';
import { consola } from '../logger.js';
import { createProvisioner } from '../provisioners/index.js';
import {
  type AssertionSuiteResult,
  type RunTestsOpts,
  type TestsResult,
} from '../provisioners/types.js';
import type { RunStorage } from '../runs/types.js';
import { buildRunArtifact, type BuildRunArtifactOpts } from '../runs/utils/artifact.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import type { TestProfile } from '../test-profiles/types.js';
import type { CleanupRegistry } from '../utils/cleanup.js';
import { gitApply, gitClean, gitResetHard } from '../utils/git.js';
import { appendUtf8, pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { runVagueSpecsChecker } from './agents/vague-specs-check.js';
import { applyPatchToHost } from './phases/apply-patch.js';
import {
  destroySandbox,
  extractPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  type Sandbox,
} from './sandbox.js';
import { getArgusBinaryPath } from './sidecars/reviewer/argus.js';

// ---------------------------------------------------------------------------
// Shared: Iterative Loop (used by 'start' and 'continue')
// ---------------------------------------------------------------------------

/**
 * Options used by runIterativeLoop (modes 'start' and 'resume').
 */
export interface IterativeLoopOpts {
  /** Sandbox profile id (e.g. 'node-pnpm-python'). Used to resolve Dockerfile.coder for the staging container when tests.json does not specify build.dockerfile. */
  sandboxProfileId: SupportedSandboxProfileId;
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
   * Saifac directory name relative to repo root (e.g. 'saifac').
   * Resolved by caller (e.g. agents CLI parseSaifDir).
   */
  saifDir: string;
  /**
   * Project name prefix for sandbox directory names (e.g. 'crawlee-one').
   * Resolved by caller (e.g. agents CLI parseProjectName from -p/--project or package.json).
   */
  projectName: string;
  /**
   * Test Docker image tag (default: 'saifac-test-<profileId>:latest').
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
   * When true, skip Leash and run coding agent directly on the host.
   * Isolation is filesystem-only (rsync sandbox). No Cedar enforcement.
   * Default: false (Leash is enabled by default).
   */
  dangerousDebug: boolean;
  /**
   * Absolute path to a Cedar policy file for Leash.
   *
   * Defaults to default.cedar in src/orchestrator/policies/.
   * Ignored when dangerousDebug=true.
   */
  cedarPolicyPath: string;
  /**
   * Docker image for the coder container.
   * Resolved from the sandbox profile (default: node-pnpm-python). Override via --coder-image.
   * Ignored when dangerousDebug=true.
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
   * Git hosting provider to use for push URL resolution and PR creation.
   *
   * The required auth token is read from the corresponding env var (e.g. GITHUB_TOKEN).
   */
  gitProvider: GitProvider;
  /**
   * Maximum number of gate retries (agent → gate → feedback) per run.
   * Forwarded as SAIFAC_GATE_RETRIES to coder-start.sh.
   *
   * Resolved by the CLI: defaults to 10 when --gate-retries is not set.
   */
  gateRetries: number;
  /**
   * Extra environment variables to forward into the agent container (Leash mode)
   * or inject into the host process env (--dangerous-debug mode).
   *
   * Parsed from --agent-env KEY=VALUE flags and --agent-env-file <path> by the CLI.
   * Reserved factory variables (SAIFAC_*, LLM_*, REVIEWER_LLM_*) are silently filtered out
   * by the runner to prevent accidental override.
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
   * Applies to modes 'fail2pass', 'start', 'resume', and 'test'.
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
   * Normalized staging environment — always present (defaults to `{ provisioner: 'docker' }` when
   * `environments.staging` is absent in config). Contains `app` (with DEFAULT_STAGING_APP
   * defaults) and `appEnvironment` (defaults to `{}`). Used to configure the staging container
   * and to instantiate the provisioner.
   */
  stagingEnvironment: NormalizedStagingEnvironment;
  /**
   * Normalized coding environment — always present (defaults to `{ provisioner: 'docker' }` when
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
}

export interface OrchestratorResult {
  success: boolean;
  attempts: number;
  /** Run ID for resuming (run state saved to .saifac/runs/) */
  runId?: string;
  /** Path to the winning patch.diff if success=true */
  patchPath?: string;
  message: string;
}

export interface RunStorageContext {
  /** Part to re-create the base state of the feature branch - last commit SHA */
  baseCommitSha: string;
  /** Part to re-create the base state of the feature branch - unstaged + staged diff */
  basePatchDiff?: string;
  /** Mutable: set by loop for save-on-Ctrl+C */
  lastErrorFeedback?: string;
}

export async function runIterativeLoop(
  sandbox: SandboxPaths,
  opts: IterativeLoopOpts & { registry: CleanupRegistry },
): Promise<OrchestratorResult> {
  const {
    sandboxProfileId,
    feature,
    projectDir,
    maxRuns,
    overrides,
    saifDir,
    projectName,
    registry,
    testImage,
    resolveAmbiguity,
    dangerousDebug,
    cedarPolicyPath,
    coderImage,
    push,
    pr,
    gitProvider,
    gateRetries,
    agentEnv,
    agentLogFormat,
    testScript,
    testProfile,
    testRetries,
    reviewerEnabled,
    codingEnvironment,
  } = opts;

  // Resolve the coder agent's LLM config once per loop.
  // The resolved config is injected into the Leash container as LLM_* env vars.
  const coderLlmConfig = resolveAgentLlmConfig('coder', overrides);
  const reviewer =
    reviewerEnabled && !dangerousDebug
      ? {
          llmConfig: resolveAgentLlmConfig('reviewer', overrides),
          scriptPath: join(getSaifRoot(), 'src', 'orchestrator', 'scripts', 'reviewer.sh'),
          argusBinaryPath: await getArgusBinaryPath(),
        }
      : null;
  // Always exclude saifac/ and .git/hooks/ regardless of any additional caller-supplied rules.
  // saifac/: reward-hacking prevention (agent must not modify its own test specs).
  // .git/hooks/: prevents a malicious patch from installing hooks that execute on the host
  //   when the orchestrator runs `git commit` in applyPatchToHost.
  // .saifac/: factory-internal workspace state (e.g. per-round task file), not product code.
  const saifExclude: PatchExcludeRule = { type: 'glob', pattern: `${saifDir}/**` };
  const gitHooksExclude: PatchExcludeRule = { type: 'glob', pattern: '.git/hooks/**' };
  const saifacWorkspaceMetaExclude: PatchExcludeRule = { type: 'glob', pattern: '.saifac/**' };
  const patchExclude: PatchExcludeRule[] = [
    saifExclude,
    gitHooksExclude,
    saifacWorkspaceMetaExclude,
    ...(opts.patchExclude ?? []),
  ];

  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  const task = await buildInitialTask({ feature, saifDir });

  const cleanupAndSaveRun = async (input: { didSucceed: boolean }) => {
    const { didSucceed } = input;

    if (runStorage && !didSucceed && runContext && lastRunPatchDiff.trim()) {
      try {
        const { registry: _reg, runStorage: _rs, runContext: _rc, ...loopOpts } = opts;
        const artifact = buildRunArtifact({
          runId,
          baseCommitSha: runContext.baseCommitSha,
          basePatchDiff: runContext.basePatchDiff,
          runPatchDiff: lastRunPatchDiff,
          specRef: feature.relativePath,
          lastFeedback: lastErrorFeedback || undefined,
          status: didSucceed ? 'completed' : 'failed',
          opts: loopOpts as BuildRunArtifactOpts,
        });
        await runStorage.saveRun(runId, artifact);
        consola.log(`[orchestrator] Run state saved. Resume with: saifac run resume ${runId}`);
      } catch (err) {
        consola.warn('[orchestrator] Failed to save run state:', err);
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

  let errorFeedback = opts.initialErrorFeedback ?? '';
  let attempts = 0;
  let sandboxDestroyed = false;

  return await withCleanup(async () => {
    while (attempts < maxRuns) {
      attempts++;
      consola.log(`\n[orchestrator] ===== ATTEMPT ${attempts}/${maxRuns} =====`);

      // 1. Run agent (fresh context every iteration — Ralph Wiggum)
      //    The coding provisioner sets up its network + compose services, runs the agent,
      //    then tears itself down, regardless of outcome.
      const codingRunId = `${sandbox.runId}-coding-${attempts}`;
      const codingProvisioner = createProvisioner(codingEnvironment);
      registry?.registerProvisioner(codingProvisioner, codingRunId);

      try {
        await codingProvisioner.setup({
          runId: codingRunId,
          projectName,
          featureName: feature.name,
          projectDir,
        });

        await codingProvisioner.runAgent({
          codePath: sandbox.codePath,
          sandboxBasePath: sandbox.sandboxBasePath,
          task,
          errorFeedback,
          llmConfig: coderLlmConfig,
          saifDir,
          feature,
          dangerousDebug,
          cedarPolicyPath,
          coderImage,
          gateRetries,
          startupPath: sandbox.startupPath,
          agentInstallPath: sandbox.agentInstallPath,
          agentPath: sandbox.agentPath,
          agentEnv,
          agentLogFormat,
          reviewer,
        });
      } finally {
        registry?.deregisterProvisioner(codingProvisioner);
        await codingProvisioner.teardown({ runId: codingRunId });
      }

      // 2. Extract the patch, stripping any excluded paths (reward-hacking prevention)
      const { patch: patchContent, patchPath } = await extractPatch(sandbox.codePath, {
        exclude: patchExclude,
      });

      if (!patchContent.trim()) {
        consola.warn('[orchestrator] Agent produced no changes (empty patch). Skipping tests.');
        errorFeedback =
          'No changes were made. Please implement the feature as described in the plan.';
        continue;
      }

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

      // Re-apply the patch for tests (extractPatch resets to base state).
      // patchPath is outside codePath so git clean cannot have deleted it.
      await gitApply({ cwd: sandbox.codePath, patchFile: patchPath });

      // 3. Mutual Verification (with test retries for flaky environments)
      let testAttempts = 0;
      let lastRunId = '';
      let lastVagueSpecsCheckResult:
        | Awaited<ReturnType<typeof runVagueSpecsCheckerForFailure>>
        | undefined;

      while (testAttempts < testRetries) {
        testAttempts++;
        lastRunId = `${sandbox.runId}-${attempts}-${testAttempts}`;
        consola.log(
          `\n[orchestrator] Test attempt ${testAttempts}/${testRetries} (outer attempt ${attempts}/${maxRuns})`,
        );

        const stagingProvisioner = createProvisioner(opts.stagingEnvironment);
        registry?.registerProvisioner(stagingProvisioner, lastRunId);
        await stagingProvisioner.setup({
          runId: lastRunId,
          projectName,
          featureName: feature.name,
          projectDir,
        });

        const result: TestsResult = await (async (): Promise<TestsResult> => {
          try {
            const stagingHandle = await stagingProvisioner.startStaging({
              sandboxProfileId,
              codePath: sandbox.codePath,
              projectDir,
              stagingEnvironment: opts.stagingEnvironment,
              feature,
              projectName,
              startupPath: sandbox.startupPath,
              stagePath: sandbox.stagePath,
            });

            return await stagingProvisioner.runTests({
              ...testRunnerOpts,
              stagingHandle,
              testImage,
              runId: lastRunId,
              feature,
              projectName,
              reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
            });
          } finally {
            registry?.deregisterProvisioner(stagingProvisioner);
            await stagingProvisioner.teardown({ runId: lastRunId });
          }
        })();
        if (result.runnerError) {
          throw new Error(
            `Test runner error on attempt ${attempts}: ${result.runnerError}\n` +
              `Check that runner.spec.ts and tests.json are present and valid.\n` +
              `Stderr:\n${result.stderr}`,
          );
        }

        if (result.status === 'passed') {
          // 4. Success path
          consola.log('\n[orchestrator] ✓ ALL TESTS PASSED — applying patch to host');
          await applyPatchToHost({
            codePath: sandbox.codePath,
            projectDir,
            feature,
            runId: lastRunId,
            hostBasePatchPath: sandbox.hostBasePatchPath,
            push,
            pr,
            gitProvider,
            overrides,
            verbose: opts.verbose,
          });
          await destroySandbox(sandbox.sandboxBasePath);
          sandboxDestroyed = true;

          return {
            success: true,
            attempts,
            message: `Feature implemented successfully in ${attempts} attempt(s).`,
          };
        } else if (result.status === 'aborted') {
          consola.log(`\n[orchestrator] Tests aborted after ${attempts} attempt(s).`);
          await destroySandbox(sandbox.sandboxBasePath);
          sandboxDestroyed = true;
          return {
            success: false,
            attempts,
            message: `Tests were aborted after ${attempts} attempt(s).`,
          };
        }

        // 5. Failure path - Check for spec ambiguity.
        //    If spec is ambiguous, the agent CANNOT faithfully completed the task
        //    to match the hidden tests.
        //    We use AI agent to determine if the spec is ambiguous:
        //    - yes, we ask the human (or AI) for clarification and update specs and tests.
        //    - no, we treat errors as genuine code errors and continue the loop.
        if (resolveAmbiguity !== 'off' && result.testSuites) {
          const VagueSpecsCheckResult = await runVagueSpecsCheckerForFailure({
            projectName,
            projectDir,
            feature,
            testSuites: result.testSuites,
            resolveAmbiguity,
            testProfile,
            overrides,
          });

          if (VagueSpecsCheckResult.ambiguityResolved) {
            // Spec was updated and tests regenerated — retry tests with updated suite.
            // Don't count this attempt against testRetries since the spec was at fault.
            consola.log(
              '[orchestrator] Spec ambiguity resolved — retrying tests with updated tests.',
            );
            testAttempts--;
          } else {
            lastVagueSpecsCheckResult = VagueSpecsCheckResult;
          }
        }
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
        lastVagueSpecsCheckResult?.sanitizedHint ??
        'Re-read the plan and specification, and fix the implementation.';
      errorFeedback = base + hint;

      consola.log(
        `\n[orchestrator] Attempt ${attempts} FAILED (tests failed after ${testAttempts} run(s)).`,
      );

      // Reset sandbox to base state for next coder agent run
      await gitResetHard({ cwd: sandbox.codePath });
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
}

export async function buildInitialTask(opts: BuildInitialTaskOpts): Promise<string> {
  const { feature, saifDir } = opts;
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
      `tests.json not found at ${testsJsonPath}. Run 'saifac feat design -n ${feature.name}' first.`,
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
 * Spec files are expected to already exist — generated by `saifac feat design`.
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
