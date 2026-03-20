/**
 * Phase: run-agent-phase
 *
 * Runs the coder agent inside the coding provisioner (Leash + OpenHands or
 * --dangerous-debug direct). Returns the raw patch content produced by the agent.
 *
 * This is the inner atom for a single attempt:
 *   setup provisioner → runAgent → teardown provisioner → extractPatch
 *
 * The entire operation runs inside a `try/finally` so teardown() always fires,
 * even when Hatchet cancels the step (ctx.abortController.signal fires).
 */

import { join } from 'node:path';

import { getSaifRoot } from '../../constants.js';
import { resolveAgentLlmConfig } from '../../llm-config.js';
import { createProvisioner } from '../../provisioners/index.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { gitApply } from '../../utils/git.js';
import type { IterativeLoopOpts } from '../loop.js';
import { extractPatch, type PatchExcludeRule, type Sandbox } from '../sandbox.js';
import { getArgusBinaryPath } from '../sidecars/reviewer/argus.js';

export interface RunAgentPhaseInput {
  sandbox: Sandbox;
  /** Which outer attempt this is (1-indexed) */
  attempt: number;
  /** Error feedback from the previous test run (empty on first attempt) */
  errorFeedback: string;
  /** Initial task prompt (built once per loop from plan.md + specification.md) */
  task: string;
  /** Patch exclusion rules (saifDir + .git/hooks/ already included) */
  patchExclude: PatchExcludeRule[];
  opts: Pick<
    IterativeLoopOpts,
    | 'overrides'
    | 'projectDir'
    | 'projectName'
    | 'feature'
    | 'dangerousDebug'
    | 'cedarPolicyPath'
    | 'coderImage'
    | 'gateRetries'
    | 'agentEnv'
    | 'agentLogFormat'
    | 'reviewerEnabled'
    | 'codingEnvironment'
    | 'saifDir'
  >;
  registry: CleanupRegistry | null;
  /** When set, abort the agent container when this signal fires (Hatchet cancellation). */
  signal?: AbortSignal;
}

export interface RunAgentPhaseOutput {
  /** Filtered diff produced by the agent. Empty string when the agent made no changes. */
  patchContent: string;
  /** Absolute path to patch.diff written to sandboxBasePath */
  patchPath: string;
}

export async function runAgentPhase(input: RunAgentPhaseInput): Promise<RunAgentPhaseOutput> {
  const { sandbox, attempt, errorFeedback, task, patchExclude, opts, registry, signal } = input;
  const {
    overrides,
    projectDir,
    projectName,
    feature,
    dangerousDebug,
    cedarPolicyPath,
    coderImage,
    gateRetries,
    agentEnv,
    agentLogFormat,
    reviewerEnabled,
    codingEnvironment,
    saifDir,
  } = opts;

  const coderLlmConfig = resolveAgentLlmConfig('coder', overrides);
  const reviewer =
    reviewerEnabled && !dangerousDebug
      ? {
          llmConfig: resolveAgentLlmConfig('reviewer', overrides),
          scriptPath: join(getSaifRoot(), 'src', 'orchestrator', 'scripts', 'reviewer.sh'),
          argusBinaryPath: getArgusBinaryPath(),
        }
      : null;

  const codingRunId = `${sandbox.runId}-coding-${attempt}`;
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
      agentStartPath: sandbox.agentStartPath,
      agentPath: sandbox.agentPath,
      agentEnv,
      agentLogFormat,
      reviewer,
      signal,
    });
  } finally {
    registry?.deregisterProvisioner(codingProvisioner);
    await codingProvisioner.teardown({ runId: codingRunId });
  }

  const { patch: patchContent, patchPath } = await extractPatch(sandbox.codePath, {
    exclude: patchExclude,
  });

  if (patchContent.trim()) {
    // Re-apply so tests can run against the patched code.
    // extractPatch resets to base state, so we need to re-apply.
    await gitApply({ cwd: sandbox.codePath, patchFile: patchPath });
  }

  return { patchContent, patchPath };
}
