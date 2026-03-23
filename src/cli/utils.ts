/**
 * Shared CLI helpers used across command implementations.
 */

import { join, resolve } from 'node:path';

import { cancel, intro, isCancel, outro, select } from '@clack/prompts';

import {
  type AgentProfile,
  DEFAULT_AGENT_PROFILE,
  resolveAgentInstallScriptPath,
  resolveAgentProfile,
  resolveAgentScriptPath,
} from '../agent-profiles/index.js';
import {
  DEFAULT_STAGING_APP,
  type NormalizedCodingEnvironment,
  type NormalizedStagingEnvironment,
  type SaifConfig,
  type StagingAppConfig,
} from '../config/schema.js';
import { getSaifRoot } from '../constants.js';
import {
  DEFAULT_DESIGNER_PROFILE,
  type DesignerProfile,
  resolveDesignerProfile,
} from '../designer-profiles/index.js';
import { getGitProvider, type GitProvider } from '../git/index.js';
import {
  DEFAULT_INDEXER_PROFILE,
  type IndexerProfile,
  resolveIndexerProfile,
} from '../indexer-profiles/index.js';
import { isSupportedAgentName, type ModelOverrides, SUPPORTED_AGENT_NAMES } from '../llm-config.js';
import { consola } from '../logger.js';
import { DEFAULT_SANDBOX_BASE_DIR } from '../orchestrator/sandbox.js';
import { createRunStorage } from '../run-storage/index.js';
import {
  type RunStorage,
  type StorageOverrides,
  SUPPORTED_STORAGE_KEYS,
} from '../run-storage/types.js';
import {
  DEFAULT_SANDBOX_PROFILE,
  readSandboxGateScript,
  readSandboxStageScript,
  readSandboxStartupScript,
  resolveSandboxProfile,
  type SandboxProfile,
} from '../sandbox-profiles/index.js';
import { discoverFeatures, type Feature, resolveFeature } from '../specs/discover.js';
import {
  DEFAULT_PROFILE,
  resolveTestProfile,
  resolveTestScriptPath,
  type SupportedProfileId,
  type TestProfile,
} from '../test-profiles/index.js';
import { pathExists, readUtf8 } from '../utils/io.js';

/**
 * Resolves the sandbox base directory from --sandbox-base-dir.
 *
 * Returns config default or DEFAULT_SANDBOX_BASE_DIR when omitted.
 */
