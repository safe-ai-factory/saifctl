/**
 * Orchestrator option merge and resolution: CLI/artifact layers, LLM config, and full {@link OrchestratorOpts} resolution.
 */

import { resolve } from 'node:path';

import { DEFAULT_AGENT_PROFILE, resolveAgentProfile } from '../agent-profiles/index.js';
import type { AgentProfile } from '../agent-profiles/types.js';
import {
  KEY_EQ_PATTERN,
  loadAgentScriptsFromPicks,
  loadGateScriptFromPick,
  loadStageScriptFromPick,
  loadStartupScriptFromPick,
  loadTestScriptFromPick,
  mergeAgentEnvFromReads,
  parseCommaSeparatedOverrides,
  resolveProjectName,
  resolveRunStorage,
} from '../cli/utils.js';
import {
  DEFAULT_STAGING_APP,
  type NormalizedCodingEnvironment,
  type NormalizedStagingEnvironment,
  type SaifctlConfig,
  type StagingAppConfig,
} from '../config/schema.js';
import {
  DEFAULT_DANGEROUS_NO_LEASH,
  DEFAULT_ORCHESTRATOR_GATE_RETRIES,
  DEFAULT_ORCHESTRATOR_MAX_RUNS,
  DEFAULT_ORCHESTRATOR_TEST_RETRIES,
  DEFAULT_RESOLVE_AMBIGUITY,
  DEFAULT_REVIEWER_ENABLED,
  defaultCedarPolicyPath,
} from '../constants.js';
import { getGitProvider } from '../git/index.js';
import type { GitProvider } from '../git/types.js';
import { isSupportedAgentName, type LlmOverrides, SUPPORTED_AGENT_NAMES } from '../llm-config.js';
import { consola } from '../logger.js';
import type { RunArtifact, RunSubtaskInput } from '../runs/types.js';
import { deserializeArtifactConfig } from '../runs/utils/serialize.js';
import { runSubtasksToInputs } from '../runs/utils/subtasks.js';
import { DEFAULT_SANDBOX_PROFILE, resolveSandboxProfile } from '../sandbox-profiles/index.js';
import type { SandboxProfile } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import { DEFAULT_TEST_PROFILE, resolveTestProfile } from '../test-profiles/index.js';
import type { TestProfile } from '../test-profiles/types.js';
import { validateImageTag } from '../utils/docker.js';
import { readUtf8 } from '../utils/io.js';
import { mergeAgentSecretKeysFromReads } from './agent-env.js';
import type { OrchestratorOpts } from './modes.js';
import { loadSubtasksFromFile, resolveSubtasks } from './resolve-subtasks.js';
import { DEFAULT_SANDBOX_BASE_DIR } from './sandbox.js';

// ---------------------------------------------------------------------------
// LLM overrides: config baseline → artifact → CLI delta
// ---------------------------------------------------------------------------

/** Agent name (key before =) must not contain comma, whitespace, or equals. */
const MODEL_AGENT_NAME_PATTERN = /^[^,\s=]+$/;

/**
 * Merges LLM overrides layers in order — config baseline, then artifact, then CLI delta —
 * with later layers winning per-field. Field maps (`agentModels`, `agentBaseUrls`) merge by key.
 */
export function mergeLlmOverridesLayers( // eslint-disable-line max-params -- three explicit layers
  configBaseline: LlmOverrides,
  artifact?: LlmOverrides,
  cliDelta?: LlmOverrides,
): LlmOverrides {
  const out: LlmOverrides = { ...configBaseline };

  const apply = (layer?: LlmOverrides) => {
    if (!layer) return;
    if (layer.globalModel !== undefined) out.globalModel = layer.globalModel;
    if (layer.globalBaseUrl !== undefined) out.globalBaseUrl = layer.globalBaseUrl;
    if (layer.agentModels) out.agentModels = { ...out.agentModels, ...layer.agentModels };
    if (layer.agentBaseUrls) out.agentBaseUrls = { ...out.agentBaseUrls, ...layer.agentBaseUrls };
  };

  apply(artifact);
  apply(cliDelta);
  return out;
}

/** `config.defaults` model fields only (baseline before artifact / CLI deltas). */
export function llmOverridesFromSaifctlConfig(config?: SaifctlConfig): LlmOverrides {
  const llm: LlmOverrides = {};
  const d = config?.defaults;
  if (d?.globalModel) llm.globalModel = d.globalModel;
  if (d?.globalBaseUrl) llm.globalBaseUrl = d.globalBaseUrl;
  if (d?.agentModels) llm.agentModels = { ...d.agentModels };
  if (d?.agentBaseUrls) llm.agentBaseUrls = { ...d.agentBaseUrls };
  return llm;
}

