/**
 * Phase: run-agent-phase
 *
 * Runs the coder agent inside the coding container (Leash or local) for one
 * subtask attempt, then extracts the resulting patch. Used by the Hatchet
 * workflow step. Phase-aware: each call corresponds to one subtask attempt
 * inside a phase (the prompt is rebuilt per subtask, not once per loop).
 *
 * Engine lifecycle (register → setup → runAgent → deregister → teardown) is
 * delegated to {@link runEngineAttempt}. This phase adds:
 *   - patch extraction on top of the engine attempt;
 *   - Block 8 modification surfacing (plan/spec/test deviations land in the
 *     run log + per-run JSONL breadcrumb), gated on caller-supplied
 *     `surfaceContext` so we can tag the breadcrumb with phase/critic ids.
 *
 * Unlike {@link runCodingPhase} (used by the iterative loop), this phase:
 * - Always tears down on exit (no pause/stop routing).
 * - Does not start a rules watcher.
 * - Returns patch content rather than a discriminated outcome.
 */

import { relative } from 'node:path';

import { consola } from '../../logger.js';
import type { RunCommit } from '../../runs/types.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { git } from '../../utils/git.js';
import type { IterativeLoopOpts } from '../loop.js';
import { loadPhaseSpecFilenames, surfaceModifiedPathsAfterRound } from '../post-round-warnings.js';
import {
  extractIncrementalRoundPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  type Sandbox,
} from '../sandbox.js';
import { runEngineAttempt } from './run-engine-attempt.js';

/** Inputs for {@link runAgentPhase} — sandbox, attempt index, task, surfacing context, and engine opts. */
export interface RunAgentPhaseInput {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed). Re-used as the `round` field in
   * Block 8's modifications.log so a JSONL grep matches the run-log message. */
  attempt: number;
  /** Error feedback from the previous test run (empty on first attempt) */
  errorFeedback: string;
  /**
   * Per-subtask task prompt. Rebuilt per subtask by the caller — the legacy
   * "built once per loop from plan.md + specification.md" pattern was a
   * single-subtask artifact and no longer applies under phases (Block 5's
   * link-don't-inline implementer prompt + Block 3's compiler).
   */
  task: string;
  /** Patch exclusion rules (saifctlDir + .git/hooks/ already included) */
  patchExclude: PatchExcludeRule[];
  /**
   * Block 8 surfacing context. Optional so older callers (and tests) keep
   * working — when omitted, the surfacing pass is silently skipped, mirroring
   * the loop-side behavior when no plan/spec/test file changed. The Hatchet
   * outer workflow is responsible for plumbing the active subtask's metadata
   * here so the JSONL breadcrumb can distinguish implementer rounds from
   * critic discover/fix rounds.
   */
  surfaceContext?: {
    /** 0-based index into the active subtask list. */
    subtaskIndex: number;
    /** Phase id when the subtask is part of a phased feature, else null. */
    phaseId: string | null;
    /** Critic id for discover/fix subtasks, else null. */
    criticId: string | null;
  };
  opts: Pick<
    IterativeLoopOpts,
    | 'llm'
    | 'projectDir'
    | 'projectName'
    | 'feature'
    | 'dangerousNoLeash'
    | 'coderImage'
    | 'gateRetries'
    | 'agentEnv'
    | 'agentSecretKeys'
    | 'agentSecretFiles'
    | 'agentProfileId'
    | 'reviewerEnabled'
    | 'codingEnvironment'
    | 'saifctlDir'
    | 'enableSubtaskSequence'
  >;
  registry: CleanupRegistry | null;
  /** When set, abort the agent container when this signal fires (Hatchet cancellation). */
  signal?: AbortSignal;
}

/** Result of {@link runAgentPhase} — extracted patch text/path, pre-round HEAD, and per-commit metadata. */
export interface RunAgentPhaseOutput {
  /** Filtered diffs concatenated (bookkeeping / test gate). Empty when the agent made no changes. */
  patchContent: string;
  /** Absolute path to patch.diff written to sandboxBasePath */
  patchPath: string;
  /** HEAD at the start of this round (for Ralph reset on failure). */
  preRoundHeadSha: string;
  /** One entry per sandbox commit this round (+ optional WIP); empty when no capture-worthy changes. */
  commits: RunCommit[];
}

