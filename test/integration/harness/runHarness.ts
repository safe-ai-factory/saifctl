/**
 * release-readiness/X-08 integration test harness — single in-process entry point for tests
 * that need to spin up a real Docker container, run the orchestrator end to
 * end, and assert on the resulting working tree / git history.
 *
 * Wraps `resolveOrchestratorOpts` + `runStart` (the same call site the CLI
 * uses at src/cli/commands/feat.ts:759). Tests do not shell out — that's
 * what makes orchestrator + sandbox engine modules reachable for coverage
 * (release-readiness/D-07, release-readiness/NPM-07).
 *
 * Per the plan in release-readiness/X-08-P1/P2: one knob set,
 * one happy-path API. Generalisation across providers / sandbox profiles
 * is release-readiness/X-01's job, not this harness's.
 */
import { join } from 'node:path';

import type { LlmOverrides } from '../../../src/llm-config.js';
import type { OrchestratorOutcomeStatus } from '../../../src/orchestrator/loop.js';
import { runStart } from '../../../src/orchestrator/modes.js';
import {
  type OrchestratorCliInput,
  resolveOrchestratorOpts,
} from '../../../src/orchestrator/options.js';
import type { Feature } from '../../../src/specs/discover.js';
import { commitsAheadOf, listBranches, readFileFromRef } from './assertions/git.js';
import { fileExists, readProjectFile } from './assertions/tree.js';
import { pruneStrayHarnessContainers, removeTmpProject } from './setup/cleanup.js';
import { dockerAvailable } from './setup/env-gate.js';
import { type CapturedStdio, startStdioCapture } from './setup/stdio-capture.js';
import { createTmpProject, type TmpProject } from './setup/tmp-project.js';

/** Hard-coded per release-readiness/X-08 plan locked decisions: one sandbox profile, one model. */
const DEFAULT_SANDBOX_PROFILE = 'node-pnpm';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

export interface HarnessRunOpts {
  /**
   * Fixture id. Today only `'dummy-feature'` exists; the literal documents
   * the surface and forces compile-time errors on typos. When more fixtures
   * are added, extend the union — the loader at
   * `setup/tmp-project.ts` reads from `test/integration/harness/fixtures/<id>/`.
   */
  fixture: 'dummy-feature';
  /** Feature name as it should appear under `<projectDir>/saifctl/features/`. Default: `'dummy'`. */
  featureName?: string;
  /** Coding agent profile id. `'debug'` (no LLM) or `'claude'` (real LLM). */
  agent: 'debug' | 'claude';
  /**
   * Real LLM provider. Hard-coded to `'anthropic'` per release-readiness/D-07. Required only when
   * `agent: 'claude'`; ignored for `'debug'`.
   */
  provider?: 'anthropic';
  /** Model override; default `claude-haiku-4-5`. Read from `SAIFCTL_TEST_MODEL` if set. */
  model?: string;
  /** Anthropic API key. Required when `agent: 'claude'`; passed through unredacted to the SDK. */
  anthropicApiKey?: string;
  /**
   * Whether to keep the tmp project dir on success / always / never. Failure
   * always keeps it (for debugging) regardless of this setting.
   */
  cleanup?: 'always' | 'on-success' | 'never';
  /**
   * Override `SAIFCTL_SKIP_NETWORK_PROBE` for the debug agent. Default `'0'` — runs the probe
   * so Cedar/Leash NetworkConnect regressions surface (the smoke's stated purpose). Set to
   * `'1'` to skip it on CI runners or local dev boxes without egress; the harness honors
   * `SAIFCTL_TEST_SKIP_NETWORK_PROBE=1` in the test process env as a global opt-out.
   */
  debugSkipNetworkProbe?: '0' | '1';
}

export interface HarnessResult {
  status: OrchestratorOutcomeStatus;
  message: string;
  attempts: number;
  runId: string | undefined;
  /** Tmp project root; kept on failure regardless of `cleanup` setting. */
  projectDir: string;
  /**
   * Feature branch the orchestrator produced (e.g. `saifctl/dummy-…`), if any.
   * The full pipeline applies the agent's patch to this branch — not to `main`.
   * Empty when no branch was produced (e.g. `skipStagingTests` runs).
   */
  producedBranch: string | null;
  /**
   * Number of commits reachable from `producedBranch` but not from `main`.
   * Verifies the orchestrator actually committed work, not just emitted an
   * empty branch. `0` when `producedBranch` is null.
   */
  commitsOnBranch: number;
  /**
   * True when `dummy.md` exists on `producedBranch` (or working tree if no
   * branch was produced).
   */
  dummyMdExists: boolean;
  /** Contents of `dummy.md` from the produced branch (or working tree fallback). */
  dummyMdContent: string | null;
  /**
   * Captured stdout/stderr from the orchestrator run. Includes consola log
   * lines, container log forwarding (`defaultEngineLog`), and any direct
   * child-process stderr writes. Used by P2's secret-leak assertion.
   */
  logs: CapturedStdio;
}

