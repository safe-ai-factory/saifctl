/**
 * Hatchet workflow: feat-run
 *
 * Parent workflow that drives a single feature implementation run.
 * Mirrors the existing `runIterativeLoop` logic as Hatchet tasks so the
 * entire run is observable, resumable, and distributable.
 *
 * Structure:
 *   feat-run (parent workflow)
 *     └─ provision-sandbox  — creates the rsync'd sandbox once
 *     └─ convergence-loop   — if testOnly: staging tests only; else iterates up to maxRuns times
 *          Each iteration spawns a child workflow:
 *          feat-run-iteration (child workflow)
 *            └─ run-agent   — 60-min timeout; coder + gate + reviewer + extractPatch
 *            └─ run-tests   — staging engine + test suite (raw result + testSuites)
 *            └─ vague-specs-check — optional LLM ambiguity pass; produces sanitizedHint
 *     └─ apply-patch        — commits + pushes + PR (success path only)
 *     └─ on-failure         — persists RunArtifact so `saifctl run start` works
 *
 * IMPORTANT — Hatchet requires all task inputs/outputs to be JSON-serializable
 * (JsonObject). Types like OrchestratorOpts and Sandbox are serialized to
 * plain objects at the boundary. Zod schemas document the serialized shapes (step 1.5).
 *
 * Signal handling:
 *   In the Hatchet path the CleanupRegistry is NOT registered for SIGINT/SIGTERM
 *   because Hatchet owns the worker process lifecycle. Instead, ctx.abortController
 *   (fired by Hatchet step cancellation) is wired to the Docker API teardown inside
 *   each phase function via the `signal` parameter (step 1.7).
 *
 * Timeout:
 *   run-agent step has executionTimeout: '60m' (step 1.6).
 *   The staging step has '30m'. vague-specs-check uses '30m'. The parent convergence-loop step has '24h'.
 *
 * RunArtifact persistence (step 1.8):
 *   apply-patch saves a completed artifact; on-failure saves a failed artifact for `run start`.
 */

import { join } from 'node:path';

