/**
 * Run a sandboxed agent, without the overhead of features, tests, or staging tests.
 *
 * Used by `saifctl sandbox` and the POC designer.
 *
 * Applies the standard sandbox overrides (no staging tests, no reviewer, maxRuns=1,
 * resolveAmbiguity=off) and delegates to {@link runStart}.
 */

import { spawn } from 'node:child_process';

import type { SaifctlConfig } from '../config/schema.js';
import type { LlmOverrides } from '../llm-config.js';
import { consola } from '../logger.js';
import type { Feature } from '../specs/discover.js';
import type { OrchestratorResult } from './loop.js';
import { runStart } from './modes.js';
import { type OrchestratorCliInput, resolveOrchestratorOpts } from './options.js';
import type { SandboxExtractMode } from './phases/sandbox-extract.js';

/** Options for {@link runSandbox}. */
export interface RunSandboxOpts {
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  /** Caller constructs this — typically points at a tmpdir, not saifctl/features/. */
  feature: Feature;
  /** CLI/profile-specific overrides (gate script, cedar policy, agent profile, etc.). */
  cli: OrchestratorCliInput;
  cliModelDelta?: LlmOverrides;
  /** Engine selector string (e.g. 'docker'); `undefined` = use config default. */
  engineCli?: string;
  /** Task prompt for the agent when not using `--subtasks` (replaces resolved subtasks). */
  task?: string;
  /** Controls whether/how agent commits are applied to the host working tree. */
  extract: SandboxExtractMode;
  /** Required when `extract` is `'host-apply-filtered'`. */
  extractInclude?: string;
  extractExclude?: string;
}

/** Options for {@link runSandboxInteractive}. */
export interface RunSandboxInteractiveOpts {
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  /** Caller constructs this — typically points at a tmpdir, not saifctl/features/. */
  feature: Feature;
  /** CLI/profile-specific overrides (gate script, cedar policy, agent profile, etc.). */
  cli: OrchestratorCliInput;
  cliModelDelta?: LlmOverrides;
  /** Engine selector string (e.g. 'docker'); `undefined` = use config default. */
  engineCli?: string;
  /** Controls whether/how changes made inside the container are applied to the host working tree after the session ends. */
  extract: SandboxExtractMode;
  /** Required when `extract` is `'host-apply-filtered'`. */
  extractInclude?: string;
  extractExclude?: string;
}

/**
 * Resolves orchestrator options, applies sandbox-mode overrides, and runs the agent.
 *
 * Hardcoded overrides (never negotiable for sandbox runs):
 *   - `reviewerEnabled = false`
 *   - `maxRuns = 1`
 *   - `resolveAmbiguity = 'off'`
 *   - `skipStagingTests = true`
 *   - `allowSaifctlInPatch = true`
 *   - `subtasks` replaced with a single row from `opts.task` when a task string is provided
 */
export async function runSandbox(opts: RunSandboxOpts): Promise<OrchestratorResult> {
  const {
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    engineCli,
    task,
    extract,
    extractInclude,
    extractExclude,
  } = opts;

  const orchestratorOpts = await resolveOrchestratorOpts({
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    artifact: null,
    engineCli,
    projectNameFallback: `sandbox-${feature.name}`,
  });

  orchestratorOpts.reviewerEnabled = false;
  orchestratorOpts.maxRuns = 1;
  orchestratorOpts.resolveAmbiguity = 'off';
  orchestratorOpts.skipStagingTests = true;
  const taskTrimmed = typeof task === 'string' ? task.trim() : '';
  const usedSubtasksFile = Boolean(cli.subtasksFilePath?.trim());
  if (taskTrimmed && !usedSubtasksFile) {
    orchestratorOpts.subtasks = [
      {
        content: taskTrimmed,
        title: feature.name,
        gateScript: orchestratorOpts.gateScript,
      },
    ];
    orchestratorOpts.currentSubtaskIndex = 0;
  }
  orchestratorOpts.enableSubtaskSequence = orchestratorOpts.subtasks.length > 1;
  orchestratorOpts.sandboxExtract = extract;
  orchestratorOpts.sandboxExtractInclude = extractInclude;
  orchestratorOpts.sandboxExtractExclude = extractExclude;

  return runStart({ ...orchestratorOpts, fromArtifact: null });
}

/**
 * Starts an interactive sandbox container: runs startup + agent-install scripts via
 * `sandbox-start.sh`, then idles (`sleep infinity`) so the user can connect with
 * `docker exec -it <container> bash`.
 *
 * No task, no gate, no reviewer, no outer loop.
 * Blocks until the user sends SIGINT/SIGTERM, then tears down the container.
 *
 * Hardcoded overrides:
 *   - `reviewerEnabled = false`
 *   - `maxRuns = 1`
 *   - `resolveAmbiguity = 'off'`
 *   - `skipStagingTests = true`
 *   - `allowSaifctlInPatch = true`
 *   - `sandboxInteractive = true` (omits task/gate env vars from the container)
 *   - `inspectMode` set with `entryCommand = ['bash', '/saifctl/sandbox-start.sh']`
 */
export async function runSandboxInteractive(
  opts: RunSandboxInteractiveOpts,
): Promise<OrchestratorResult> {
  const {
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    engineCli,
    extract,
    extractInclude,
    extractExclude,
  } = opts;

  const orchestratorOpts = await resolveOrchestratorOpts({
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    artifact: null,
    engineCli,
    projectNameFallback: `sandbox-${feature.name}`,
  });

  orchestratorOpts.reviewerEnabled = false;
  orchestratorOpts.maxRuns = 1;
  orchestratorOpts.resolveAmbiguity = 'off';
  orchestratorOpts.skipStagingTests = true;
  orchestratorOpts.allowSaifctlInPatch = true;
  orchestratorOpts.sandboxInteractive = true;
  orchestratorOpts.sandboxExtract = extract;
  orchestratorOpts.sandboxExtractInclude = extractInclude;
  orchestratorOpts.sandboxExtractExclude = extractExclude;

  // Provide a dummy subtask so the loop has something to iterate over; the agent is never
  // invoked (the container runs sandbox-start.sh → sleep, not coder-start.sh).
  orchestratorOpts.subtasks = [
    {
      content: '(interactive sandbox — no task)',
      title: feature.name,
      gateScript: orchestratorOpts.gateScript,
    },
  ];
  orchestratorOpts.currentSubtaskIndex = 0;
  orchestratorOpts.enableSubtaskSequence = false;

  // inspectMode replaces the coding agent with an idle container and calls onReady() to block.
  // entryCommand runs sandbox-start.sh (startup + agent-install) before sleeping.
  orchestratorOpts.inspectMode = {
    entryCommand: ['bash', '/saifctl/sandbox-start.sh'],
    async onReady(session) {
      consola.log(`\n[sandbox] Container ready — workspace: ${session.workspacePath}`);
      consola.log('[sandbox] Starting interactive shell (exit or Ctrl+D when done)...\n');

      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', ['exec', '-it', session.containerName, 'bash'], {
          stdio: 'inherit',
        });

        child.once('error', reject);

        child.once('close', () => {
          resolve();
        });

        // If saifctl itself is signalled externally, close the exec'd shell gracefully.
        const onSignal = () => {
          if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        };
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);

        child.once('close', () => {
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        });
      });

      consola.log('\n[sandbox] Shell exited — stopping container...');
    },
  };

  return runStart({ ...orchestratorOpts, fromArtifact: null });
}