export function parseSandboxBaseDir(
  args: { 'sandbox-base-dir'?: string },
  config?: SaifConfig,
): string {
  const raw = args['sandbox-base-dir'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return config?.defaults?.sandboxBaseDir ?? DEFAULT_SANDBOX_BASE_DIR;
}

/** Only treat part as key=value if it matches ^\\w+= (avoids parsing query params in URLs). */
const KEY_EQ_PATTERN = /^\w+=/;

/** Agent name (key before =) must not contain comma, whitespace, or equals. */
const MODEL_AGENT_NAME_PATTERN = /^[^,\s=]+$/;

export interface ParseCommaSeparatedResult {
  global?: string;
  keys?: Record<string, string>;
}

export interface ParseCommaSeparatedOptions {
  raw: string;
  /** Returns true if part is key=value form (vs global). */
  isKeyValue: (part: string) => boolean;
  /** Optional validation for key. Call exit(msg) to abort. */
  validateKey?: (key: string, exit: (msg: string) => never) => void;
  /** Optional validation for key-value pair (e.g. empty value). */
  /* eslint-disable-next-line max-params */
  validateKeyValue?: (key: string, value: string, exit: (msg: string) => never) => void;
  maxGlobals?: number;
  errorPrefix?: string;
}

/**
 * Parses comma-separated overrides: global (bare value) or key=value.
 * Reusable for --storage and --model. At most one global by default.
 */
export function parseCommaSeparatedOverrides(
  options: ParseCommaSeparatedOptions,
): ParseCommaSeparatedResult {
  const {
    raw,
    isKeyValue,
    validateKey,
    validateKeyValue,
    maxGlobals = 1,
    errorPrefix = 'option',
  } = options;

  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return {};

  const result: ParseCommaSeparatedResult = {};
  let globalCount = 0;
  const seenKeys = new Set<string>();

  const exit = (msg: string): never => {
    consola.error(`Error: ${errorPrefix} ${msg}`);
    process.exit(1);
  };

  for (const part of parts) {
    if (isKeyValue(part)) {
      // key=value: split on first =, trim each side
      const eqIdx = part.indexOf('=');
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (!value) continue;
      if (seenKeys.has(key)) exit(`duplicate key "${key}". Each key may appear only once.`);
      seenKeys.add(key);
      if (validateKeyValue) validateKeyValue(key, value, exit);
      if (validateKey) validateKey(key, exit);
      result.keys = result.keys ?? {};
      result.keys[key] = value;
    } else {
      // global (bare value): at most maxGlobals
      if (globalCount >= maxGlobals) {
        exit(
          maxGlobals === 1
            ? 'multiple global values. Use key=value for per-item overrides.'
            : `at most ${maxGlobals} global value(s) allowed.`,
        );
      }
      const value = part.trim();
      result.global = value;
      globalCount++;
    }
  }

  return result;
}

/**
 * Parses --storage and returns a RunStorage instance for runs.
 */
export function parseRunStorage(args: { storage?: string }, projectDir: string): RunStorage | null {
  const overrides = parseStorageOverrides(args);
  const uri = overrides.dbStorages?.['runs'] ?? overrides.storage ?? 'local';
  return createRunStorage(uri, projectDir);
}

/**
 * Parses run ID from args (runId or first positional).
 * Exits with an error message if missing or empty.
 */
export function parseRunId(args: { runId?: string; _?: string[] }): string {
  // Fallback to first positional argument if runId is not provided.
  const runIdRaw = args.runId ?? args._?.[0];
  const runId = typeof runIdRaw === 'string' ? runIdRaw.trim() : '';
  if (!runId) {
    consola.error('Error: run ID is required.');
    process.exit(1);
  }
  return runId;
}

/** Args shape for orchestrator commands (design-fail2pass, run, test, etc.) */
export interface OrchestratorArgs {
  profile?: string;
  'test-script'?: string;
  'test-image'?: string;
  'startup-script'?: string;
  'gate-script'?: string;
  'stage-script'?: string;
  agent?: string;
  'agent-script'?: string;
  'agent-install-script'?: string;
}

/** Path segment: kebab-case or (group) */
const FEATURE_PATH_SEGMENT = /(?:[a-z0-9]+(?:-[a-z0-9]+)*|\([a-z0-9]+(?:-[a-z0-9]+)*\))/;

/**
 * Validates that a feature name is safe.
 * Accepts flat (add-login) or path-based ((auth)/login) IDs.
 */
export function validateFeatureName(name: string): void {
  const pathRegex = new RegExp(
    `^${FEATURE_PATH_SEGMENT.source}(?:/${FEATURE_PATH_SEGMENT.source})*$`,
  );
  if (!pathRegex.test(name)) {
    consola.error(
      `Invalid feature name: "${name}". Use kebab-case (add-login) or path (auth)/login.`,
    );
    process.exit(1);
  }
}

/**
 * Resolves the project directory from --project-dir.
 * Returns the absolute path. Defaults to process.cwd() when omitted.
 * (projectDir is not in config - it is required to find the config file.)
 */
export function parseProjectDir(args: { 'project-dir'?: string }): string {
  const raw = args['project-dir'];
  const dir = typeof raw === 'string' && raw.trim() ? raw.trim() : '.';
  return resolve(process.cwd(), dir);
}

/**
 * Resolves the saifac directory from --saifac-dir. Returns 'saifac' when omitted or empty.
 */
export function parseSaifDir(args: { 'saifac-dir'?: string }): string {
  const raw = args['saifac-dir'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'saifac';
}

/**
 * Resolves the project name: --project override, config default, else package.json "name" from repo root.
 * Throws if neither yields a usable name.
 */
export async function resolveProjectName(
  opts: { project?: string },
  projectDir: string,
  config?: SaifConfig,
): Promise<string> {
  const fromOpt = typeof opts.project === 'string' ? opts.project.trim() : '';
  const fromConfig = config?.defaults?.project;
  const explicit = fromOpt || (typeof fromConfig === 'string' ? fromConfig.trim() : '');
  if (explicit) return explicit;

  try {
    const pkg = JSON.parse(await readUtf8(resolve(projectDir, 'package.json'))) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    throw new Error(
      `Cannot determine project name: no package.json found at ${resolve(projectDir, 'package.json')}. ` +
        `Specify -p/--project.`,
    );
  }

  throw new Error(
    `Cannot determine project name: package.json at ${resolve(projectDir, 'package.json')} has no "name" field. ` +
      `Specify -p/--project.`,
  );
}

/**
 * Returns the feature name from args if present and valid. Otherwise undefined.
 */
export function getFeatNameFromArgs(args: { name?: string }): string | undefined {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined;
  if (name) validateFeatureName(name);
  return name || undefined;
}

/**
 * Resolves feature from args or prompts the user to select. Returns a Feature
 * object (name, absolutePath, relativePath).
 */
export async function getFeatOrPrompt(
  args: { name?: string; 'saifac-dir'?: string },
  projectDir: string,
): Promise<Feature> {
  const saifDir = parseSaifDir(args);
  const featuresMap = await discoverFeatures(projectDir, saifDir);
  const features = [...featuresMap.keys()];

  if (features.length === 0) {
    consola.error('No features found. Run `saifac feat new` first.');
    process.exit(1);
  }

  const fromArgs = getFeatNameFromArgs(args);
  if (fromArgs) return await resolveFeature({ input: fromArgs, projectDir, saifDir });

  features.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  intro('Select feature');
  const result = await select({
    message: 'Feature',
    options: features.map((f) => ({ value: f, label: f })),
  });
  outro('');
  if (isCancel(result)) {
    cancel('Operation cancelled.');
    process.exit(1);
  }
  return await resolveFeature({ input: result as string, projectDir, saifDir });
}

/**
 * Resolves the designer profile from --designer. Uses config default or DEFAULT_DESIGNER_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseDesignerProfile(
  args: { designer?: string },
  config?: SaifConfig,
): DesignerProfile {
  const raw = typeof args.designer === 'string' ? args.designer.trim() : '';
  const id = raw || config?.defaults?.designerProfile || '';
  if (!id) return DEFAULT_DESIGNER_PROFILE;
  try {
    return resolveDesignerProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the indexer profile from --indexer.
 * Returns undefined when indexer is "none", uses config or DEFAULT_INDEXER_PROFILE when omitted.
 * Exits on invalid id.
 */
export function parseIndexerProfile(
  args: { indexer?: string },
  config?: SaifConfig,
): IndexerProfile | undefined {
  const indexerRaw = typeof args.indexer === 'string' ? args.indexer.trim() : '';
  const id = indexerRaw || config?.defaults?.indexerProfile || '';

  // Allow explicit `--indexer none` or config indexerProfile: "none" to disable the indexer.
  if (id === 'none') return undefined;

  if (!id) return DEFAULT_INDEXER_PROFILE;
  try {
    return resolveIndexerProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the test profile from --test-profile. Uses config or DEFAULT_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseTestProfile(
  args: { 'test-profile'?: string },
  config?: SaifConfig,
): TestProfile {
  const raw = typeof args['test-profile'] === 'string' ? args['test-profile'].trim() : '';
  const id = raw || config?.defaults?.testProfile || '';
  if (!id) return DEFAULT_PROFILE;
  try {
    return resolveTestProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Validates that a Docker image tag is safe to interpolate into shell commands. */
export function validateImageTag(tag: string, flagName: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    consola.error(
      `Invalid ${flagName} value: "${tag}". ` +
        `Image tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @ signs.`,
    );
    process.exit(1);
  }
}

/** Resolves the sandbox profile from --profile. Uses config or DEFAULT_SANDBOX_PROFILE when omitted. */
export function parseSandboxProfile(args: OrchestratorArgs, config?: SaifConfig): SandboxProfile {
  const raw = typeof args.profile === 'string' ? args.profile.trim() : '';
  const id = raw || config?.defaults?.sandboxProfile || '';
  if (!id) return DEFAULT_SANDBOX_PROFILE;
  try {
    return resolveSandboxProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Returns the test image tag. Uses config or defaults to saifac-test-<profileId>:latest. */
export function parseTestImage(
  args: OrchestratorArgs,
  profileId: string,
  config?: SaifConfig,
): string {
  const v = args['test-image'];
  const tag =
    (typeof v === 'string' && v.trim() ? v.trim() : null) ??
    config?.defaults?.testImage ??
    `saifac-test-${profileId}:latest`;
  validateImageTag(tag, '--test-image');
  return tag;
}

/** Reads startup script from --startup-script or profile default. */
export async function parseStartupScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  config?: SaifConfig;
}): Promise<string> {
  const { args, projectDir, config } = opts;
  const raw = args['startup-script'] || config?.defaults?.startupScript;
  if (typeof raw !== 'string' || !raw.trim()) {
    const profile = parseSandboxProfile(args, config);
    return await readSandboxStartupScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!(await pathExists(scriptPath))) {
    consola.error(`Error: --startup-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readUtf8(scriptPath);
}

/** Reads gate script from --gate-script or profile default. */
export async function parseGateScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  config?: SaifConfig;
}): Promise<string> {
  const { args, projectDir, config } = opts;
  const raw = args['gate-script'] || config?.defaults?.gateScript;
  const profile = parseSandboxProfile(args, config);
  if (typeof raw !== 'string' || !raw.trim()) {
    return await readSandboxGateScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!(await pathExists(scriptPath))) {
    consola.error(`Error: --gate-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readUtf8(scriptPath);
}

/** Reads stage script from --stage-script or profile default. */
export async function parseStageScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  config?: SaifConfig;
}): Promise<string> {
  const { args, projectDir, config } = opts;
  const raw = args['stage-script'] || config?.defaults?.stageScript;
  const profile = parseSandboxProfile(args, config);
  if (typeof raw !== 'string' || !raw.trim()) {
    return await readSandboxStageScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!(await pathExists(scriptPath))) {
    consola.error(`Error: --stage-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readUtf8(scriptPath);
}

/** Reads agent scripts from --agent-script / --agent-install-script or profile defaults. */
export async function parseAgentScripts(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  config?: SaifConfig;
}): Promise<{ agentInstallScript: string; agentScript: string }> {
  const { args, projectDir, config } = opts;
  const agentProfile = parseAgentProfile(args, config);

  const rawStart = args['agent-install-script'];
  let agentInstallScript: string;
  if (typeof rawStart === 'string' && rawStart.trim()) {
    const p = resolve(projectDir, rawStart.trim());
    if (!(await pathExists(p))) {
      consola.error(`Error: --agent-install-script file not found: ${p}`);
      process.exit(1);
    }
    agentInstallScript = await readUtf8(p);
  } else {
    agentInstallScript = await readUtf8(resolveAgentInstallScriptPath(agentProfile.id));
  }

  const rawScript = args['agent-script'];
  let agentScript: string;
  if (typeof rawScript === 'string' && rawScript.trim()) {
    const p = resolve(projectDir, rawScript.trim());
    if (!(await pathExists(p))) {
      consola.error(`Error: --agent-script file not found: ${p}`);
      process.exit(1);
    }
    agentScript = await readUtf8(p);
  } else {
    agentScript = await readUtf8(resolveAgentScriptPath(agentProfile.id));
  }

  return { agentInstallScript, agentScript };
}

/** Reads test script from --test-script or profile default. */
export async function parseTestScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  profileId: SupportedProfileId;
  config?: SaifConfig;
}): Promise<string> {
  const { args, projectDir, profileId, config } = opts;
  const raw = args['test-script'] || config?.defaults?.testScript;
  if (typeof raw !== 'string' || !raw.trim()) {
    return readUtf8(resolveTestScriptPath(profileId));
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!(await pathExists(scriptPath))) {
    consola.error(`Error: --test-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readUtf8(scriptPath);
}

/**
 * Parses CLI model override flags into a `ModelOverrides` object.
 * Merges config.defaults model overrides when present. CLI overrides config.
 *
 * --model: single global or comma-separated agent=model (same pattern as --storage).
 *   Single global: --model anthropic/claude-opus-4-5
 *   Agent-specific: --model vague-specs-check=anthropic/claude-opus-4-5
 *   Multiple: --model coder=openai/o3,pr-summarizer=openai/gpt-4o-mini
 *   Mixed: --model anthropic/claude-sonnet-4-6,pr-summarizer=openai/gpt-4o-mini
 *
 * --base-url: same pattern as --model (single global or agent=url). At most one global.
 *   Single global: --base-url https://api.example.com/v1
 *   Agent-specific: --base-url vague-specs-check=https://api.example.com/v1
 *   Multiple: --base-url vague-specs-check=https://..,pr-summarizer=https://..
 *   Mixed: --base-url https://..,pr-summarizer=https://..
 *   Uses KEY_EQ_PATTERN (^\w+=) so URLs with query params (?x=y) are treated as globals.
 */
export function parseModelOverrides(
  args: {
    model?: string;
    'base-url'?: string;
  },
  config?: SaifConfig,
): ModelOverrides {
  const overrides: ModelOverrides = {};

  // Config defaults first
  const d = config?.defaults;
  if (d?.globalModel) overrides.globalModel = d.globalModel;
  if (d?.globalBaseUrl) overrides.globalBaseUrl = d.globalBaseUrl;
  if (d?.agentModels) overrides.agentModels = { ...d.agentModels };
  if (d?.agentBaseUrls) overrides.agentBaseUrls = { ...d.agentBaseUrls };

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
      overrides.agentModels = { ...overrides.agentModels, ...parsed.keys };
    }
  }

  const baseUrlRaw = typeof args['base-url'] === 'string' ? args['base-url'].trim() : '';
  if (baseUrlRaw) {
    const parsed = parseCommaSeparatedOverrides({
      raw: baseUrlRaw,
      isKeyValue: (p) => KEY_EQ_PATTERN.test(p), // URLs with ?x=y stay global
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
      overrides.agentBaseUrls = { ...overrides.agentBaseUrls, ...parsed.keys };
    }
  }

  return overrides;
}

// ── Feat run parsers (used by saifac feat run) ────────────────────────

/** Args shape for feat run. Extends OrchestratorArgs with run-specific flags. */
export interface FeatRunArgs extends OrchestratorArgs {
  storage?: string;
  'max-runs'?: string;
  'test-retries'?: string;
  'resolve-ambiguity'?: string;
  'dangerous-debug'?: boolean;
  cedar?: string;
  'coder-image'?: string;
  'gate-retries'?: string;
  'no-reviewer'?: boolean;
  'agent-env'?: string | string[];
  'agent-env-file'?: string;
  'agent-log-format'?: string;
  push?: string;
  pr?: boolean;
  'git-provider'?: string;
  verbose?: boolean;
}

export function parseMaxRuns(args: FeatRunArgs, config?: SaifConfig): number {
  const raw = args['max-runs'];
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) {
      consola.error(`Invalid --max-runs value: ${raw}. Must be a positive integer.`);
      process.exit(1);
    }
    return parsed;
  }
  return config?.defaults?.maxRuns ?? 5;
}

export function parseTestRetries(args: FeatRunArgs, config?: SaifConfig): number {
  const raw = args['test-retries'];
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) {
      consola.error(`Invalid --test-retries value: ${raw}. Must be a positive integer.`);
      process.exit(1);
    }
    return parsed;
  }
  return config?.defaults?.testRetries ?? 1;
}

export function parseResolveAmbiguity(
  args: FeatRunArgs,
  config?: SaifConfig,
): 'off' | 'prompt' | 'ai' {
  const raw = args['resolve-ambiguity'];
  if (raw === 'prompt' || raw === 'ai' || raw === 'off') return raw;
  if (raw) {
    consola.warn(`[cli] Unknown --resolve-ambiguity value "${raw}"; using "ai".`);
  }
  return config?.defaults?.resolveAmbiguity ?? 'ai';
}

export function parseDangerousDebug(args: FeatRunArgs, config?: SaifConfig): boolean {
  if (args['dangerous-debug'] === true) return true;
  return config?.defaults?.dangerousDebug ?? false;
}

export function parseCedarPolicyPath(args: FeatRunArgs, config?: SaifConfig): string {
  const v = args.cedar;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return (
    config?.defaults?.cedarPolicyPath ??
    join(getSaifRoot(), 'src', 'orchestrator', 'policies', 'leash-policy.cedar')
  );
}

export function parseCoderImage(args: FeatRunArgs, config?: SaifConfig): string {
  const v = args['coder-image'];
  if (typeof v === 'string' && v.trim()) {
    validateImageTag(v.trim(), '--coder-image');
    return v.trim();
  }
  if (config?.defaults?.coderImage) {
    validateImageTag(config.defaults.coderImage, 'config coderImage');
    return config.defaults.coderImage;
  }
  const profile = parseSandboxProfile(args, config);
  return profile.coderImageTag;
}

export function parseGateRetries(args: FeatRunArgs, config?: SaifConfig): number {
  const raw = args['gate-retries'];
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) {
      consola.error(`Invalid --gate-retries value: ${raw}. Must be a positive integer.`);
      process.exit(1);
    }
    return parsed;
  }
  return config?.defaults?.gateRetries ?? 10;
}