import type { JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import { z } from 'zod';

import { parseJUnitXmlString } from '../../engines/utils/test-parser.js';
import { consola } from '../../logger.js';
import {
  buildInitialTask,
  buildPatchExcludeRules,
  logIterativeLoopSettings,
  prepareTestRunnerOpts,
  runStagingTestVerification,
  runVagueSpecsCheckerForFailure,
  sandboxHasCommitsBeyondInitialImport,
} from '../../orchestrator/loop.js';
import { getSandboxSourceDir } from '../../orchestrator/modes.js';
import { applyPatchToHost } from '../../orchestrator/phases/apply-patch.js';
import { runAgentPhase } from '../../orchestrator/phases/run-agent-phase.js';
import { runTestPhase } from '../../orchestrator/phases/run-test-phase.js';
import { createSandbox, destroySandbox, type Sandbox } from '../../orchestrator/sandbox.js';
import {
  buildOuterAttemptSummary,
  readInnerRounds,
  roundsStatsPath,
} from '../../orchestrator/stats.js';
import { activeOnceRuleIds, markOnceRulesConsumed, rulesForPrompt } from '../../runs/rules.js';
import {
  type OuterAttemptSummary,
  RunAlreadyRunningError,
  type RunCommit,
  type RunRule,
  StaleArtifactError,
} from '../../runs/types.js';
import { buildRunArtifact } from '../../runs/utils/artifact.js';
import { gitClean, gitResetHard } from '../../utils/git.js';
import { pathExists, readUtf8, writeUtf8 } from '../../utils/io.js';
import { getHatchetClient } from '../client.js';
import { deserializeOrchestratorOpts } from '../utils/serialize-opts.js';

// ---------------------------------------------------------------------------
// Zod schemas for step I/O (addresses step 1.5)
// ---------------------------------------------------------------------------

const runCommitSchema = z.object({
  message: z.string(),
  diff: z.string(),
  author: z.string().optional(),
});

export const agentPhaseOutputSchema = z.object({
  patchContent: z.string(),
  patchPath: z.string(),
  preRoundHeadSha: z.string(),
  commits: z.array(runCommitSchema),
});
export type AgentPhaseOutput = z.infer<typeof agentPhaseOutputSchema>;

/** Serialized assertion / suite shapes (match `engines/types` for Hatchet JSON boundaries). */
export const assertionResultSchema = z.object({
  title: z.string(),
  fullName: z.string(),
  status: z.enum(['passed', 'failed', 'pending', 'todo']),
  ancestorTitles: z.array(z.string()),
  failureMessages: z.array(z.string()),
  failureTypes: z.array(z.string()),
});
export const assertionSuiteResultSchema = z.object({
  name: z.string(),
  status: z.string(),
  assertionResults: z.array(assertionResultSchema),
});

/** Raw test step output (no agent-facing hint; see vague-specs-check). */
export const testPhaseOutputSchema = z.object({
  status: z.enum(['passed', 'failed', 'aborted']),
  testRunId: z.string(),
  stderr: z.string().optional(),
  testSuites: z.array(assertionSuiteResultSchema).optional(),
});
export type TestPhaseOutput = z.infer<typeof testPhaseOutputSchema>;

export const vagueSpecsStepOutputSchema = z.object({
  sanitizedHint: z.string().optional(),
});
export type VagueSpecsStepOutput = z.infer<typeof vagueSpecsStepOutputSchema>;

const runRuleSchema = z.object({
  id: z.string(),
  content: z.string(),
  scope: z.enum(['once', 'always']),
  createdAt: z.string(),
  updatedAt: z.string(),
  consumedAt: z.string().optional(),
});

const innerRoundSummarySchema = z.object({
  round: z.number(),
  phase: z.enum([
    'agent_failed',
    'gate_passed',
    'gate_failed',
    'reviewer_passed',
    'reviewer_failed',
  ]),
  gateOutput: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
});

const outerAttemptSummarySchema = z.object({
  attempt: z.number(),
  phase: z.enum(['no_changes', 'tests_passed', 'tests_failed', 'aborted']),
  innerRoundCount: z.number(),
  innerRounds: z.array(innerRoundSummarySchema),
  commitCount: z.number(),
  patchBytes: z.number(),
  errorFeedback: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const convergenceOutputSchema = z.object({
  success: z.boolean(),
  attempt: z.number(),
  patchPath: z.string().nullable(),
  lastRunId: z.string(),
  lastPatchContent: z.string().optional(),
  lastErrorFeedback: z.string().optional(),
  rules: z.array(runRuleSchema),
  roundSummaries: z.array(outerAttemptSummarySchema).optional(),
});
export type ConvergenceOutput = z.infer<typeof convergenceOutputSchema>;

// ---------------------------------------------------------------------------
// Serialized input types (JsonObject-compatible)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HatchetInput = Record<string, any>;

/** Subset of OrchestratorOpts that is JSON-serializable, passed as Hatchet workflow input. */
export type FeatRunSerializedInput = HatchetInput & {
  /** JSON-serialized OrchestratorOpts (see serializeOrchestratorOpts) */
  serializedOpts: Record<string, unknown>;
  /** JSON-serialized RunStorageContext */
  runContext: {
    baseCommitSha: string;
    basePatchDiff?: string;
    lastErrorFeedback?: string;
    rules: RunRule[];
  };
};

export type FeatRunIterationSerializedInput = HatchetInput & {
  sandbox: Sandbox;
  attempt: number;
  errorFeedback: string;
  task: string;
  /** JSON-serialized OrchestratorOpts */
  serializedOpts: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Child workflow: feat-run-iteration
// ---------------------------------------------------------------------------

export function createFeatRunIterationWorkflow() {
  const { hatchet } = getHatchetClient();

  const workflow = hatchet.workflow<
    FeatRunIterationSerializedInput,
    {
      'run-agent': AgentPhaseOutput;
      'run-tests': TestPhaseOutput;
      'vague-specs-check': VagueSpecsStepOutput;
    }
  >({
    name: 'feat-run-iteration',
  });

  // Step 1: run-agent (60-minute timeout; addresses step 1.6)
  const runAgentTask = workflow.task({
    name: 'run-agent',
    executionTimeout: '60m',
    scheduleTimeout: '10m',
    fn: async (input, ctx) => {
      const opts = deserializeOrchestratorOpts(input.serializedOpts);
      const { sandbox, attempt, errorFeedback, task } = input;
      const { saifctlDir } = opts;
      const patchExclude = buildPatchExcludeRules(saifctlDir, opts.patchExclude);

      // Wire Hatchet step cancellation → container teardown (addresses step 1.7)
      const signal = ctx.abortController.signal;

      return runAgentPhase({
        sandbox,
        attempt,
        errorFeedback,
        task,
        patchExclude,
        opts: {
          llm: opts.llm,
          projectDir: opts.projectDir,
          projectName: opts.projectName,
          feature: opts.feature,
          dangerousNoLeash: opts.dangerousNoLeash,
          coderImage: opts.coderImage,
          gateRetries: opts.gateRetries,
          agentEnv: opts.agentEnv,
          agentSecretKeys: opts.agentSecretKeys,
          agentSecretFiles: opts.agentSecretFiles,
          agentProfileId: opts.agentProfileId,
          reviewerEnabled: opts.reviewerEnabled,
          codingEnvironment: opts.codingEnvironment,
          saifctlDir,
        },
        // No CleanupRegistry in Hatchet path (step 1.7 — Hatchet owns the process)
        registry: null,
        signal,
      });
    },
  });

  // Step 2: run-tests (depends on run-agent) — raw result only
  const runTestsTask = workflow.task({
    name: 'run-tests',
    executionTimeout: '30m',
    parents: [runAgentTask],
    fn: async (input, ctx) => {
      const agentOutput = await ctx.parentOutput(runAgentTask);
      const { sandbox, attempt } = input;

      const emptyRoundPatch = !agentOutput.patchContent.trim() || agentOutput.commits.length === 0;
      if (emptyRoundPatch && !(await sandboxHasCommitsBeyondInitialImport(sandbox.codePath))) {
        return {
          status: 'failed' as const,
          testRunId: '',
          stderr: '',
        };
      }

      const opts = deserializeOrchestratorOpts(input.serializedOpts);

      const { result, testRunId } = await runTestPhase({
        sandbox,
        attempt,
        opts: {
          sandboxProfileId: opts.sandboxProfileId,
          feature: opts.feature,
          projectDir: opts.projectDir,
          projectName: opts.projectName,
          testImage: opts.testImage,
          testScript: opts.testScript,
          testRetries: opts.testRetries,
          stagingEnvironment: opts.stagingEnvironment,
        },
        registry: null,
        signal: ctx.abortController.signal,
      });

      return {
        status: result.status,
        testRunId,
        stderr: result.stderr,
        testSuites: parseJUnitXmlString(result.rawJunitXml),
      };
    },
  });

  // Step 3: optional vague-specs / ambiguity pass (depends on run-tests)
  workflow.task({
    name: 'vague-specs-check',
    executionTimeout: '30m',
    parents: [runTestsTask],
    fn: async (input, ctx) => {
      const testOut = await ctx.parentOutput(runTestsTask);
      const opts = deserializeOrchestratorOpts(input.serializedOpts);

      if (
        testOut.status !== 'failed' ||
        opts.resolveAmbiguity === 'off' ||
        !testOut.testSuites?.length
      ) {
        return { sanitizedHint: undefined };
      }

      const vagueResult = await runVagueSpecsCheckerForFailure({
        projectName: opts.projectName,
        projectDir: opts.projectDir,
        feature: opts.feature,
        testSuites: testOut.testSuites,
        resolveAmbiguity: opts.resolveAmbiguity,
        testProfile: opts.testProfile,
        llm: opts.llm,
      });

      return { sanitizedHint: vagueResult.sanitizedHint };
    },
  });

  return workflow;
}

// ---------------------------------------------------------------------------
// Parent workflow: feat-run
// ---------------------------------------------------------------------------

export function createFeatRunWorkflow() {
  const { hatchet } = getHatchetClient();

  const featRunIterationWorkflow = createFeatRunIterationWorkflow();

  const workflow = hatchet.workflow<
    FeatRunSerializedInput,
    {
      'provision-sandbox': Sandbox & { [x: string]: JsonValue };
      'convergence-loop': ConvergenceOutput;
      'apply-patch': { applied: boolean };
    }
  >({ name: 'feat-run' });

  // Step 1: provision-sandbox
  const provisionTask = workflow.task({
    name: 'provision-sandbox',
    executionTimeout: '5m',
    fn: async (input) => {
      const opts = deserializeOrchestratorOpts(input.serializedOpts);
      const src = getSandboxSourceDir(opts);
      const persistedRunId = opts.fromArtifact?.persistedRunId;
      const sandboxRaw = await createSandbox({
        feature: opts.feature,
        projectDir: src,
        codeSourceDir: opts.fromArtifact?.baseSnapshotPath ?? src,
        saifctlDir: opts.saifctlDir,
        projectName: opts.projectName,
        sandboxBaseDir: opts.sandboxBaseDir,
        gateScript: opts.gateScript,
        startupScript: opts.startupScript,
        agentInstallScript: opts.agentInstallScript,
        agentScript: opts.agentScript,
        stageScript: opts.stageScript,
        cedarScript: opts.cedarScript,
        verbose: !!opts.verbose,
        runCommits: opts.fromArtifact?.seedRunCommits ?? [],
        runId: persistedRunId,
        includeDirty: opts.includeDirty,
        reuseExistingSandbox: !!opts.fromArtifact?.reuseExistingSandbox,
      });

      // ─── Set status to "running" ─────
      const runStorage = opts.runStorage;
      if (runStorage) {
        try {
          const { runStorage: _rs, fromArtifact: _fa, ...loopOpts } = opts;
          const runningArtifact = buildRunArtifact({
            runId: sandboxRaw.runId,
            baseCommitSha: input.runContext.baseCommitSha,
            basePatchDiff: input.runContext.basePatchDiff,
            runCommits: opts.fromArtifact?.seedRunCommits ?? [],
            specRef: opts.feature.relativePath,
            rules: input.runContext.rules,
            roundSummaries: opts.fromArtifact?.seedRoundSummaries,
            status: 'running',
            opts: loopOpts,
            controlSignal: null,
            pausedSandboxBasePath: null,
            liveInfra: null,
            inspectSession: null,
          });
          sandboxRaw.runningArtifactRevision = await runStorage.setStatusRunning(
            sandboxRaw.runId,
            runningArtifact,
          );
        } catch (err) {
          if (err instanceof RunAlreadyRunningError) throw err;
          consola.warn('[hatchet] Failed to set run status to "running":', err);
        }
      }

      return sandboxRaw as Sandbox & { [x: string]: JsonValue };
    },
  });

  // Step 2: convergence-loop — iterates, spawning child workflows
  const convergenceTask = workflow.task({
    name: 'convergence-loop',
    executionTimeout: '24h',
    scheduleTimeout: '5m',
    parents: [provisionTask],
    fn: async (input, ctx): Promise<ConvergenceOutput> => {
      const sandboxRaw = await ctx.parentOutput(provisionTask);
      const opts = deserializeOrchestratorOpts(input.serializedOpts);
      const { maxRuns, feature, saifctlDir, fromArtifact, testOnly } = opts;

      const modeLabel = testOnly ? 'test' : fromArtifact ? 'fromArtifact' : 'start';
      consola.log(
        `\n[orchestrator] MODE: ${modeLabel} — ${feature.name} (run ${sandboxRaw.runId})`,
      );
      logIterativeLoopSettings(opts, { runId: sandboxRaw.runId });

      const rulesFromWire = (): RunRule[] => structuredClone(input.runContext.rules);

      // Summaries not collected during test-only runs (since no agent is run).
      const testRoundSummaries: OuterAttemptSummary[] = [];

      if (testOnly) {
        consola.log('[hatchet] test-only — skipping agent iterations; running verification tests.');
        const runCommitsAccum = [...(fromArtifact?.seedRunCommits ?? [])];
        await writeUtf8(
          join(sandboxRaw.sandboxBasePath, 'run-commits.json'),
          JSON.stringify(runCommitsAccum),
        );
        const testRunnerOpts = await prepareTestRunnerOpts({
          feature: opts.feature,
          sandboxBasePath: sandboxRaw.sandboxBasePath,
          testScript: opts.testScript,
        });
        const verify = await runStagingTestVerification({
          sandbox: sandboxRaw,
          orchestratorOpts: opts,
          registry: null,
          testRunnerOpts,
          outerAttempt: 1,
        });
        if (verify.kind === 'passed') {
          return {
            success: true,
            attempt: 1,
            patchPath: null,
            lastRunId: verify.lastRunId,
            rules: rulesFromWire(),
            roundSummaries: testRoundSummaries,
          };
        }
        if (verify.kind === 'aborted') {
          return {
            success: false,
            attempt: 1,
            patchPath: null,
            lastRunId: `${sandboxRaw.runId}-1-1`,
            lastErrorFeedback: 'Test run was cancelled.',
            rules: rulesFromWire(),
            roundSummaries: testRoundSummaries,
          };
        }
        const base = 'An external service attempted to use this project and failed. ';
        const hint =
          verify.lastVagueSpecsCheckResult?.sanitizedHint ??
          'Re-read the plan and specification, and fix the implementation.';
        return {
          success: false,
          attempt: 1,
          patchPath: null,
          lastRunId: `${sandboxRaw.runId}-1-1`,
          lastErrorFeedback: base + hint,
          rules: rulesFromWire(),
          roundSummaries: testRoundSummaries,
        };
      }

      const rulesState: RunRule[] = rulesFromWire();

      let errorFeedback = fromArtifact?.initialErrorFeedback ?? '';
      let lastPatchContent = '';
      let lastErrorFeedback = '';
      let lastRunId = '';
      let runCommitsAccum: RunCommit[] = [...(fromArtifact?.seedRunCommits ?? [])];
      const roundSummaries: OuterAttemptSummary[] = [];
      // Offset so attempt numbers continue from where prior invocations left off.
      const attemptOffset = fromArtifact?.seedRoundSummaries?.length ?? 0;

      for (let attempt = 1; attempt <= maxRuns; attempt++) {
        consola.log(
          `\n[hatchet] ===== ATTEMPT ${attempt + attemptOffset}/${maxRuns + attemptOffset} (run ${sandboxRaw.runId}) =====`,
        );
        const attemptStartedAt = new Date().toISOString();

        // Some rules are marked as "once" and should be consumed after the coding round.
        // Thus these rules are included in the task prompt only on the first round.
        const onceIdsThisRound = activeOnceRuleIds(rulesState);
        const task = await buildInitialTask({
          feature,
          saifctlDir,
          rules: rulesForPrompt(rulesState),
        });

        // Hatchet: `runChild` resolves to the child workflow's final aggregate output. For a
        // multi-task DAG, that object is keyed by each step's `name` (see TS SDK
        // `WorkflowDeclaration.task` JSDoc — Hatchet's web docs often show `parentOutput` /
        // single-task `run()` instead). Keys here match `featRunIterationWorkflow` tasks.
        const iterResult = await ctx.runChild<
          FeatRunIterationSerializedInput,
          {
            'run-agent': AgentPhaseOutput;
            'run-tests': TestPhaseOutput;
            'vague-specs-check': VagueSpecsStepOutput;
          }
        >(featRunIterationWorkflow.name, {
          sandbox: sandboxRaw,
          attempt,
          errorFeedback,
          task,
          serializedOpts: input.serializedOpts,
        });

        const {
          'run-agent': agentOut,
          'run-tests': testOut,
          'vague-specs-check': vagueOut,
        } = iterResult;

        const innerRounds = await readInnerRounds(roundsStatsPath(sandboxRaw.sandboxBasePath));

        // Mark once rules as consumed if they were used this round.
        if (onceIdsThisRound.length > 0) {
          markOnceRulesConsumed(rulesState, onceIdsThisRound);
        }

        const emptyAgentRound = !agentOut.patchContent.trim() || agentOut.commits.length === 0;
        if (emptyAgentRound && !(await sandboxHasCommitsBeyondInitialImport(sandboxRaw.codePath))) {
          errorFeedback =
            'No changes were made. Please implement the feature as described in the plan.';
          lastErrorFeedback = errorFeedback;
          lastPatchContent = '';
          roundSummaries.push(
            buildOuterAttemptSummary({
              attempt: attempt + attemptOffset,
              phase: 'no_changes',
              innerRounds,
              commitCount: 0,
              patchBytes: 0,
              errorFeedback,
              startedAt: attemptStartedAt,
            }),
          );
          continue;
        }

        runCommitsAccum = [...runCommitsAccum, ...agentOut.commits];
        await writeUtf8(
          join(sandboxRaw.sandboxBasePath, 'run-commits.json'),
          JSON.stringify(runCommitsAccum),
        );

        lastPatchContent = agentOut.patchContent;
        lastRunId = testOut.testRunId;

        if (testOut.status === 'passed') {
          roundSummaries.push(
            buildOuterAttemptSummary({
              attempt: attempt + attemptOffset,
              phase: 'tests_passed',
              innerRounds,
              commitCount: agentOut.commits.length,
              patchBytes: agentOut.patchContent.length,
              startedAt: attemptStartedAt,
            }),
          );
          return {
            success: true,
            attempt: attempt + attemptOffset,
            patchPath: agentOut.patchPath,
            lastRunId,
            rules: rulesState,
            roundSummaries,
          };
        }

        if (testOut.status === 'aborted') {
          consola.log('[hatchet] Test run aborted by cancellation.');
          if (agentOut.commits.length > 0) {
            runCommitsAccum = runCommitsAccum.slice(0, -agentOut.commits.length);
          }
          await writeUtf8(
            join(sandboxRaw.sandboxBasePath, 'run-commits.json'),
            JSON.stringify(runCommitsAccum),
          );
          roundSummaries.push(
            buildOuterAttemptSummary({
              attempt: attempt + attemptOffset,
              phase: 'aborted',
              innerRounds,
              commitCount: agentOut.commits.length,
              patchBytes: agentOut.patchContent.length,
              startedAt: attemptStartedAt,
            }),
          );
          return {
            success: false,
            attempt: attempt + attemptOffset,
            patchPath: null,
            lastRunId: testOut.testRunId,
            lastPatchContent: agentOut.patchContent,
            lastErrorFeedback: 'Test run was cancelled.',
            rules: rulesState,
            roundSummaries,
          };
        }

        const base = 'An external service attempted to use this project and failed. ';
        const hint =
          vagueOut.sanitizedHint ??
          'Re-read the plan and specification, and fix the implementation.';
        errorFeedback = base + hint;
        lastErrorFeedback = errorFeedback;

        consola.log(`\n[hatchet] Attempt ${attempt} FAILED.`);

        roundSummaries.push(
          buildOuterAttemptSummary({
            attempt: attempt + attemptOffset,
            phase: 'tests_failed',
            innerRounds,
            commitCount: agentOut.commits.length,
            patchBytes: agentOut.patchContent.length,
            errorFeedback,
            startedAt: attemptStartedAt,
          }),
        );

        if (agentOut.commits.length > 0) {
          runCommitsAccum = runCommitsAccum.slice(0, -agentOut.commits.length);
        }
        await writeUtf8(
          join(sandboxRaw.sandboxBasePath, 'run-commits.json'),
          JSON.stringify(runCommitsAccum),
        );

        await gitResetHard({ cwd: sandboxRaw.codePath, ref: agentOut.preRoundHeadSha });
        await gitClean({ cwd: sandboxRaw.codePath });
      }

      consola.error(`\n[hatchet] Max runs (${maxRuns}) reached without success.`);
      return {
        success: false,
        attempt: maxRuns + attemptOffset, // total attempts across all invocations
        patchPath: null,
        lastRunId,
        lastPatchContent,
        lastErrorFeedback,
        rules: rulesState,
        roundSummaries,
      };
    },
  });

  // Step 3: apply-patch (success path only)
  const applyTask = workflow.task({
    name: 'apply-patch',
    executionTimeout: '10m',
    parents: [convergenceTask],
    fn: async (input, ctx) => {
      const loopResult = await ctx.parentOutput(convergenceTask);
      const sandboxRaw = await ctx.parentOutput(provisionTask);
      const opts = deserializeOrchestratorOpts(input.serializedOpts);

      if (!loopResult.success) {
        await destroySandbox(sandboxRaw.sandboxBasePath);
        return { applied: false };
      }

      const commitsPath = join(sandboxRaw.sandboxBasePath, 'run-commits.json');
      let runCommits: RunCommit[] = [];
      if (await pathExists(commitsPath)) {
        try {
          const raw = JSON.parse(await readUtf8(commitsPath)) as unknown;
          runCommits = Array.isArray(raw) ? (raw as RunCommit[]) : [];
        } catch {
          runCommits = [];
        }
      }

      await applyPatchToHost({
        codePath: sandboxRaw.codePath,
        projectDir: opts.projectDir,
        feature: opts.feature,
        runId: sandboxRaw.runId,
        commits: runCommits,
        hostBasePatchPath: sandboxRaw.hostBasePatchPath,
        push: opts.push,
        pr: opts.pr,
        gitProvider: opts.gitProvider,
        llm: opts.llm,
        verbose: !!opts.verbose,
        targetBranch: opts.targetBranch,
        startCommit: input.runContext.baseCommitSha?.trim() || undefined,
      });

      const runStorage = opts.runStorage;
      if (runStorage) {
        try {
          const { runStorage: _rs, fromArtifact: _fa, ...loopOpts } = opts;
          const artifact = buildRunArtifact({
            runId: sandboxRaw.runId,
            baseCommitSha: input.runContext.baseCommitSha,
            basePatchDiff: input.runContext.basePatchDiff,
            runCommits,
            specRef: opts.feature.relativePath,
            status: 'completed',
            rules: loopResult.rules,
            roundSummaries: loopResult.roundSummaries,
            opts: loopOpts,
            controlSignal: null,
            pausedSandboxBasePath: null,
            liveInfra: null,
            inspectSession: null,
          });
          const expectedArtifactRevision =
            sandboxRaw.runningArtifactRevision ??
            opts.fromArtifact?.artifactRevisionWhenFromArtifact;
          await runStorage.saveRun(
            sandboxRaw.runId,
            artifact,
            expectedArtifactRevision === undefined
              ? undefined
              : { ifRevisionEquals: expectedArtifactRevision },
          );
          consola.log('[hatchet] Run artifact saved (completed).');
        } catch (err) {
          if (err instanceof StaleArtifactError) {
            consola.warn(`[hatchet] ${err.message}`);
          } else {
            consola.warn('[hatchet] Failed to save run artifact:', err);
          }
        }
      }

      await destroySandbox(sandboxRaw.sandboxBasePath);
      return { applied: true };
    },
  });

  // on-failure: persist RunArtifact for `saifctl run start` (addresses step 1.8), then remove
  // the sandbox. Without cleanup here, failures before `apply-patch` never run destroySandbox
  // (that task only runs when convergence-loop completes successfully).
  workflow.onFailure({
    name: 'on-failure',
    fn: async (input, ctx) => {
      let sandboxRaw: Sandbox | null = null;
      try {
        sandboxRaw = await ctx.parentOutput(provisionTask);
      } catch {
        // provision-sandbox may not have completed
        return;
      }

      try {
        const commitsPath = join(sandboxRaw.sandboxBasePath, 'run-commits.json');
        const runCommits: RunCommit[] = (await pathExists(commitsPath))
          ? (JSON.parse(await readUtf8(commitsPath)) as RunCommit[])
          : [];

        let loopResult: ConvergenceOutput | null = null;
        try {
          loopResult = await ctx.parentOutput(convergenceTask);
        } catch {
          // convergence-loop may not have completed
        }

        const opts = deserializeOrchestratorOpts(input.serializedOpts);
        const runStorage = opts.runStorage;
        if (!runStorage) return;

        const lastFeedback =
          loopResult?.lastErrorFeedback ?? input.runContext.lastErrorFeedback ?? '';

        try {
          const { runStorage: _rs, fromArtifact: _fa, ...loopOpts } = opts;
          const artifact = buildRunArtifact({
            runId: sandboxRaw.runId,
            baseCommitSha: input.runContext.baseCommitSha,
            basePatchDiff: input.runContext.basePatchDiff,
            runCommits,
            specRef: opts.feature.relativePath,
            lastFeedback: lastFeedback || undefined,
            status: 'failed',
            rules: loopResult?.rules ?? input.runContext.rules,
            roundSummaries: loopResult?.roundSummaries,
            opts: loopOpts,
            controlSignal: null,
            pausedSandboxBasePath: null,
            liveInfra: null,
            inspectSession: null,
          });
          const expectedArtifactRevision =
            sandboxRaw.runningArtifactRevision ??
            opts.fromArtifact?.artifactRevisionWhenFromArtifact;
          await runStorage.saveRun(
            sandboxRaw.runId,
            artifact,
            expectedArtifactRevision === undefined
              ? undefined
              : { ifRevisionEquals: expectedArtifactRevision },
          );
          consola.log(
            `[hatchet] Run artifact saved (failed). Start again with: saifctl run start ${sandboxRaw.runId}`,
          );
        } catch (err) {
          if (err instanceof StaleArtifactError) {
            consola.warn(`[hatchet] ${err.message}`);
          } else {
            consola.warn('[hatchet] Failed to save run state:', err);
          }
        }
      } finally {
        try {
          await destroySandbox(sandboxRaw.sandboxBasePath);
        } catch (err) {
          consola.warn('[hatchet] Failed to remove sandbox after workflow failure:', err);
        }
      }
    },
  });

  void applyTask; // referenced to avoid unused-variable lint
  return workflow;
}