/**
 * Hatchet-step entry point: runs one coding-agent attempt via {@link runEngineAttempt},
 * extracts the resulting patch with {@link extractIncrementalRoundPatch}, and surfaces
 * Block 8 plan/spec/test modifications. Always tears down on exit.
 */
export async function runAgentPhase(input: RunAgentPhaseInput): Promise<RunAgentPhaseOutput> {
  const { sandbox, attempt, errorFeedback, task, patchExclude, opts, registry, signal } = input;

  const preRoundHead = (await git({ cwd: sandbox.codePath, args: ['rev-parse', 'HEAD'] })).trim();

  await runEngineAttempt({
    sandbox,
    attempt,
    errorFeedback,
    task,
    resumedCodingInfra: null,
    registry,
    signal: signal ?? null,
    preparePendingRules: false,
    // Hatchet steps always tear down — no pause/stop routing needed.
    onFinally: async () => 'teardown',
    opts: { ...opts, enableSubtaskSequence: false },
  });

  // Extract the changes as git patch.
  const {
    patch: patchContent,
    patchPath,
    commits,
  } = await extractIncrementalRoundPatch(sandbox.codePath, {
    preRoundHeadSha: preRoundHead,
    attempt,
    exclude: patchExclude,
  });

  // Block 8 (§9 "modification-surfacing warning"): surface plan/spec/test
  // edits to the run log + per-run JSONL breadcrumb. Mirrors the iterative
  // loop's wiring (see loop.ts). Only fires when the agent produced commits;
  // an empty round has nothing to surface and re-shelling out to git would
  // be a waste. We re-derive `git diff --name-only preRoundHead..HEAD` here
  // because the Hatchet path doesn't go through `inspectImmutableTestChanges`
  // (Block 7's mutability gate is loop-only); the cost is a single `git diff`
  // per committed round, which is negligible against the agent runtime.
  if (commits.length > 0 && opts.feature) {
    try {
      const diffOut = await git({
        cwd: sandbox.codePath,
        args: ['diff', '--name-only', `${preRoundHead}..HEAD`],
      });
      const changedPaths = diffOut
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (changedPaths.length > 0) {
        const featureRelativePath = relative(opts.projectDir, opts.feature.absolutePath).replaceAll(
          '\\',
          '/',
        );
        const phaseSpecFilenames = await loadPhaseSpecFilenames(opts.feature.absolutePath);
        await surfaceModifiedPathsAfterRound({
          round: attempt,
          subtaskIndex: input.surfaceContext?.subtaskIndex ?? 0,
          phaseId: input.surfaceContext?.phaseId ?? null,
          criticId: input.surfaceContext?.criticId ?? null,
          changedPaths,
          saifctlDir: opts.saifctlDir,
          featureRelativePath,
          phaseSpecFilenames,
          projectDir: opts.projectDir,
          runId: sandbox.runId,
        });
      }
    } catch (err) {
      // Soft signal — never fail a Hatchet step over a missing breadcrumb.
      consola.warn(
        `[run-agent-phase] Block 8 surfacing skipped this round (${err instanceof Error ? err.message : String(err)}). The run continues; the patch extraction above is the authoritative record.`,
      );
    }
  }

  const patchPaths = listFilePathsInUnifiedDiff(patchContent);
  if (!patchContent.trim()) {
    consola.log('[run-agent-phase] Patch empty — 0 file(s) in patch content');
  } else if (patchPaths.length === 0) {
    consola.warn(
      '[run-agent-phase] Non-empty patch but no paths parsed from diff --git headers — check patch format.',
    );
  } else {
    consola.log(
      `[run-agent-phase] Files in patch content (${patchPaths.length}): ${patchPaths.join(', ')}`,
    );
  }

  return { patchContent, patchPath, preRoundHeadSha: preRoundHead, commits };
}