/**
 * Parses reviewer skip flags. Default: true (reviewer enabled).
 *
 * citty treats any `--no-<name>` as setting `<name>` to `false` before node:util sees it.
 * So `--no-reviewer` yields `args.reviewer === false`, not `no-reviewer: true`.
 */
export function parseReviewerEnabled(
  args: { 'no-reviewer'?: boolean; reviewer?: boolean },
  config?: SaifConfig,
): boolean {
  if (args['no-reviewer'] === true) return false;
  if (args.reviewer === false) return false;
  return config?.defaults?.reviewerEnabled ?? true;
}

/**
 * Parses --agent-env KEY=VALUE and --agent-env-file <path> into a single env map.
 *
 * Priority (highest to lowest; higher overrides lower):
 * - --agent-env single KEY=VALUE or comma-separated KEY1=VAL1,KEY2=VAL2 (values cannot contain commas)
 * - --agent-env-file single path or comma-separated paths merged left-to-right (e.g. ./a.env,./b.env)
 * - config agentEnv
 */
export async function parseAgentEnv(opts: {
  args: FeatRunArgs;
  projectDir: string;
  config?: SaifConfig;
}): Promise<Record<string, string>> {
  const { args, projectDir, config } = opts;
  // Merge order (lowest → highest priority):
  //   1. environments.coding.agentEnvironment — service-level baseline from config
  //   2. defaults.agentEnv — project-level defaults from config
  //   3. --agent-env-file — file-based overrides
  //   4. --agent-env    — CLI flag overrides (highest)
  const codingAgentEnv = config?.environments?.coding?.agentEnvironment ?? {};
  const result: Record<string, string> = {
    ...codingAgentEnv,
    ...(config?.defaults?.agentEnv ?? {}),
  };

  // --agent-env-file: single or comma-separated paths, merged left-to-right (later overrides earlier)
  // NOTE: If --agent-env-file is a single value, it's treated as an array of one.
  const agentEnvFileRaw = args['agent-env-file'];
  if (typeof agentEnvFileRaw === 'string' && agentEnvFileRaw.trim()) {
    const paths = agentEnvFileRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const resolved = paths.map((p) => resolve(projectDir, p));

    // Check if all paths exist
    const missing: string[] = [];
    for (const p of resolved) {
      if (!(await pathExists(p))) missing.push(p);
    }
    if (missing.length > 0) {
      consola.error(`Error: --agent-env-file: file(s) not found: ${missing.join(', ')}`);
      process.exit(1);
    }

    // Merge env files left-to-right (later overrides earlier)
    for (const envFilePath of resolved) {
      const lines = (await readUtf8(envFilePath)).split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) {
          consola.warn(
            `[cli] WARNING: skipping malformed agent-env-file line (no '='): ${trimmed}`,
          );
          continue;
        }
        result[trimmed.slice(0, eq).trimEnd()] = trimmed.slice(eq + 1).trimStart();
      }
    }
  }

  // --agent-env: single KEY=VALUE or comma-separated KEY1=VAL1,KEY2=VAL2 (split on comma; values cannot contain commas)
  const envFlags = args['agent-env'];
  const rawStrings = Array.isArray(envFlags) ? envFlags : envFlags ? [envFlags] : [];
  for (const raw of rawStrings) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const segments = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const seg of segments) {
      // `KEY` (no `=`) is invalid
      const eq = seg.indexOf('=');
      if (eq === -1) {
        consola.error(`Error: --agent-env: invalid pair "${seg}" (no '='). Expected KEY=VALUE.`);
        process.exit(1);
      }
      // `=VAL` (no `KEY`) is invalid
      const key = seg.slice(0, eq).trimEnd();
      if (!key) {
        consola.error(`Error: --agent-env: invalid pair "${seg}" (empty key). Expected KEY=VALUE.`);
        process.exit(1);
      }
      // `KEY=` (no `VAL`) is invalid
      const value = seg.slice(eq + 1).trimStart();
      if (!value) {
        consola.error(
          `Error: --agent-env: invalid pair "${seg}" (empty value). Expected KEY=VALUE.`,
        );
        process.exit(1);
      }
      // Valid pair, add to result
      result[key] = value;
    }
  }

  return result;
}