/**
 * Parses **only** `--model` / `--base-url` from the current CLI invocation — the “CLI delta” layer.
 *
 * Unlike {@link mergeLlmOverridesLayers} with a config baseline, this does **not** merge `config.defaults` model fields.
 * That matters for **from-artifact** and **test-from-run**: final LLM overrides are built in
 * {@link mergeLlmOverridesLayers} as **config baseline → Run artifact → CLI delta**.
 * If the user omits both flags here, returning `undefined` means the delta layer adds nothing.
 */
export function parseLlmOverridesCliDelta(args: {
  model?: string;
  'base-url'?: string;
}): LlmOverrides | undefined {
  const overrides: LlmOverrides = {};
  const modelRaw = typeof args.model === 'string' ? args.model.trim() : '';
  if (modelRaw) {
    const parsed = parseCommaSeparatedOverrides({
      raw: modelRaw,
      isKeyValue: (p) => p.includes('='),
      /* eslint-disable-next-line max-params */
      validateKeyValue: (key, value, exit) => {
        if (!key || !MODEL_AGENT_NAME_PATTERN.test(key)) {
          exit(
            'malformed part: expected model or agent=model (agent name must not contain comma, whitespace, or equals).',
          );
        }
        if (!isSupportedAgentName(key)) {
          exit(`unknown agent "${key}". Supported: ${SUPPORTED_AGENT_NAMES.join(', ')}.`);
        }
        if (!value) {
          exit('malformed part: expected agent=model (model value must not be empty).');
        }
      },
      errorPrefix: '--model',
    });
    if (parsed.global) overrides.globalModel = parsed.global;
    if (parsed.keys && Object.keys(parsed.keys).length > 0) {
      overrides.agentModels = { ...parsed.keys };
    }
  }

  const baseUrlRaw = typeof args['base-url'] === 'string' ? args['base-url'].trim() : '';
  if (baseUrlRaw) {
    const parsed = parseCommaSeparatedOverrides({
      raw: baseUrlRaw,
      isKeyValue: (p) => KEY_EQ_PATTERN.test(p),
      /* eslint-disable-next-line max-params */
      validateKeyValue: (key, value, exit) => {
        if (!key || !MODEL_AGENT_NAME_PATTERN.test(key)) {
          exit(
            'malformed part: expected base-url or agent=url (agent name must not contain comma, whitespace, or equals).',
          );
        }
        if (!isSupportedAgentName(key)) {
          exit(`unknown agent "${key}". Supported: ${SUPPORTED_AGENT_NAMES.join(', ')}.`);
        }
        if (!value) {
          exit('malformed part: expected agent=url (URL value must not be empty).');
        }
      },
      errorPrefix: '--base-url',
    });
    if (parsed.global) overrides.globalBaseUrl = parsed.global;
    if (parsed.keys && Object.keys(parsed.keys).length > 0) {
      overrides.agentBaseUrls = { ...parsed.keys };
    }
  }

  if (
    overrides.globalModel === undefined &&
    overrides.globalBaseUrl === undefined &&
    !overrides.agentModels &&
    !overrides.agentBaseUrls
  ) {
    return undefined;
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Merge (CLI overlay + model override layers)
// ---------------------------------------------------------------------------

const ORCHESTRATOR_MERGE_KEYS = [
  'sandboxProfileId',
  'agentProfileId',
  'feature',
  'projectDir',
  'maxRuns',
  'saifctlDir',
  'sandboxBaseDir',
  'projectName',
  'testImage',
  'resolveAmbiguity',
  'testRetries',
  'dangerousNoLeash',
  'cedarPolicyPath',
  'coderImage',
  'startupScript',
  'startupScriptFile',
  'gateScript',
  'gateScriptFile',
  'agentInstallScript',
  'agentInstallScriptFile',
  'agentScript',
  'agentScriptFile',
  'stageScript',
  'stageScriptFile',
  'testScript',
  'testScriptFile',
  'testProfile',
  'agentEnv',
  'agentSecretKeys',
  'agentSecretFiles',
  'gateRetries',
  'reviewerEnabled',
  'includeDirty',
  'strict',
  'push',
  'pr',
  'targetBranch',
  'gitProvider',
  'runStorage',
  'stagingEnvironment',
  'codingEnvironment',
  'patchExclude',
  'allowSaifctlInPatch',
  'subtasks',
  'currentSubtaskIndex',
  'fromArtifact',
  'verbose',
  'skipStagingTests',
  'sandboxExtract',
  'sandboxExtractInclude',
  'sandboxExtractExclude',
] as const satisfies readonly (keyof OrchestratorOpts)[];

/**
 * CLI payload: every {@link OrchestratorOpts} key may appear; `undefined` means “do not override” (merge).
 * {@link subtasksFilePath} is handled in {@link resolveOrchestratorOpts} and is not part of merged opts.
 */
export type OrchestratorCliInput = {
  [K in keyof OrchestratorOpts]: OrchestratorOpts[K] | undefined;
} & {
  /** When set, replaces resolved subtasks from this path (relative to project dir or absolute). */
  subtasksFilePath?: string;
};

/**
 * Shallow merge: `overlay` keys that are not `undefined` replace `base`.
 * Does not touch `llm` — resolved separately via {@link mergeLlmOverridesLayers}.
 */
function mergeDefinedOrchestratorOpts(
  base: OrchestratorOpts,
  overlay: OrchestratorCliInput,
): OrchestratorOpts {
  const out = { ...base };
  for (const key of ORCHESTRATOR_MERGE_KEYS) {
    const v = overlay[key];
    if (v !== undefined) {
      (out as Record<string, unknown>)[key as string] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default baseline from config + profiles (no feat-run CLI; merge applies deltas)
// ---------------------------------------------------------------------------

/** Inputs to {@link applyOrchestratorBaseline} — feature, project paths, config, and resume hints. */
export interface OrchestratorBaselineContext {
  feature: Feature;
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  /**
   * Fallback project name used when no explicit `--project`, config default, or `package.json`
   * name is found. When omitted, missing project name throws. Used by `saifctl sandbox` where
   * the project directory may not be a Node package.
   */
  projectNameFallback?: string;
  /**
   * Whether an artifact will overwrite `subtasks` after baseline (`run resume` / fork).
   * When true, baseline skips phase compilation entirely — recompiling the feature dir
   * is wasted work and (more importantly) must not exit-1 on a stale `feature.yml`
   * when the artifact already carries authoritative subtasks.
   */
  artifactWillOverride?: boolean;
  /**
   * Path passed via `--subtasks <file>` (relative to project dir or absolute).
   * When set, baseline loads that file directly instead of compiling phases /
   * reading subtasks.json — matching the documented escape-hatch precedence
   * (Block 3 of TODO_phases_and_critics §3).
   */
  subtasksFilePath?: string;
}

/**
 * Baseline {@link OrchestratorOpts}: `config.defaults` + package constants + profile defaults.
 * No feat-run CLI flags — those are merged later via {@link mergeDefinedOrchestratorOpts}.
 */
async function applyOrchestratorBaseline(
  ctx: OrchestratorBaselineContext,
): Promise<OrchestratorOpts> {
  const {
    feature,
    projectDir,
    saifctlDir,
    config,
    projectNameFallback,
    artifactWillOverride,
    subtasksFilePath,
  } = ctx;
  const noCli = undefined;

  const maxRuns = config?.defaults?.maxRuns ?? DEFAULT_ORCHESTRATOR_MAX_RUNS;
  const llm = mergeLlmOverridesLayers(llmOverridesFromSaifctlConfig(config), undefined, undefined);
  const sandboxBaseDir = resolveSandboxBaseDir(config);
  const projectName = await resolveProjectName({
    projectDir,
    config,
    fallback: projectNameFallback,
  });
  const testProfile = pickTestProfile(noCli, config);
  const testImage = resolveTestImageTag(noCli, testProfile.id, config);
  const resolveAmbiguity = config?.defaults?.resolveAmbiguity ?? DEFAULT_RESOLVE_AMBIGUITY;
  const testRetries = config?.defaults?.testRetries ?? DEFAULT_ORCHESTRATOR_TEST_RETRIES;
  const dangerousNoLeash = config?.defaults?.dangerousNoLeash ?? DEFAULT_DANGEROUS_NO_LEASH;
  const cedarPolicyPath = config?.defaults?.cedarPolicyPath ?? defaultCedarPolicyPath();
  const cedarScript = await readUtf8(cedarPolicyPath);
  const sandboxProfile = pickSandboxProfile(noCli, config);
  const agentProfile = pickAgentProfile(noCli, config);
  const coderImage = resolveCoderImage(config, sandboxProfile);

  const startupPick = pickStartupScript(noCli, config);
  const gatePick = pickGateScript(noCli, config);
  const stagePick = pickStageScript(noCli, config);
  const testScriptPick = pickTestScript(noCli, config);
  const agentInstallPick = pickAgentInstallScript(noCli);
  const agentRunScriptPick = pickAgentScript(noCli);

  const [startupR, gateR, agentR, stageR, testR] = await Promise.all([
    loadStartupScriptFromPick({
      pick: startupPick,
      sandboxProfileId: sandboxProfile.id,
      projectDir,
    }),
    loadGateScriptFromPick({ pick: gatePick, sandboxProfileId: sandboxProfile.id, projectDir }),
    loadAgentScriptsFromPicks({
      installPick: agentInstallPick,
      scriptPick: agentRunScriptPick,
      agentProfileId: agentProfile.id,
      projectDir,
    }),
    loadStageScriptFromPick({ pick: stagePick, sandboxProfileId: sandboxProfile.id, projectDir }),
    loadTestScriptFromPick({
      pick: testScriptPick,
      testProfileId: testProfile.id,
      projectDir,
    }),
  ]);

  const gateRetries = config?.defaults?.gateRetries ?? DEFAULT_ORCHESTRATOR_GATE_RETRIES;
  const reviewerEnabled = config?.defaults?.reviewerEnabled ?? DEFAULT_REVIEWER_ENABLED;
  const includeDirty = config?.defaults?.includeDirty ?? false;
  // Block 7: project-wide test mutability default. CLI delta (`--strict` /
  // `--no-strict`) is merged in later via `mergeDefinedOrchestratorOpts`;
  // here we only resolve baseline → config → built-in default `true`.
  const strict = config?.defaults?.strict ?? true;

  // Subtasks priority (Block 3 of TODO_phases_and_critics):
  //   1. `--subtasks <file>` (escape hatch) — loaded directly here so the
  //      mutual-exclusion check in `resolveSubtasks` is bypassed.
  //   2. Artifact resume (`run resume` / fork) — baseline returns a placeholder
  //      that `mergeArtifactOntoDefaults` overwrites with the artifact's
  //      authoritative subtasks. Skips phase compilation entirely so a stale
  //      `feature.yml` can't fail-fast a resume that wouldn't have used it.
  //   3. Otherwise — `resolveSubtasks` chooses between phases/, subtasks.json,
  //      or the synthesized plan-only path.
  let subtasks: RunSubtaskInput[];
  const subtasksFileRaw = subtasksFilePath?.trim();
  if (subtasksFileRaw) {
    subtasks = await loadSubtasksFromFile(resolve(projectDir, subtasksFileRaw));
  } else if (artifactWillOverride) {
    subtasks = [];
  } else {
    subtasks = await resolveSubtasks({
      subtasksFlag: undefined,
      featureAbsolutePath: feature.absolutePath,
      featureName: feature.name,
      saifctlDir,
      gateScript: gateR.gateScript,
      projectDir,
    });
  }
  const currentSubtaskIndex = 0;

  const agentEnv = await mergeAgentEnvFromReads({
    projectDir,
    config,
    fileRaw: undefined,
    pairSegments: [],
  });
  const agentSecretKeys = await mergeAgentSecretKeysFromReads({
    config,
    extraSecretKeys: [],
  });
  const push = config?.defaults?.push ?? null;
  const pr = resolvePr(config, push);
  const targetBranch = null;
  const gitProvider = resolveGitProvider(config);
  const runStorage = resolveRunStorage(noCli, projectDir, config);
  const stagingEnvironment = resolveStagingEnvironment(config);
  const codingEnvironment = config?.environments?.coding ?? { engine: 'docker' as const };

  return {
    sandboxProfileId: sandboxProfile.id,
    agentProfileId: agentProfile.id,
    feature,
    projectDir,
    maxRuns,
    llm,
    saifctlDir,
    sandboxBaseDir,
    projectName,
    testImage,
    resolveAmbiguity,
    testRetries,
    dangerousNoLeash,
    cedarPolicyPath,
    cedarScript,
    coderImage,
    startupScript: startupR.startupScript,
    startupScriptFile: startupR.startupScriptFile,
    gateScript: gateR.gateScript,
    gateScriptFile: gateR.gateScriptFile,
    agentInstallScript: agentR.agentInstallScript,
    agentInstallScriptFile: agentR.agentInstallScriptFile,
    agentScript: agentR.agentScript,
    agentScriptFile: agentR.agentScriptFile,
    stageScript: stageR.stageScript,
    stageScriptFile: stageR.stageScriptFile,
    testScript: testR.testScript,
    testScriptFile: testR.testScriptFile,
    testProfile,
    agentEnv,
    agentSecretKeys,
    agentSecretFiles: [],
    gateRetries,
    reviewerEnabled,
    includeDirty,
    strict,
    push,
    pr,
    targetBranch,
    gitProvider,
    runStorage,
    stagingEnvironment,
    codingEnvironment,
    fromArtifact: null,
    verbose: false,
    testOnly: false,
    allowSaifctlInPatch: false,
    skipStagingTests: false,
    sandboxExtract: 'none',
    subtasks,
    currentSubtaskIndex,
    enableSubtaskSequence: subtasks.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Resolve defaults → artifact → CLI
// ---------------------------------------------------------------------------

/** Inputs to {@link resolveOrchestratorOpts}: project, config, feature, CLI overrides, and an optional artifact to layer on top of defaults. */
export interface ResolveOrchestratorOptsParams {
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  /** Resolved feature (prompt/CLI for start; from artifact for from-artifact/test-from-run). */
  feature: Feature;
  cli: OrchestratorCliInput;
  cliModelDelta: LlmOverrides | undefined;
  artifact: RunArtifact | null;
  /**
   * Optional `--engine` string: global `docker` | `helm` | `local`, or `coding=…,staging=…`.
   * Overrides `codingEnvironment` / `stagingEnvironment` after config/artifact/CLI merge;
   * reuses file config for a phase when its engine matches the target.
   */
  engineCli: string | undefined;
  /**
   * Fallback project name when no explicit `--project`, config default, or `package.json`
   * name is found. When omitted, missing project name throws. Used by `saifctl sandbox` where
   * the project directory may not be a Node package.
   */
  projectNameFallback?: string;
}

/**
 * `defaults → artifact (when present) → cli (defined fields only)`; `llm` uses
 * `config → artifact → cliModelDelta`.
 */
export async function resolveOrchestratorOpts(
  params: ResolveOrchestratorOptsParams,
): Promise<OrchestratorOpts> {
  const {
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    artifact,
    engineCli,
    projectNameFallback,
  } = params;

  const defaults = await applyOrchestratorBaseline({
    feature,
    projectDir,
    saifctlDir,
    config,
    projectNameFallback,
    artifactWillOverride: artifact !== null,
    subtasksFilePath: cli.subtasksFilePath,
  });

  let base = defaults;
  if (artifact) {
    base = await mergeArtifactOntoDefaults(defaults, artifact, {
      projectDir,
      feature: params.feature,
    });
  }

  const merged = mergeDefinedOrchestratorOpts(base, cli);

  const artifactLlm = artifact ? deserializeArtifactConfig(artifact.config).llm : undefined;
  merged.llm = mergeLlmOverridesLayers(
    llmOverridesFromSaifctlConfig(config),
    artifactLlm,
    cliModelDelta,
  );

  if (cli.runStorage !== undefined) {
    merged.runStorage = cli.runStorage;
  }

  const engineTrimmed = engineCli?.trim();
  if (engineTrimmed) {
    applyEngineCliToOrchestratorOpts(merged, config, engineTrimmed);
  }

  if (merged.codingEnvironment.engine === 'local') {
    merged.dangerousNoLeash = false;
    merged.reviewerEnabled = false;
  }

  if (merged.pr && !merged.push) {
    consola.error('Error: --pr requires --push <target>.');
    process.exit(1);
  }

  // `--subtasks` was already consumed by `applyOrchestratorBaseline` above
  // (the file is loaded directly there to bypass phase compilation entirely).
  // No re-loading needed here; merged.subtasks already reflects it.

  const keepArtifactCedar = artifact !== null && cli.cedarPolicyPath === undefined;
  if (!keepArtifactCedar) {
    merged.cedarScript = await readUtf8(merged.cedarPolicyPath);
  }

  merged.enableSubtaskSequence = merged.subtasks.length > 1;

  return merged;
}

/* eslint-disable-next-line max-params -- (defaults, artifact, ctx) */
async function mergeArtifactOntoDefaults(
  defaults: OrchestratorOpts,
  artifact: RunArtifact,
  ctx: { projectDir: string; feature: Feature },
): Promise<OrchestratorOpts> {
  const d = deserializeArtifactConfig(artifact.config);
  const merged: OrchestratorOpts = {
    ...defaults,
    ...d,
    feature: ctx.feature,
    projectDir: ctx.projectDir,
    saifctlDir: d.saifctlDir,
    fromArtifact: null,
    testOnly: false,
    runStorage: defaults.runStorage,
    sandboxBaseDir: defaults.sandboxBaseDir,
    sandboxProfileId: d.sandboxProfileId as OrchestratorOpts['sandboxProfileId'],
    agentProfileId: d.agentProfileId as OrchestratorOpts['agentProfileId'],
  };
  delete (merged as { featureName?: string }).featureName;
  delete (merged as { featureRelativePath?: string }).featureRelativePath;

  if (artifact.subtasks?.length) {
    merged.subtasks = runSubtasksToInputs(artifact.subtasks);
  }
  merged.currentSubtaskIndex = artifact.currentSubtaskIndex ?? 0;
  merged.enableSubtaskSequence = merged.subtasks.length > 1;

  return merged;
}

////////////////////////////////////////////////////////////
// FIELD RESOLVERS
////////////////////////////////////////////////////////////

function resolveCoderImage(
  config: SaifctlConfig | undefined,
  sandboxProfile: SandboxProfile,
): string {
  if (config?.defaults?.coderImage) {
    validateImageTag(config.defaults.coderImage, 'config coderImage');
    return config.defaults.coderImage;
  }
  return sandboxProfile.coderImageTag;
}

function resolvePr(config: SaifctlConfig | undefined, push: string | null): boolean {
  const fromConfig = config?.defaults?.pr ?? false;
  const effective = fromConfig;
  if (effective && !push) {
    consola.error('Error: --pr requires --push <target>.');
    process.exit(1);
  }
  return effective;
}

function resolveGitProvider(config?: SaifctlConfig): GitProvider {
  const id = config?.defaults?.gitProvider ?? 'github';
  try {
    return getGitProvider(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Returns `config.defaults.sandboxBaseDir` or the package default `/tmp/saifctl/sandboxes`. */
export function resolveSandboxBaseDir(config?: SaifctlConfig): string {
  return config?.defaults?.sandboxBaseDir ?? DEFAULT_SANDBOX_BASE_DIR;
}

/** Test profile id from CLI + config.defaults, falling back to package default. */
export function pickTestProfile(cliId: string | undefined, config?: SaifctlConfig): TestProfile {
  const raw = (cliId ?? '').trim();
  const id = raw || config?.defaults?.testProfile || '';
  if (!id) return DEFAULT_TEST_PROFILE;
  try {
    return resolveTestProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Sandbox profile id from CLI + `config.defaults.sandboxProfile`, falling back to the package default. */
export function pickSandboxProfile(
  cliId: string | undefined,
  config?: SaifctlConfig,
): SandboxProfile {
  const raw = (cliId ?? '').trim();
  const id = raw || config?.defaults?.sandboxProfile || '';
  if (!id) return DEFAULT_SANDBOX_PROFILE;
  try {
    return resolveSandboxProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Agent profile id from CLI + `config.defaults.agentProfile`, falling back to the package default. */
export function pickAgentProfile(cliId: string | undefined, config?: SaifctlConfig): AgentProfile {
  const raw = (cliId ?? '').trim();
  const id = raw || config?.defaults?.agentProfile || '';
  if (!id) return DEFAULT_AGENT_PROFILE;
  try {
    return resolveAgentProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Resolves the staging test image tag from `--test-image`, `config.defaults.testImage`, or `saifctl-test-<profileId>:latest`. */
export function resolveTestImageTag( // eslint-disable-line max-params
  cliTag: string | undefined,
  profileId: string,
  config?: SaifctlConfig,
): string {
  const trimmed = cliTag?.trim();
  const tag =
    (trimmed ? trimmed : null) ?? config?.defaults?.testImage ?? `saifctl-test-${profileId}:latest`;
  validateImageTag(tag, '--test-image');
  return tag;
}

/** Bundled profile script vs project-relative path (CLI + `config.defaults`). */
export type OrchestratorScriptPick = { mode: 'profile' } | { mode: 'path'; relativePath: string };

function coalesceScriptPath(
  cliPath: string | undefined,
  configPath: string | undefined,
): OrchestratorScriptPick {
  const fromCli = cliPath !== undefined ? cliPath.trim() : '';
  const fromCfg = configPath?.trim() ?? '';
  const raw = fromCli || fromCfg;
  if (!raw) return { mode: 'profile' };
  return { mode: 'path', relativePath: raw };
}

/** Picks the startup script source: explicit `--startup-script` / `config.defaults.startupScript`, or the bundled profile script. */
export function pickStartupScript(
  cliPath: string | undefined,
  config: SaifctlConfig | undefined,
): OrchestratorScriptPick {
  return coalesceScriptPath(cliPath, config?.defaults?.startupScript);
}

/** Picks the gate script source: explicit `--gate-script` / `config.defaults.gateScript`, or the bundled profile script. */
export function pickGateScript(
  cliPath: string | undefined,
  config: SaifctlConfig | undefined,
): OrchestratorScriptPick {
  return coalesceScriptPath(cliPath, config?.defaults?.gateScript);
}

/** Picks the staging script source: explicit `--stage-script` / `config.defaults.stageScript`, or the bundled profile script. */
export function pickStageScript(
  cliPath: string | undefined,
  config: SaifctlConfig | undefined,
): OrchestratorScriptPick {
  return coalesceScriptPath(cliPath, config?.defaults?.stageScript);
}

/** Picks the test runner script source: explicit `--test-script` / `config.defaults.testScript`, or the bundled profile script. */
export function pickTestScript(
  cliPath: string | undefined,
  config: SaifctlConfig | undefined,
): OrchestratorScriptPick {
  return coalesceScriptPath(cliPath, config?.defaults?.testScript);
}

/** Picks the agent-install script source: explicit `--agent-install-script` path, otherwise the bundled agent profile script. */
export function pickAgentInstallScript(cliPath: string | undefined): OrchestratorScriptPick {
  const raw = cliPath !== undefined ? cliPath.trim() : '';
  if (!raw) return { mode: 'profile' };
  return { mode: 'path', relativePath: raw };
}

/** Picks the agent run script source: explicit `--agent-script` path, otherwise the bundled agent profile script. */
export function pickAgentScript(cliPath: string | undefined): OrchestratorScriptPick {
  const raw = cliPath !== undefined ? cliPath.trim() : '';
  if (!raw) return { mode: 'profile' };
  return { mode: 'path', relativePath: raw };
}

/** Resolves and normalises the staging environment from `config.environments.staging`, defaulting to `{ engine: 'docker' }`. */
export function resolveStagingEnvironment(
  config: SaifctlConfig | undefined,
): NormalizedStagingEnvironment {
  const raw = config?.environments?.staging ?? { engine: 'docker' as const };
  return normalizeStagingEnvironmentRaw(raw);
}

// ---------------------------------------------------------------------------
// Engine resolution
// ---------------------------------------------------------------------------

/** Coding phases allowed in --engine coding=.. */
export type EngineCliCodingKind = 'docker' | 'helm' | 'local';

/** Staging phases allowed in --engine staging=.. */
export type EngineCliStagingKind = 'docker' | 'helm';

/** Parsed `--engine` CLI value: optional coding and staging engine selection. */
export interface EngineCliSpec {
  coding?: EngineCliCodingKind;
  staging?: EngineCliStagingKind;
}

const ENGINE_CLI_CODING_SET = new Set<string>(['docker', 'helm', 'local']);
const ENGINE_CLI_STAGING_SET = new Set<string>(['docker', 'helm']);

/** Applies parsed `--engine` spec to merged opts using file config for reuse vs minimal environment objects. */
export function applyEngineCliToOrchestratorOpts( // eslint-disable-line max-params -- (merged, config, engine string)
  merged: OrchestratorOpts,
  config: SaifctlConfig,
  engineRaw: string,
): void {
  const spec = parseEngineCliSpec(engineRaw);
  if (spec.coding !== undefined) {
    merged.codingEnvironment = pickCodingEnvironmentForEngineCli(spec.coding, config);
  }
  if (spec.staging !== undefined) {
    merged.stagingEnvironment = pickStagingEnvironmentForEngineCli(spec.staging, config);
  }
}

/**
 * Parses `--engine docker` or `--engine coding=docker,staging=helm`.
 * Global `local` sets coding=local and staging=docker (staging cannot be local).
 */
export function parseEngineCliSpec(raw: string, errorPrefix = '--engine'): EngineCliSpec {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hasKv = parts.some((p) => KEY_EQ_PATTERN.test(p));

  // Single global value (docker, local, helm)
  if (!hasKv) {
    if (parts.length !== 1) {
      consola.error(
        `${errorPrefix} expected a single value (e.g. docker) or comma-separated coding=…,staging=… pairs.`,
      );
      process.exit(1);
    }
    const g = parts[0];
    if (g === 'local') {
      return { coding: 'local', staging: 'docker' };
    }
    if (!ENGINE_CLI_CODING_SET.has(g) || !ENGINE_CLI_STAGING_SET.has(g)) {
      consola.error(
        `${errorPrefix} unknown engine "${g}". Use 'docker', 'helm', or 'local' (use coding=staging form for mixed).`,
      );
      process.exit(1);
    }
    return { coding: g as EngineCliCodingKind, staging: g as EngineCliStagingKind };
  }

  // Key-value pairs (coding=docker,staging=helm)
  const parsed = parseCommaSeparatedOverrides({
    raw: trimmed,
    isKeyValue: (p) => KEY_EQ_PATTERN.test(p),
    /* eslint-disable-next-line max-params -- matches parseCommaSeparatedOverrides callback shape */
    validateKeyValue: (key, value, exit) => {
      const v = value.trim();
      if (!v) exit('empty value; expected e.g. coding=docker.');
      if (key !== 'coding' && key !== 'staging') {
        exit(`unknown phase "${key}". Use coding or staging.`);
      }
      if (key === 'staging' && v === 'local') {
        exit('staging cannot use "local"; use docker or helm.');
      }
      if (key === 'coding' && !ENGINE_CLI_CODING_SET.has(v)) {
        exit(`unknown engine "${v}". Use docker, helm, or local.`);
      }
      if (key === 'staging' && !ENGINE_CLI_STAGING_SET.has(v)) {
        exit(`unknown engine "${v}". Use docker or helm.`);
      }
    },
    errorPrefix,
  });

  const out: EngineCliSpec = {
    coding: parsed.keys?.coding as EngineCliCodingKind,
    staging: parsed.keys?.staging as EngineCliStagingKind,
  };
  return out;
}

/**
 * Picks coding environment from config using file config.
 * If provider came from CLI, use minimal environment object.
 */
function pickCodingEnvironmentForEngineCli(
  target: EngineCliCodingKind,
  config: SaifctlConfig,
): NormalizedCodingEnvironment {
  // If the config has a coding environment that matches the target engine,
  // (e.g. 'docker'), use it.
  const fromFile = config.environments?.coding;
  if (fromFile && fromFile.engine === target) {
    return { ...fromFile };
  }
  // If user has e.g. 'docker' in config, but they want to run 'local',
  // use a minimal object (e.g. { engine: 'local' })
  return { engine: target };
}

/**
 * Picks staging environment from config using file config.
 * If provider came from CLI, use minimal environment object.
 */
function pickStagingEnvironmentForEngineCli(
  target: EngineCliStagingKind,
  config: SaifctlConfig,
): NormalizedStagingEnvironment {
  const fromFile = config.environments?.staging;
  if (fromFile && fromFile.engine === target) {
    return normalizeStagingEnvironmentRaw(fromFile);
  }
  if (target === 'docker') {
    return normalizeStagingEnvironmentRaw({ engine: 'docker' });
  }
  consola.error(
    'Error: --engine staging=helm requires environments.staging with engine "helm" and chart in saifctl config.',
  );
  process.exit(1);
}

type StagingConfigRaw =
  | NonNullable<NonNullable<SaifctlConfig['environments']>['staging']>
  | {
      engine: 'docker';
    };

/** Normalize staging env (defaults for `app` / `appEnvironment`) from a raw config object. */
export function normalizeStagingEnvironmentRaw(
  raw: StagingConfigRaw,
): NormalizedStagingEnvironment {
  const app: StagingAppConfig = {
    ...DEFAULT_STAGING_APP,
    ...('app' in raw && raw.app ? raw.app : {}),
  };
  const appEnvironment =
    ('appEnvironment' in raw && raw.appEnvironment ? raw.appEnvironment : undefined) ?? {};
  return { ...raw, app, appEnvironment };
}
