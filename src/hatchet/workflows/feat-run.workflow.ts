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
 *     └─ convergence-loop   — iterates up to maxRuns times
 *          Each iteration spawns a child workflow:
 *          feat-run-iteration (child workflow)
 *            └─ run-agent   — 60-min timeout; coder + gate + reviewer + extractPatch
 *            └─ run-tests   — staging provisioner + test suite (raw result + testSuites)
 *            └─ vague-specs-check — optional LLM ambiguity pass; produces sanitizedHint
 *     └─ apply-patch        — commits + pushes + PR (success path only)
 *     └─ on-failure         — persists RunArtifact so `saifac run resume` works
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
 *   The on-failure handler saves a RunArtifact so `saifac run resume <runId>` works.
 */

import { join } from 'node:path';

import type { JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import { z } from 'zod';

import { buildInitialTask, runVagueSpecsCheckerForFailure } from '../../orchestrator/loop.js';
import { getSandboxSourceDir } from '../../orchestrator/modes.js';
import { applyPatchToHost } from '../../orchestrator/phases/apply-patch.js';
import { runAgentPhase } from '../../orchestrator/phases/run-agent-phase.js';
import { runTestPhase } from '../../orchestrator/phases/run-test-phase.js';
import { createSandbox, destroySandbox, type Sandbox } from '../../orchestrator/sandbox.js';
import { buildRunArtifact } from '../../runs/index.js';
import { gitClean, gitResetHard } from '../../utils/git.js';
import { pathExists, readUtf8 } from '../../utils/io.js';
import { getHatchetClient } from '../client.js';
import { deserializeOrchestratorOpts } from '../utils/serialize-opts.js';

// ---------------------------------------------------------------------------
// Zod schemas for step I/O (addresses step 1.5)
// ---------------------------------------------------------------------------

export const agentPhaseOutputSchema = z.object({
  patchContent: z.string(),
  patchPath: z.string(),
});
export type AgentPhaseOutput = z.infer<typeof agentPhaseOutputSchema>;

/** Serialized assertion / suite shapes (match `provisioners/types` for Hatchet JSON boundaries). */
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

export const convergenceOutputSchema = z.object({
  success: z.boolean(),
  attempt: z.number(),
  patchPath: z.string().nullable(),
  lastRunId: z.string(),
  lastPatchContent: z.string().optional(),
  lastErrorFeedback: z.string().optional(),
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
  runContext: { baseCommitSha: string; basePatchDiff?: string; lastErrorFeedback?: string };
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
  const hatchet = getHatchetClient();
  if (!hatchet) throw new Error('Hatchet client is not configured');

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
      const { saifDir } = opts;

      const saifExclude = { type: 'glob' as const, pattern: `${saifDir}/**` };
      const gitHooksExclude = { type: 'glob' as const, pattern: '.git/hooks/**' };
      const patchExclude = [saifExclude, gitHooksExclude, ...(opts.patchExclude ?? [])];

      // Wire Hatchet step cancellation → container teardown (addresses step 1.7)
      const signal = ctx.abortController.signal;

      return runAgentPhase({
        sandbox,
        attempt,
        errorFeedback,
        task,
        patchExclude,
        opts: {
          overrides: opts.overrides,
          projectDir: opts.projectDir,
          projectName: opts.projectName,
          feature: opts.feature,
          dangerousDebug: opts.dangerousDebug,
          cedarPolicyPath: opts.cedarPolicyPath,
          coderImage: opts.coderImage,
          gateRetries: opts.gateRetries,
          agentEnv: opts.agentEnv,
          agentLogFormat: opts.agentLogFormat,
          reviewerEnabled: opts.reviewerEnabled,
          codingEnvironment: opts.codingEnvironment,
          saifDir,
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

      if (!agentOutput.patchContent.trim()) {
        return {
          status: 'failed' as const,
          testRunId: '',
          stderr: '',
        };
      }

      const opts = deserializeOrchestratorOpts(input.serializedOpts);
      const { sandbox, attempt } = input;

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
        testSuites: result.testSuites,
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
        overrides: opts.overrides,
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
  const hatchet = getHatchetClient();
  if (!hatchet) throw new Error('Hatchet client is not configured');

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
      return (await createSandbox({
        feature: opts.feature,
        projectDir: getSandboxSourceDir(opts),
        saifDir: opts.saifDir,
        projectName: opts.projectName,
        sandboxBaseDir: opts.sandboxBaseDir,
        gateScript: opts.gateScript,
        startupScript: opts.startupScript,
        agentStartScript: opts.agentStartScript,
        agentScript: opts.agentScript,
        stageScript: opts.stageScript,
        verbose: !!opts.verbose,
      })) as Sandbox & { [x: string]: JsonValue };
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
      const { maxRuns, feature, saifDir, resume } = opts;

      const task = await buildInitialTask({ feature, saifDir });

      let errorFeedback = resume?.initialErrorFeedback ?? '';
      let lastPatchContent = '';
      let lastErrorFeedback = '';
      let lastRunId = '';

      for (let attempt = 1; attempt <= maxRuns; attempt++) {
        console.log(`\n[hatchet] ===== ATTEMPT ${attempt}/${maxRuns} =====`);

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

        if (!agentOut.patchContent.trim()) {
          errorFeedback =
            'No changes were made. Please implement the feature as described in the plan.';
          continue;
        }

        lastPatchContent = agentOut.patchContent;
        lastRunId = testOut.testRunId;

        if (testOut.status === 'passed') {
          return {
            success: true,
            attempt,
            patchPath: agentOut.patchPath,
            lastRunId,
          };
        }

        if (testOut.status === 'aborted') {
          console.log('[hatchet] Test run aborted by cancellation.');
          return {
            success: false,
            attempt,
            patchPath: null,
            lastRunId: testOut.testRunId,
            lastPatchContent: agentOut.patchContent,
            lastErrorFeedback: 'Test run was cancelled.',
          };
        }

        const base = 'An external service attempted to use this project and failed. ';
        const hint =
          vagueOut.sanitizedHint ??
          'Re-read the plan and specification, and fix the implementation.';
        errorFeedback = base + hint;
        lastErrorFeedback = errorFeedback;

        console.log(`\n[hatchet] Attempt ${attempt} FAILED.`);

        // Reset sandbox for next coder round
        await gitResetHard({ cwd: sandboxRaw.codePath });
        await gitClean({ cwd: sandboxRaw.codePath });
      }

      console.error(`\n[hatchet] Max runs (${maxRuns}) reached without success.`);
      return {
        success: false,
        attempt: maxRuns,
        patchPath: null,
        lastRunId,
        lastPatchContent,
        lastErrorFeedback,
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

      await destroySandbox(sandboxRaw.sandboxBasePath);

      if (!loopResult.success) {
        return { applied: false };
      }

      await applyPatchToHost({
        codePath: sandboxRaw.codePath,
        projectDir: opts.projectDir,
        feature: opts.feature,
        runId: loopResult.lastRunId,
        push: opts.push,
        pr: opts.pr,
        gitProvider: opts.gitProvider,
        overrides: opts.overrides,
        verbose: !!opts.verbose,
      });

      return { applied: true };
    },
  });

  // on-failure: persist RunArtifact for `saifac run resume` (addresses step 1.8)
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

      const patchPath = join(sandboxRaw.sandboxBasePath, 'patch.diff');
      const runPatchDiff = (await pathExists(patchPath)) ? await readUtf8(patchPath) : '';
      if (!runPatchDiff.trim()) return;

      let loopResult: ConvergenceOutput | null = null;
      try {
        loopResult = await ctx.parentOutput(convergenceTask);
      } catch {
        // convergence-loop may not have completed
      }

      const opts = deserializeOrchestratorOpts(input.serializedOpts);
      const runStorage = opts.runStorage;
      if (!runStorage) return;

      try {
        const { runStorage: _rs, resume: _res, ...loopOpts } = opts;
        const artifact = buildRunArtifact({
          runId: sandboxRaw.runId,
          baseCommitSha: input.runContext.baseCommitSha,
          basePatchDiff: input.runContext.basePatchDiff,
          runPatchDiff,
          specRef: opts.feature.relativePath,
          lastFeedback: loopResult?.lastErrorFeedback,
          status: 'failed',
          opts: loopOpts,
        });
        await runStorage.saveRun(sandboxRaw.runId, artifact);
        console.log(
          `[hatchet] Run state saved. Resume with: saifac run resume ${sandboxRaw.runId}`,
        );
      } catch (err) {
        console.warn('[hatchet] Failed to save run state:', err);
      }
    },
  });

  void applyTask; // referenced to avoid unused-variable lint
  return workflow;
}