export function parseAgentLogFormat(
  args: FeatRunArgs,
  agentProfile: AgentProfile,
  config?: SaifConfig,
): 'openhands' | 'raw' {
  const raw = args['agent-log-format'];
  if (raw === 'raw') return 'raw';
  if (raw === 'openhands') return 'openhands';
  if (raw) {
    consola.warn(
      `[cli] Unknown --agent-log-format "${raw}"; falling back to profile default (${agentProfile.defaultLogFormat}).`,
    );
  }
  return config?.defaults?.agentLogFormat ?? agentProfile.defaultLogFormat;
}

export function parsePush(args: FeatRunArgs, config?: SaifConfig): string | null {
  const raw = args.push;
  if (typeof raw === 'string') return raw.trim();
  return config?.defaults?.push ?? null;
}

export function parsePr(args: FeatRunArgs, config?: SaifConfig): boolean {
  const hasPr = args.pr === true;
  const fromConfig = config?.defaults?.pr ?? false;
  const effective = hasPr || fromConfig;
  if (effective && !parsePush(args, config)) {
    consola.error('Error: --pr requires --push <target>.');
    process.exit(1);
  }
  return hasPr || fromConfig;
}

export function parseGitProvider(args: FeatRunArgs, config?: SaifConfig): GitProvider {
  const raw = args['git-provider'];
  const id =
    (typeof raw === 'string' && raw.trim() ? raw.trim() : '') ||
    config?.defaults?.gitProvider ||
    'github';
  try {
    return getGitProvider(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Resolves --agent to AgentProfile. Uses config or DEFAULT_AGENT_PROFILE when omitted. */
export function parseAgentProfile(args: OrchestratorArgs, config?: SaifConfig): AgentProfile {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : '';
  const id = raw || config?.defaults?.agentProfile || '';
  if (!id) return DEFAULT_AGENT_PROFILE;
  try {
    return resolveAgentProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

// ── Discovery (design-discovery step) ─────────────────────────────────────

export interface DiscoveryOptions {
  /** Named MCP servers: name -> HTTP(S) URL (Streamable HTTP transport) */
  mcps: Record<string, string>;
  /** Path to a JS/TS file that exports tools (jiti-loaded) */
  tool?: string;
  /** Inline prompt text (mutually exclusive with discoveryPromptFile) */
  prompt?: string;
  /** Path to prompt file (mutually exclusive with discoveryPrompt) */
  promptFile?: string;
}

/**
 * Whether discovery should run (has mcps or tools).
 */
export function shouldRunDiscovery(opts: DiscoveryOptions): boolean {
  return Object.keys(opts.mcps).length > 0 || !!opts.tool;
}

/**
 * Parses discovery options from CLI and config.
 * --discovery-mcp: named only (name=url). Multiple or comma-separated.
 * --discovery-tool: path to a single JS/TS file.
 * --discovery-prompt and --discovery-prompt-file: mutually exclusive.
 */
export function parseDiscoveryOptions(
  args: {
    'discovery-mcp'?: string | string[];
    'discovery-tool'?: string;
    'discovery-prompt'?: string;
    'discovery-prompt-file'?: string;
  },
  projectDir: string,
  config?: SaifConfig,
): DiscoveryOptions {
  const d = config?.defaults;
  const mcps: Record<string, string> = { ...(d?.discoveryMcps ?? {}) };
  let tool: string | undefined = d?.discoveryTools
    ? resolve(projectDir, d.discoveryTools)
    : undefined;

  // Parse --discovery-mcp
  // Format: name=url (named only; bare URLs rejected). Multiple: comma-separated or repeated.
  // Value: HTTP or HTTPS URL (Streamable HTTP transport), e.g. schema=http://internal-mcp/schema.
  const mcpRaw = args['discovery-mcp'];
  const mcpParts = Array.isArray(mcpRaw)
    ? mcpRaw.flatMap((s) => (typeof s === 'string' ? s.split(',').map((p) => p.trim()) : []))
    : typeof mcpRaw === 'string'
      ? mcpRaw.split(',').map((p) => p.trim())
      : [];

  for (const part of mcpParts) {
    if (!part) continue;
    if (!part.includes('=')) {
      consola.error(
        'Error: --discovery-mcp requires named entries (name=url). Bare URLs are not allowed.',
      );
      process.exit(1);
    }
    const eqIdx = part.indexOf('=');
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!key || !value) {
      consola.error('Error: --discovery-mcp malformed entry (empty key or value).');
      process.exit(1);
    }
    mcps[key] = value;
  }

  // Parse --discovery-tool
  // Format: single path to JS/TS file (default export = object of Mastra tools). Resolved relative to projectDir.
  const toolRaw = args['discovery-tool'];
  if (typeof toolRaw === 'string' && toolRaw.trim()) {
    tool = resolve(projectDir, toolRaw.trim());
  }

  // Parse --discovery-prompt and --discovery-prompt-file (mutually exclusive)
  const hasPrompt = typeof args['discovery-prompt'] === 'string' && args['discovery-prompt'].trim();
  const hasFile =
    typeof args['discovery-prompt-file'] === 'string' && args['discovery-prompt-file'].trim();
  if (hasPrompt && hasFile) {
    consola.error('Error: --discovery-prompt and --discovery-prompt-file are mutually exclusive.');
    process.exit(1);
  }
  const prompt = hasPrompt ? args['discovery-prompt']!.trim() : d?.discoveryPrompt?.trim();
  const promptFile = hasFile
    ? resolve(projectDir, args['discovery-prompt-file']!.trim())
    : d?.discoveryPromptFile
      ? resolve(projectDir, d.discoveryPromptFile)
      : undefined;

  return {
    mcps: Object.keys(mcps).length > 0 ? mcps : {},
    tool,
    prompt: prompt || undefined,
    promptFile,
  };
}

/**
 * Returns a normalized staging environment — always non-null.
 * When `environments.staging` is absent in config, defaults to `{ provisioner: 'docker' }`.
 * Guarantees that `app` (with DEFAULT_STAGING_APP defaults) and `appEnvironment`
 * are always present, eliminating the need for a separate `stagingAppConfig`.
 */
export function parseStagingEnvironment(
  config: SaifConfig | undefined,
): NormalizedStagingEnvironment {
  const raw = config?.environments?.staging ?? { provisioner: 'docker' as const };
  const app: StagingAppConfig = {
    ...DEFAULT_STAGING_APP,
    ...('app' in raw ? raw.app : undefined),
  };
  const appEnvironment: Record<string, string> =
    ('appEnvironment' in raw ? raw.appEnvironment : undefined) ?? {};
  return { ...raw, app, appEnvironment };
}

/**
 * Returns a normalized coding environment — always non-null.
 * When `environments.coding` is absent in config, defaults to `{ provisioner: 'docker' }`.
 */
export function parseCodingEnvironment(
  config: SaifConfig | undefined,
): NormalizedCodingEnvironment {
  return config?.environments?.coding ?? { provisioner: 'docker' as const };
}
