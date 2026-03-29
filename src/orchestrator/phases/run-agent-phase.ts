/**
 * Phase: run-agent-phase
 *
 * Runs the coder agent inside the coding container (Leash or local) for one
 * attempt, then extracts the resulting patch. Used by the Hatchet workflow step.
 *
 * Engine lifecycle (register → setup → runAgent → deregister → teardown) is
 * delegated to {@link runEngineAttempt}. This phase only adds patch extraction
 * on top.
 *
 * Unlike {@link runCodingPhase} (used by the iterative loop), this phase:
 * - Always tears down on exit (no pause/stop routing)
 * - Does not start a rules watcher
 * - Returns patch content rather than a discriminated outcome
 */

import { consola } from '../../logger.js';
import type { RunCommit } from '../../runs/types.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { git } from '../../utils/git.js';
import type { IterativeLoopOpts } from '../loop.js';
import {
  extractIncrementalRoundPatch,
  listFilePathsInUnifiedDiff,
  type PatchExcludeRule,
  type Sandbox,
} from '../sandbox.js';
import { runEngineAttempt } from './run-engine-attempt.js';

export interface RunAgentPhaseInput {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed) */
  attempt: number;
  /** Error feedback from the previous test run (empty on first attempt) */
  errorFeedback: string;
  /** Initial task prompt (built once per loop from plan.md + specification.md) */
  task: string;
  /** Patch exclusion rules (saifctlDir + .git/hooks/ already included) */
  patchExclude: PatchExcludeRule[];
  opts: Pick<
    IterativeLoopOpts,
    | 'overrides'
    | 'projectDir'
    | 'projectName'
    | 'feature'
    | 'dangerousNoLeash'
    | 'cedarPolicyPath'
    | 'coderImage'
    | 'gateRetries'
    | 'agentEnv'
    | 'agentSecretKeys'
    | 'agentSecretFiles'
    | 'agentProfileId'
    | 'reviewerEnabled'
    | 'codingEnvironment'
    | 'saifctlDir'
  >;
  registry: CleanupRegistry | null;
  /** When set, abort the agent container when this signal fires (Hatchet cancellation). */
  signal?: AbortSignal;
}

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
    opts,
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