class HarnessSetupError extends Error {}

/**
 * Run a single integration scenario end-to-end.
 *
 * Throws `HarnessSetupError` when Docker is unavailable so the caller can map
 * to `it.skip`. Any other error propagates with the tmp project preserved.
 *
 * For `agent: 'claude'`, mutates `process.env.ANTHROPIC_API_KEY` for the
 * duration of the call (the orchestrator reads secret values from process env
 * via `resolveAgentSecretEnv`); the prior value (or absence) is restored in
 * the `finally` block on both success and throw.
 */
export async function runHarness(opts: HarnessRunOpts): Promise<HarnessResult> {
  if (!(await dockerAvailable())) {
    throw new HarnessSetupError('Docker daemon is not reachable; cannot run integration scenario');
  }

  // Hatchet dispatch must be off — the harness is in-process by design.
  if (process.env.HATCHET_CLIENT_TOKEN) {
    throw new HarnessSetupError(
      'HATCHET_CLIENT_TOKEN is set; integration harness requires local mode (unset it)',
    );
  }

  if (opts.agent === 'claude' && !opts.anthropicApiKey) {
    throw new HarnessSetupError("anthropicApiKey is required when agent: 'claude'");
  }

  const tmp = await createTmpProject({
    fixture: opts.fixture,
    featureName: opts.featureName,
  });

  // Snapshot env before any mutation so `finally` restores the exact prior
  // state — distinguishing "was unset" from "was empty string".
  const apiKeyWasSet = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
  const apiKeyPrev = process.env.ANTHROPIC_API_KEY;
  if (opts.agent === 'claude') {
    process.env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
  }

  // Capture stdout/stderr around the entire run for two reasons:
  //   (a) P2 verifies the API key never appears in any log line.
  //   (b) Mirror to disk at `<tmp>/harness.log` in real time so logs survive
  //       a vitest test timeout — the in-memory buffer is lost when the
  //       test fn is aborted, but the file persists. When a run hangs or
  //       times out, point the user at this file for triage.
  const mirrorPath = join(tmp.projectDir, 'harness.log');
  const capture = startStdioCapture({ mirrorPath });
  let partial: Omit<HarnessResult, 'logs'> | undefined;
  let runFailed = false;
  // On failure / timeout, surface the tmp dir + log path on a top banner
  // through stderr so it's visible even when vitest swallows captured output.
  const announceTriagePath = (): void => {
    process.stderr.write(
      `\n[harness] run failed or threw — full logs at: ${mirrorPath}\n` +
        `[harness] tmp project preserved at: ${tmp.projectDir}\n`,
    );
  };
  try {
    partial = await runOnce(tmp, opts);
    if (partial.status !== 'success') runFailed = true;
    return { ...partial, logs: capture.stop() };
  } catch (err) {
    runFailed = true;
    const logs = capture.stop();
    if (err instanceof Error) {
      Object.assign(err, { capturedLogs: logs, mirrorPath, tmpProjectDir: tmp.projectDir });
    }
    announceTriagePath();
    throw err;
  } finally {
    // `capture.stop()` is idempotent — calling it again here guards against
    // a re-entry that left it active (it's also a no-op on the success path).
    capture.stop();

    if (opts.agent === 'claude') {
      if (apiKeyWasSet) {
        process.env.ANTHROPIC_API_KEY = apiKeyPrev;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }

    // Belt-and-braces: even if the orchestrator's CleanupRegistry tore down its
    // own resources, prune anything matching the harness naming convention.
    await pruneStrayHarnessContainers();

    const cleanup = opts.cleanup ?? 'on-success';
    const shouldRemove = cleanup === 'always' || (cleanup === 'on-success' && !runFailed);
    if (shouldRemove) {
      await removeTmpProject(tmp.projectDir);
    }
  }
}

async function runOnce(
  tmp: TmpProject,
  opts: HarnessRunOpts,
): Promise<Omit<HarnessResult, 'logs'>> {
  const feature: Feature = {
    name: tmp.featureName,
    absolutePath: tmp.featureDir,
    relativePath: `${tmp.saifctlDir}/features/${tmp.featureName}`,
  };

  const config = {
    defaults: {
      sandboxProfile: DEFAULT_SANDBOX_PROFILE,
      agentProfile: opts.agent,
    },
  };

  const cliModelDelta = buildLlmOverrides(opts);

  const orchestratorOpts = await resolveOrchestratorOpts({
    projectDir: tmp.projectDir,
    saifctlDir: tmp.saifctlDir,
    config,
    feature,
    cli: {} as OrchestratorCliInput,
    cliModelDelta,
    artifact: null,
    engineCli: 'docker',
    projectNameFallback: 'saifctl-integ',
  });

  // Harness-locked overrides. These match the release-readiness/X-08 plan ("don't loop", "no
  // reviewer", run the full pipeline including staging tests). The orchestrator
  // applies the agent's patch to a generated feature branch (saifctl/<feat>-…);
  // the harness reads the resulting file from that branch via `git show`.
  orchestratorOpts.maxRuns = 1;
  orchestratorOpts.gateRetries = 1;
  orchestratorOpts.testRetries = 1;
  orchestratorOpts.reviewerEnabled = false;
  orchestratorOpts.resolveAmbiguity = 'off';
  orchestratorOpts.sandboxExtract = 'none';
  orchestratorOpts.skipStagingTests = false;
  orchestratorOpts.runStorage = null;
  orchestratorOpts.push = null;
  orchestratorOpts.pr = false;

  // Debug-agent network probe exercises Cedar/Leash NetworkConnect — the
  // smoke's stated purpose. Default ON. Per-call override via
  // `debugSkipNetworkProbe`; global opt-out via `SAIFCTL_TEST_SKIP_NETWORK_PROBE=1`
  // for CI runners / local dev boxes without egress.
  if (opts.agent === 'debug') {
    const envOptOut = process.env.SAIFCTL_TEST_SKIP_NETWORK_PROBE === '1' ? '1' : undefined;
    const skipProbe = opts.debugSkipNetworkProbe ?? envOptOut ?? '0';
    orchestratorOpts.agentEnv = {
      ...orchestratorOpts.agentEnv,
      SAIFCTL_SKIP_NETWORK_PROBE: skipProbe,
    };
  }

  // Anthropic key for the LLM scenario. The env mutation lives in `runHarness`
  // (with snapshot/restore in `finally`); here we only declare the key as a
  // secret so `resolveAgentSecretEnv` picks it up and the redaction layer
  // applies to launch-arg printing.
  if (opts.agent === 'claude') {
    orchestratorOpts.agentSecretKeys = Array.from(
      new Set([...orchestratorOpts.agentSecretKeys, 'ANTHROPIC_API_KEY']),
    );
  }

  const result = await runStart({ ...orchestratorOpts, fromArtifact: null });

  const branches = await listBranches(tmp.projectDir);
  const producedBranch = branches.find((b) => b.startsWith(`saifctl/${tmp.featureName}-`)) ?? null;

  let dummyMdContent: string | null = null;
  if (producedBranch) {
    dummyMdContent = await readFileFromRef({
      projectDir: tmp.projectDir,
      ref: producedBranch,
      relPath: 'dummy.md',
    });
  } else if (await fileExists(tmp.projectDir, 'dummy.md')) {
    dummyMdContent = await readProjectFile(tmp.projectDir, 'dummy.md');
  }

  const commitsOnBranch = producedBranch
    ? await commitsAheadOf({ projectDir: tmp.projectDir, base: 'main', head: producedBranch })
    : 0;

  return {
    status: result.status,
    message: result.message,
    attempts: result.attempts,
    runId: result.runId,
    projectDir: tmp.projectDir,
    producedBranch,
    commitsOnBranch,
    dummyMdExists: dummyMdContent !== null,
    dummyMdContent,
  };
}

function buildLlmOverrides(opts: HarnessRunOpts): LlmOverrides | undefined {
  if (opts.agent !== 'claude') return undefined;
  const provider = opts.provider ?? 'anthropic';
  if (provider !== 'anthropic') {
    throw new HarnessSetupError(`Unsupported provider for harness: ${provider as string}`);
  }
  const model = opts.model ?? process.env.SAIFCTL_TEST_MODEL?.trim() ?? DEFAULT_ANTHROPIC_MODEL;
  return {
    globalModel: `anthropic/${model}`,
  };
}
