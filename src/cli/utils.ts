/**
 * Shared CLI helpers used across command implementations.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { cancel, intro, isCancel, outro, select } from '@clack/prompts';

import {
  resolveAgentInstallScriptPath,
  resolveAgentProfile,
  resolveAgentScriptPath,
  type SupportedAgentProfileId,
} from '../agent-profiles/index.js';
import { type SaifctlConfig } from '../config/schema.js';
import { DEFAULT_DESIGNER_PROFILE, resolveDesignerProfile } from '../designer-profiles/index.js';
import type { DesignerProfile } from '../designer-profiles/types.js';
import { getGitProvider } from '../git/index.js';
import { DEFAULT_INDEXER_PROFILE, resolveIndexerProfile } from '../indexer-profiles/index.js';
import type { IndexerProfile } from '../indexer-profiles/types.js';
import { consola } from '../logger.js';
import { mergeAgentSecretKeysFromReads } from '../orchestrator/agent-env.js';
import {
  type OrchestratorCliInput,
  type OrchestratorScriptPick,
  pickAgentInstallScript,
  pickAgentScript,
} from '../orchestrator/options.js';
import { createRunStorage, type RunStorage } from '../runs/storage.js';
import {
  readSandboxGateScript,
  readSandboxStageScript,
  readSandboxStartupScript,
  resolveSandboxGateScriptPath,
  resolveSandboxProfile,
  resolveSandboxStageScriptPath,
  resolveSandboxStartupScriptPath,
  type SupportedSandboxProfileId,
} from '../sandbox-profiles/index.js';
import { discoverFeatures, type Feature, resolveFeature } from '../specs/discover.js';
import { type StorageOverrides, SUPPORTED_STORAGE_KEYS } from '../storage/types.js';
import {
  resolveTestProfile,
  resolveTestScriptPath,
  type SupportedProfileId,
} from '../test-profiles/index.js';
import { validateImageTag } from '../utils/docker.js';
import { pathExists, readUtf8 } from '../utils/io.js';
import { npmPackageNameToProjectSlug } from '../utils/package.js';

////////////////////////
// CLI Parsing
////////////////////////

/** Only treat part as key=value if it matches ^\\w+= (avoids parsing query params in URLs). */
export const KEY_EQ_PATTERN = /^\w+=/;

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

/** Args shape for orchestrator commands (design-fail2pass, run, test, etc.) */
export interface OrchestratorArgs {
  profile?: string;
  'test-script'?: string;
  'test-image'?: string;
  'startup-script'?: string;
  'gate-script'?: string;
  'stage-script'?: string;
  'include-dirty'?: boolean;
  agent?: string;
  'agent-script'?: string;
  'agent-install-script'?: string;
}

/** Args shape for feat run. Extends OrchestratorArgs with run-specific flags. */
export interface FeatRunArgs extends OrchestratorArgs {
  'project-dir'?: string;
  'saifctl-dir'?: string;
  name?: string;
  model?: string;
  'base-url'?: string;
  storage?: string;
  'max-runs'?: string;
  'test-retries'?: string;
  'test-profile'?: string;
  'sandbox-base-dir'?: string;
  project?: string;
  'resolve-ambiguity'?: string;
  'dangerous-no-leash'?: boolean;
  cedar?: string;
  'coder-image'?: string;
  'gate-retries'?: string;
  'no-reviewer'?: boolean;
  /** Set by citty for `--no-reviewer` (negated boolean). */
  reviewer?: boolean;
  'agent-env'?: string | string[];
  'agent-env-file'?: string;
  /** Env var names only; values are read from the host process at runtime. */
  'agent-secret'?: string | string[];
  'agent-secret-file'?: string;
  push?: string;
  pr?: boolean;
  branch?: string;
  'git-provider'?: string;
  verbose?: boolean;
  engine?: string;
}

/** Path segment: kebab-case or (group) */
const FEATURE_PATH_SEGMENT = /(?:[a-z0-9]+(?:-[a-z0-9]+)*|\([a-z0-9]+(?:-[a-z0-9]+)*\))/;

/**
 * Validates that a feature name is safe.
 * Accepts flat (add-login) or path-based ((auth)/login) IDs.
 */
function validateFeatureName(name: string): void {
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
 * Returns the feature name from args if present and valid. Otherwise undefined.
 */
export function getFeatNameFromArgs(args: { name?: string }): string | undefined {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined;
  if (name) validateFeatureName(name);
  return name || undefined;
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

/** CLI-only: non-empty `--agent-env-file` raw string, or `undefined` if omitted. */
export function readAgentEnvFileRawFromCli(args: FeatRunArgs): string | undefined {
  const raw = args['agent-env-file'];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw;
}

/**
 * CLI-only: flattened `KEY=VALUE` segments from `--agent-env` (comma-separated),
 * after splitting; does not validate pairs.
 */
function readAgentEnvPairSegmentsFromCli(args: FeatRunArgs): string[] {
  const envFlags = args['agent-env'];
  const rawStrings = Array.isArray(envFlags) ? envFlags : envFlags ? [envFlags] : [];
  const out: string[] = [];
  for (const raw of rawStrings) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    out.push(
      ...raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return out;
}

/**
 * CLI-only: path segments from `--agent-secret-file` (comma-separated), or `undefined` if omitted.
 */
function readAgentSecretFilesFromCli(args: FeatRunArgs): string[] | undefined {
  const raw = args['agent-secret-file'];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const paths = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return paths.length > 0 ? paths : undefined;
}

/**
 * CLI-only: env var name segments from `--agent-secret` (comma-separated),
 * after splitting; does not validate names.
 */
function readAgentSecretKeySegmentsFromCli(args: FeatRunArgs): string[] {
  const flags = args['agent-secret'];
  const rawStrings = Array.isArray(flags) ? flags : flags ? [flags] : [];
  const out: string[] = [];
  for (const raw of rawStrings) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    out.push(
      ...raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return out;
}

/** CLI-only: `--agent-install-script` when present as a string, or `undefined` if omitted. */
export function readAgentInstallScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['agent-install-script'];
  return typeof v === 'string' ? v : undefined;
}

/** CLI-only: trimmed `--agent` profile id, or `undefined` if omitted / empty. */
export function readAgentProfileIdFromCli(args: OrchestratorArgs): string | undefined {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : '';
  return raw || undefined;
}

/** CLI-only: `--agent-script` when present as a string, or `undefined` if omitted. */
export function readAgentScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['agent-script'];
  return typeof v === 'string' ? v : undefined;
}

/** CLI-only: non-empty `--cedar` path, or `undefined` if omitted. */
export function readCedarPolicyPathFromCli(args: FeatRunArgs): string | undefined {
  const v = args.cedar;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** CLI-only: non-empty `--coder-image`, or `undefined` if omitted. */
export function readCoderImageTagFromCli(args: FeatRunArgs): string | undefined {
  const v = args['coder-image'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** CLI-only: trimmed non-empty `--engine`, or `undefined` if omitted / empty. */
export function readEngineCliFromCli(args: Pick<FeatRunArgs, 'engine'>): string | undefined {
  const raw = typeof args.engine === 'string' ? args.engine.trim() : '';
  return raw !== '' ? raw : undefined;
}

/** CLI-only: trimmed `--designer`, or `undefined` if omitted / empty. */
export function readDesignerProfileIdFromCli(args: { designer?: string }): string | undefined {
  const raw = typeof args.designer === 'string' ? args.designer.trim() : '';
  return raw || undefined;
}

/** Normalized discovery flags from argv (before merging config.defaults). */
export interface DiscoveryCliReads {
  mcpParts: string[];
  toolPathRaw: string | undefined;
  promptInlineRaw: string | undefined;
  promptFileRaw: string | undefined;
}

/**
 * Reads discovery-related CLI flags only (no config merge).
 * `--discovery-mcp`: comma-split / repeated string parts (still `name=url` validated in {@link resolveDiscoveryOptions}).
 */
export function readDiscoveryCliReads(args: {
  'discovery-mcp'?: string | string[];
  'discovery-tool'?: string;
  'discovery-prompt'?: string;
  'discovery-prompt-file'?: string;
}): DiscoveryCliReads {
  const mcpRaw = args['discovery-mcp'];
  const mcpParts = Array.isArray(mcpRaw)
    ? mcpRaw.flatMap((s) => (typeof s === 'string' ? s.split(',').map((p) => p.trim()) : []))
    : typeof mcpRaw === 'string'
      ? mcpRaw.split(',').map((p) => p.trim())
      : [];

  const toolRaw = args['discovery-tool'];
  const toolPathRaw = typeof toolRaw === 'string' && toolRaw.trim() ? toolRaw.trim() : undefined;

  const pr = args['discovery-prompt'];
  const promptInlineRaw = typeof pr === 'string' && pr.trim() ? pr.trim() : undefined;

  const pf = args['discovery-prompt-file'];
  const promptFileRaw = typeof pf === 'string' && pf.trim() ? pf.trim() : undefined;

  return { mcpParts, toolPathRaw, promptInlineRaw, promptFileRaw };
}

/** CLI-only: positive integer from `--gate-retries`, or `undefined` if omitted. */
export function readGateRetriesFromCli(args: FeatRunArgs): number | undefined {
  const raw = args['gate-retries'];
  if (typeof raw !== 'string') return undefined;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    consola.error(`Invalid --gate-retries value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

/** CLI-only: `--gate-script` when present as a string, or `undefined` if omitted. */
export function readGateScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['gate-script'];
  return typeof v === 'string' ? v : undefined;
}

/** CLI-only: trimmed `--git-provider`, or `undefined` if omitted / empty. */
export function readGitProviderIdFromCli(args: FeatRunArgs): string | undefined {
  const raw = args['git-provider'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/** CLI-only: trimmed `--indexer`, or `undefined` if omitted / empty. */
export function readIndexerProfileIdFromCli(args: { indexer?: string }): string | undefined {
  const raw = typeof args.indexer === 'string' ? args.indexer.trim() : '';
  return raw || undefined;
}

/** CLI-only: positive integer from `--max-runs`, or `undefined` if omitted. */
export function readMaxRunsFromCli(args: FeatRunArgs): number | undefined {
  const raw = args['max-runs'];
  if (typeof raw !== 'string') return undefined;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    consola.error(`Invalid --max-runs value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

/** CLI-only: `true` when `--pr` was passed; `undefined` if omitted. */
export function readPrTrueFromCli(args: FeatRunArgs): boolean | undefined {
  return args.pr === true ? true : undefined;
}

/** CLI-only: trimmed `--project-dir` segment, or `undefined` if omitted / empty. */
export function readProjectDirFromCli(args: { 'project-dir'?: string }): string | undefined {
  const raw = args['project-dir'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/** CLI-only: `--push` string (trimmed) when present, or `undefined` if omitted / non-string. */
export function readPushFromCli(args: FeatRunArgs): string | undefined {
  const raw = args.push;
  if (typeof raw === 'string') return raw.trim();
  return undefined;
}

/** CLI-only: valid enum from `--resolve-ambiguity`, or `undefined` if omitted / invalid. */
export function readResolveAmbiguityFromCli(
  args: FeatRunArgs,
): 'off' | 'prompt' | 'ai' | undefined {
  const raw = args['resolve-ambiguity'];
  if (raw === 'prompt' || raw === 'ai' || raw === 'off') return raw;
  if (raw) {
    consola.warn(`[cli] Unknown --resolve-ambiguity value "${raw}"; using stored/default.`);
  }
  return undefined;
}

/**
 * CLI-only: explicit reviewer disable (`false`) from `--no-reviewer` / `reviewer: false`; `undefined` if omitted.
 *
 * citty treats any `--no-<name>` as setting `<name>` to `false` before node:util sees it.
 * So `--no-reviewer` yields `args.reviewer === false`, not `no-reviewer: true`.
 */
export function readReviewerEnabledFromCli(args: {
  'no-reviewer'?: boolean;
  reviewer?: boolean;
}): boolean | undefined {
  if (args['no-reviewer'] === true) return false;
  if (args.reviewer === false) return false;
  return undefined;
}

/** CLI-only: trimmed `--saifctl-dir`, or `undefined` if omitted / empty. */
export function readSaifctlDirFromCli(args: { 'saifctl-dir'?: string }): string | undefined {
  const raw = args['saifctl-dir'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/** CLI-only: non-empty `--sandbox-base-dir`, or `undefined` if omitted. */
export function readSandboxBaseDirFromCli(args: {
  'sandbox-base-dir'?: string;
}): string | undefined {
  const raw = args['sandbox-base-dir'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

/** CLI-only: trimmed `--profile` (sandbox), or `undefined` if omitted / empty. */
export function readSandboxProfileIdFromCli(args: OrchestratorArgs): string | undefined {
  const raw = typeof args.profile === 'string' ? args.profile.trim() : '';
  return raw || undefined;
}

/** CLI-only: `--stage-script` when present as a string, or `undefined` if omitted. */
export function readStageScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['stage-script'];
  return typeof v === 'string' ? v : undefined;
}

/** CLI-only: `--startup-script` value when set as a string, or `undefined` if omitted. */
export function readStartupScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['startup-script'];
  return typeof v === 'string' ? v : undefined;
}

/** CLI-only: raw `--storage` string when present, or `undefined` if omitted. */
export function readStorageStringFromCli(args: { storage?: string }): string | undefined {
  return typeof args.storage === 'string' ? args.storage : undefined;
}

/** CLI-only: non-empty `--test-image`, or `undefined` if omitted. */
export function readTestImageTagFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['test-image'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** CLI-only: trimmed `--test-profile` string, or `undefined` if omitted / empty. */
export function readTestProfileIdFromCli(args: { 'test-profile'?: string }): string | undefined {
  const raw = typeof args['test-profile'] === 'string' ? args['test-profile'].trim() : '';
  return raw || undefined;
}

/** CLI-only: positive integer from `--test-retries`, or `undefined` if omitted. */
export function readTestRetriesFromCli(args: FeatRunArgs): number | undefined {
  const raw = args['test-retries'];
  if (typeof raw !== 'string') return undefined;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    consola.error(`Invalid --test-retries value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

/** CLI-only: `--test-script` when present as a string, or `undefined` if omitted. */
export function readTestScriptPathFromCli(args: OrchestratorArgs): string | undefined {
  const v = args['test-script'];
  return typeof v === 'string' ? v : undefined;
}

////////////////////////
// Resolving values
////////////////////////

/**
 * Merges `config.defaults.storage` with an optional CLI `--storage` string.
 * Use {@link readStorageStringFromCli} for the CLI layer.
 *
 * Formats (CLI string):
 *   Single global: local | s3 | s3://bucket/prefix
 *   DB-specific: runs=local | runs=s3,tasks=s3://bucket/prefix
 *   Mixed: s3,runs=local | runs=s3,s3://bucket/prefix?profile=x
 *
 * A part is treated as key=value ONLY if it matches ^\w+=, so URLs with query
 * params (s3://b/p?region=us) are correctly treated as bare values (global).
 *
 * Errors: duplicate global, duplicate keys, unknown keys.
 */
export function resolveStorageOverrides(
  cliRaw: string | undefined,
  config?: SaifctlConfig,
): StorageOverrides {
  const d = config?.defaults;
  const configOverrides: StorageOverrides = {};
  if (d?.globalStorage) configOverrides.globalStorage = d.globalStorage;
  if (d?.storages) configOverrides.storages = { ...d.storages };

  const cliNorm = (cliRaw ?? '').trim();
  if (!cliNorm) return configOverrides;

  const allowed = new Set(SUPPORTED_STORAGE_KEYS.map((k) => k.toLowerCase()));
  const parsed = parseCommaSeparatedOverrides({
    raw: cliNorm,
    isKeyValue: (p) => KEY_EQ_PATTERN.test(p),
    validateKey: (key, exit) => {
      if (!allowed.has(key)) {
        exit(`unknown key "${key}". Supported: ${SUPPORTED_STORAGE_KEYS.join(', ')}.`);
      }
    },
    errorPrefix: '--storage',
  });

  const cliResult: StorageOverrides = {};
  if (parsed.global) cliResult.globalStorage = parsed.global;
  if (parsed.keys && Object.keys(parsed.keys).length > 0) cliResult.storages = parsed.keys;
  return { ...configOverrides, ...cliResult };
}

/**
 * Resolves run storage URI from optional CLI `--storage` + config defaults.
 */
/* eslint-disable-next-line max-params -- (cli raw, projectDir, config) */
export function resolveRunStorage(
  cliRaw: string | undefined,
  projectDir: string,
  config?: SaifctlConfig,
): RunStorage | null {
  const overrides = resolveStorageOverrides(cliRaw, config);
  const uri = overrides.storages?.['runs'] ?? overrides.globalStorage ?? 'local';
  return createRunStorage(uri, projectDir);
}

/**
 * Absolute project directory: CLI segment relative to `cwd`, or `cwd` itself when omitted.
 * (`projectDir` is not in saifctl config — it locates the repo for config discovery.)
 */
export function resolveCliProjectDir(cliSegment: string | undefined, cwd = process.cwd()): string {
  const dir = cliSegment?.trim() ? cliSegment.trim() : '.';
  return resolve(cwd, dir);
}

/** Relative saifctl config directory name; defaults to `saifctl`. */
export function resolveSaifctlDirRelative(cliRaw: string | undefined): string {
  return cliRaw?.trim() ? cliRaw.trim() : 'saifctl';
}

/**
 * Resolves the project name: --project override, config default,
 * else package.json "name" from repo root.
 * Throws if neither yields a usable name.
 */
export async function resolveProjectName(opts: {
  project?: string;
  projectDir: string;
  config?: SaifctlConfig;
}): Promise<string> {
  const { project, projectDir, config } = opts;
  const fromOpt = typeof project === 'string' ? project.trim() : '';
  const fromConfig = config?.defaults?.project;
  const explicit = fromOpt || (typeof fromConfig === 'string' ? fromConfig.trim() : '');
  if (explicit) return explicit;

  try {
    const pkg = JSON.parse(await readUtf8(resolve(projectDir, 'package.json'))) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) {
      return npmPackageNameToProjectSlug(pkg.name.trim());
    }
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
 * CLI id (from {@link readDesignerProfileIdFromCli}) + `config.defaults.designerProfile` + package default.
 * Exits on invalid id.
 */
export function pickDesignerProfile(
  cliId: string | undefined,
  config?: SaifctlConfig,
): DesignerProfile {
  const raw = (cliId ?? '').trim();
  const id =
    raw ||
    (typeof config?.defaults?.designerProfile === 'string'
      ? config.defaults.designerProfile.trim()
      : '') ||
    '';
  if (!id) return DEFAULT_DESIGNER_PROFILE;
  try {
    return resolveDesignerProfile(id);
  } catch (err) {
    consola.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * CLI id + `config.defaults.indexerProfile` + package default.
 * `none` (CLI or config) disables the indexer. Exits on invalid id.
 */
export function pickIndexerProfile(
  cliId: string | undefined,
  config?: SaifctlConfig,
): IndexerProfile | undefined {
  const indexerRaw = (cliId ?? '').trim();
  const id =
    indexerRaw ||
    (typeof config?.defaults?.indexerProfile === 'string'
      ? config.defaults.indexerProfile.trim()
      : '') ||
    '';
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
 * Merges `config.defaults.agentEnv` with optional env files and `KEY=VALUE` segments
 * (from {@link readAgentEnvFileRawFromCli} / {@link readAgentEnvPairSegmentsFromCli}).
 */
export async function mergeAgentEnvFromReads(opts: {
  projectDir: string;
  config?: SaifctlConfig;
  fileRaw: string | undefined;
  pairSegments: string[];
}): Promise<Record<string, string>> {
  const { projectDir, config, fileRaw: agentEnvFileRaw, pairSegments } = opts;
  // Merge order (lowest → highest priority):
  //   1. environments.coding.agentEnvironment — service-level baseline from config
  //   2. defaults.agentEnv — project-level defaults from config
  //   3. --agent-env-file — file-based overrides
  //   4. --agent-env    — CLI flag overrides (highest)
  const result: Record<string, string> = {
    ...(config?.environments?.coding?.agentEnvironment ?? {}),
    ...(config?.defaults?.agentEnv ?? {}),
  };

  // --agent-env-file: single or comma-separated paths, merged left-to-right (later overrides earlier)
  // NOTE: If --agent-env-file is a single value, it's treated as an array of one.
  if (agentEnvFileRaw) {
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
  for (const seg of pairSegments) {
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
      consola.error(`Error: --agent-env: invalid pair "${seg}" (empty value). Expected KEY=VALUE.`);
      process.exit(1);
    }
    // Valid pair, add to result
    result[key] = value;
  }

  return result;
}

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
 * Merges `config.defaults` discovery fields with {@link readDiscoveryCliReads}.
 * Validates MCP `name=url` parts and mutual exclusivity of prompt vs prompt-file from CLI.
 */
/* eslint-disable-next-line max-params */
export function resolveDiscoveryOptions(
  reads: DiscoveryCliReads,
  projectDir: string,
  config?: SaifctlConfig,
): DiscoveryOptions {
  const d = config?.defaults;
  const mcps: Record<string, string> = { ...(d?.discoveryMcps ?? {}) };
  let tool: string | undefined = d?.discoveryTools
    ? resolve(projectDir, d.discoveryTools)
    : undefined;

  for (const part of reads.mcpParts) {
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

  if (reads.toolPathRaw) {
    tool = resolve(projectDir, reads.toolPathRaw);
  }

  const hasPrompt = !!reads.promptInlineRaw;
  const hasFile = !!reads.promptFileRaw;
  if (hasPrompt && hasFile) {
    consola.error('Error: --discovery-prompt and --discovery-prompt-file are mutually exclusive.');
    process.exit(1);
  }
  const prompt = reads.promptInlineRaw ?? d?.discoveryPrompt?.trim();
  const promptFile = reads.promptFileRaw
    ? resolve(projectDir, reads.promptFileRaw)
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

////////////////////////
// Misc
////////////////////////

/**
 * Path label for run artifact reporting: relative to projectDir when the script
 * lives under the project, otherwise absolute (normalized).
 */
export function scriptSourcePathForReporting(projectDir: string, absolutePath: string): string {
  const proj = resolve(projectDir);
  const abs = resolve(absolutePath);
  const rel = relative(proj, abs);
  if (rel === '') return abs;
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  return abs;
}

/**
 * Whether discovery should run (has mcps or tools).
 */
export function shouldRunDiscovery(opts: DiscoveryOptions): boolean {
  return Object.keys(opts.mcps).length > 0 || !!opts.tool;
}

/**
 * Resolves feature from args or prompts the user to select. Returns a Feature
 * object (name, absolutePath, relativePath).
 */
export async function getFeatOrPrompt(
  args: { name?: string; 'saifctl-dir'?: string },
  projectDir: string,
): Promise<Feature> {
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const featuresMap = await discoverFeatures(projectDir, saifctlDir);
  const features = [...featuresMap.keys()];

  if (features.length === 0) {
    consola.error('No features found. Run `saifctl feat new` first.');
    process.exit(1);
  }

  const fromArgs = getFeatNameFromArgs(args);
  if (fromArgs) return await resolveFeature({ input: fromArgs, projectDir, saifctlDir });

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
  return await resolveFeature({ input: result as string, projectDir, saifctlDir });
}

async function readOrchestratorScriptPick(opts: {
  pick: OrchestratorScriptPick;
  projectDir: string;
  flagName: string;
  readBundled: () => Promise<{ content: string; absPath: string }>;
}): Promise<{ content: string; scriptFile: string }> {
  const { pick, projectDir, flagName, readBundled } = opts;
  if (pick.mode === 'profile') {
    const { content, absPath } = await readBundled();
    return { content, scriptFile: scriptSourcePathForReporting(projectDir, absPath) };
  }
  const scriptPath = resolve(projectDir, pick.relativePath);
  if (!(await pathExists(scriptPath))) {
    consola.error(`Error: ${flagName} file not found: ${scriptPath}`);
    process.exit(1);
  }
  return {
    content: await readUtf8(scriptPath),
    scriptFile: scriptSourcePathForReporting(projectDir, scriptPath),
  };
}

/** Loads startup script content from a {@link pickStartupScript} result (I/O). */
export async function loadStartupScriptFromPick(opts: {
  pick: OrchestratorScriptPick;
  sandboxProfileId: SupportedSandboxProfileId;
  projectDir: string;
}): Promise<{ startupScript: string; startupScriptFile: string }> {
  const { pick, sandboxProfileId, projectDir } = opts;
  const r = await readOrchestratorScriptPick({
    pick,
    projectDir,
    flagName: '--startup-script',
    readBundled: async () => ({
      content: await readSandboxStartupScript(sandboxProfileId),
      absPath: resolveSandboxStartupScriptPath(sandboxProfileId),
    }),
  });
  return { startupScript: r.content, startupScriptFile: r.scriptFile };
}

/** Loads gate script content from a {@link pickGateScript} result (I/O). */
export async function loadGateScriptFromPick(opts: {
  pick: OrchestratorScriptPick;
  sandboxProfileId: SupportedSandboxProfileId;
  projectDir: string;
}): Promise<{ gateScript: string; gateScriptFile: string }> {
  const { pick, sandboxProfileId, projectDir } = opts;
  const r = await readOrchestratorScriptPick({
    pick,
    projectDir,
    flagName: '--gate-script',
    readBundled: async () => ({
      content: await readSandboxGateScript(sandboxProfileId),
      absPath: resolveSandboxGateScriptPath(sandboxProfileId),
    }),
  });
  return { gateScript: r.content, gateScriptFile: r.scriptFile };
}

/** Loads stage script content from a {@link pickStageScript} result (I/O). */
export async function loadStageScriptFromPick(opts: {
  pick: OrchestratorScriptPick;
  sandboxProfileId: SupportedSandboxProfileId;
  projectDir: string;
}): Promise<{ stageScript: string; stageScriptFile: string }> {
  const { pick, sandboxProfileId, projectDir } = opts;
  const r = await readOrchestratorScriptPick({
    pick,
    projectDir,
    flagName: '--stage-script',
    readBundled: async () => ({
      content: await readSandboxStageScript(sandboxProfileId),
      absPath: resolveSandboxStageScriptPath(sandboxProfileId),
    }),
  });
  return { stageScript: r.content, stageScriptFile: r.scriptFile };
}

/** Loads agent install + run scripts from {@link pickAgentInstallScript} / {@link pickAgentScript} results (I/O). */
export async function loadAgentScriptsFromPicks(opts: {
  installPick: OrchestratorScriptPick;
  scriptPick: OrchestratorScriptPick;
  agentProfileId: SupportedAgentProfileId;
  projectDir: string;
}): Promise<{
  agentInstallScript: string;
  agentInstallScriptFile: string;
  agentScript: string;
  agentScriptFile: string;
}> {
  const { installPick, scriptPick, agentProfileId, projectDir } = opts;

  const installR = await readOrchestratorScriptPick({
    pick: installPick,
    projectDir,
    flagName: '--agent-install-script',
    readBundled: async () => {
      const absPath = resolveAgentInstallScriptPath(agentProfileId);
      return { content: await readUtf8(absPath), absPath };
    },
  });

  const scriptR = await readOrchestratorScriptPick({
    pick: scriptPick,
    projectDir,
    flagName: '--agent-script',
    readBundled: async () => {
      const absPath = resolveAgentScriptPath(agentProfileId);
      return { content: await readUtf8(absPath), absPath };
    },
  });

  return {
    agentInstallScript: installR.content,
    agentInstallScriptFile: installR.scriptFile,
    agentScript: scriptR.content,
    agentScriptFile: scriptR.scriptFile,
  };
}

/** Loads test script content from a {@link pickTestScript} result (I/O). */
export async function loadTestScriptFromPick(opts: {
  pick: OrchestratorScriptPick;
  testProfileId: SupportedProfileId;
  projectDir: string;
}): Promise<{ testScript: string; testScriptFile: string }> {
  const { pick, testProfileId, projectDir } = opts;
  const r = await readOrchestratorScriptPick({
    pick,
    projectDir,
    flagName: '--test-script',
    readBundled: async () => {
      const absPath = resolveTestScriptPath(testProfileId);
      return { content: await readUtf8(absPath), absPath };
    },
  });
  return { testScript: r.content, testScriptFile: r.scriptFile };
}

/**
 * Builds {@link OrchestratorCliInput}: explicit CLI overrides only (`undefined` = do not clobber artifact/defaults).
 */
export async function buildOrchestratorCliInputFromFeatArgs(
  args: FeatRunArgs,
  ctx: { projectDir: string; saifctlDir: string; config: SaifctlConfig },
): Promise<OrchestratorCliInput> {
  const { projectDir, config } = ctx;
  const runArgs = args;

  const maxRuns =
    typeof runArgs['max-runs'] === 'string'
      ? (() => {
          const parsed = parseInt(runArgs['max-runs'], 10);
          if (isNaN(parsed) || parsed < 1) {
            consola.error(
              `Invalid --max-runs value: ${runArgs['max-runs']}. Must be a positive integer.`,
            );
            process.exit(1);
          }
          return parsed;
        })()
      : undefined;

  const testRetries =
    typeof runArgs['test-retries'] === 'string'
      ? (() => {
          const parsed = parseInt(runArgs['test-retries'], 10);
          if (isNaN(parsed) || parsed < 1) {
            consola.error(
              `Invalid --test-retries value: ${runArgs['test-retries']}. Must be a positive integer.`,
            );
            process.exit(1);
          }
          return parsed;
        })()
      : undefined;

  const gateRetries =
    typeof runArgs['gate-retries'] === 'string'
      ? (() => {
          const parsed = parseInt(runArgs['gate-retries'], 10);
          if (isNaN(parsed) || parsed < 1) {
            consola.error(
              `Invalid --gate-retries value: ${runArgs['gate-retries']}. Must be a positive integer.`,
            );
            process.exit(1);
          }
          return parsed;
        })()
      : undefined;

  const resolveAmbiguityRaw = runArgs['resolve-ambiguity'];
  let resolveAmbiguity: 'off' | 'prompt' | 'ai' | undefined;
  if (
    resolveAmbiguityRaw === 'prompt' ||
    resolveAmbiguityRaw === 'ai' ||
    resolveAmbiguityRaw === 'off'
  ) {
    resolveAmbiguity = resolveAmbiguityRaw;
  } else if (resolveAmbiguityRaw) {
    consola.warn(
      `[cli] Unknown --resolve-ambiguity value "${resolveAmbiguityRaw}"; keeping stored/default.`,
    );
    resolveAmbiguity = undefined;
  }

  const dangerousNoLeash = runArgs['dangerous-no-leash'] === true ? true : undefined;

  const cedarPolicyPath =
    typeof runArgs.cedar === 'string' && runArgs.cedar.trim() ? runArgs.cedar.trim() : undefined;

  const coderImageRaw =
    typeof runArgs['coder-image'] === 'string' ? runArgs['coder-image'].trim() : '';
  const coderImage =
    coderImageRaw !== ''
      ? (validateImageTag(coderImageRaw, '--coder-image'), coderImageRaw)
      : undefined;

  const sandboxProfileIdCli =
    typeof runArgs.profile === 'string' && runArgs.profile.trim()
      ? resolveSandboxProfile(runArgs.profile.trim()).id
      : undefined;

  const agentProfileIdCli =
    typeof runArgs.agent === 'string' && runArgs.agent.trim()
      ? resolveAgentProfile(runArgs.agent.trim()).id
      : undefined;

  const testProfileCli =
    typeof runArgs['test-profile'] === 'string' && runArgs['test-profile'].trim()
      ? resolveTestProfile(runArgs['test-profile'].trim())
      : undefined;

  const testImageCli =
    typeof runArgs['test-image'] === 'string' && runArgs['test-image'].trim()
      ? (validateImageTag(runArgs['test-image'].trim(), '--test-image'),
        runArgs['test-image'].trim())
      : undefined;

  let startupScript: string | undefined;
  let startupScriptFile: string | undefined;
  const startupRaw = runArgs['startup-script'];
  if (typeof startupRaw === 'string' && startupRaw.trim()) {
    const scriptPath = resolve(projectDir, startupRaw.trim());
    if (!(await pathExists(scriptPath))) {
      consola.error(`Error: --startup-script file not found: ${scriptPath}`);
      process.exit(1);
    }
    startupScript = await readUtf8(scriptPath);
    startupScriptFile = scriptSourcePathForReporting(projectDir, scriptPath);
  }

  let gateScript: string | undefined;
  let gateScriptFile: string | undefined;
  const gateRaw = runArgs['gate-script'];
  if (typeof gateRaw === 'string' && gateRaw.trim()) {
    const scriptPath = resolve(projectDir, gateRaw.trim());
    if (!(await pathExists(scriptPath))) {
      consola.error(`Error: --gate-script file not found: ${scriptPath}`);
      process.exit(1);
    }
    gateScript = await readUtf8(scriptPath);
    gateScriptFile = scriptSourcePathForReporting(projectDir, scriptPath);
  }

  let stageScript: string | undefined;
  let stageScriptFile: string | undefined;
  const stageRaw = runArgs['stage-script'];
  if (typeof stageRaw === 'string' && stageRaw.trim()) {
    const scriptPath = resolve(projectDir, stageRaw.trim());
    if (!(await pathExists(scriptPath))) {
      consola.error(`Error: --stage-script file not found: ${scriptPath}`);
      process.exit(1);
    }
    stageScript = await readUtf8(scriptPath);
    stageScriptFile = scriptSourcePathForReporting(projectDir, scriptPath);
  }

  let agentInstallScript: string | undefined;
  let agentInstallScriptFile: string | undefined;
  let agentScript: string | undefined;
  let agentScriptFile: string | undefined;

  /**
   * `--agent <id>` loads that profile's bundled install + agent scripts into the CLI layer so merge
   * does not keep the baseline profile's script bodies. More specific flags override after:
   * `--agent-install-script` / `--agent-script` replace only the paths they name.
   */
  if (agentProfileIdCli !== undefined) {
    const loaded = await loadAgentScriptsFromPicks({
      installPick: pickAgentInstallScript(undefined),
      scriptPick: pickAgentScript(undefined),
      agentProfileId: agentProfileIdCli,
      projectDir,
    });
    agentInstallScript = loaded.agentInstallScript;
    agentInstallScriptFile = loaded.agentInstallScriptFile;
    agentScript = loaded.agentScript;
    agentScriptFile = loaded.agentScriptFile;
  }

  const rawInstall = runArgs['agent-install-script'];
  if (typeof rawInstall === 'string' && rawInstall.trim()) {
    const p = resolve(projectDir, rawInstall.trim());
    if (!(await pathExists(p))) {
      consola.error(`Error: --agent-install-script file not found: ${p}`);
      process.exit(1);
    }
    agentInstallScript = await readUtf8(p);
    agentInstallScriptFile = scriptSourcePathForReporting(projectDir, p);
  }

  const rawScript = runArgs['agent-script'];
  if (typeof rawScript === 'string' && rawScript.trim()) {
    const p = resolve(projectDir, rawScript.trim());
    if (!(await pathExists(p))) {
      consola.error(`Error: --agent-script file not found: ${p}`);
      process.exit(1);
    }
    agentScript = await readUtf8(p);
    agentScriptFile = scriptSourcePathForReporting(projectDir, p);
  }

  let testScript: string | undefined;
  let testScriptFile: string | undefined;
  const testRaw = runArgs['test-script'];
  if (typeof testRaw === 'string' && testRaw.trim()) {
    const scriptPath = resolve(projectDir, testRaw.trim());
    if (!(await pathExists(scriptPath))) {
      consola.error(`Error: --test-script file not found: ${scriptPath}`);
      process.exit(1);
    }
    testScript = await readUtf8(scriptPath);
    testScriptFile = scriptSourcePathForReporting(projectDir, scriptPath);
  }

  const reviewerEnabled =
    runArgs['no-reviewer'] === true || runArgs.reviewer === false ? false : undefined;

  const agentEnv =
    runArgs['agent-env'] || runArgs['agent-env-file']
      ? await mergeAgentEnvFromReads({
          projectDir,
          config,
          fileRaw: readAgentEnvFileRawFromCli(runArgs),
          pairSegments: readAgentEnvPairSegmentsFromCli(runArgs),
        })
      : undefined;

  const agentSecretKeys = runArgs['agent-secret']
    ? await mergeAgentSecretKeysFromReads({
        config,
        extraSecretKeys: readAgentSecretKeySegmentsFromCli(runArgs),
      })
    : undefined;

  const agentSecretFiles = readAgentSecretFilesFromCli(runArgs);

  const push =
    typeof runArgs.push === 'string' && runArgs.push.trim() ? runArgs.push.trim() : undefined;

  const pr = runArgs.pr === true ? true : undefined;
  const includeDirty = runArgs['include-dirty'] === true ? true : undefined;

  const targetBranch =
    typeof runArgs.branch === 'string' && runArgs.branch.trim() ? runArgs.branch.trim() : undefined;

  const gitProvider =
    typeof runArgs['git-provider'] === 'string' && runArgs['git-provider'].trim()
      ? getGitProvider(runArgs['git-provider'].trim())
      : undefined;

  const runStorage =
    typeof runArgs.storage === 'string'
      ? resolveRunStorage(readStorageStringFromCli(runArgs), projectDir, config)
      : undefined;

  const saifctlDirCli =
    typeof runArgs['saifctl-dir'] === 'string' && runArgs['saifctl-dir'].trim()
      ? runArgs['saifctl-dir'].trim()
      : undefined;

  const sandboxBaseDir =
    typeof runArgs['sandbox-base-dir'] === 'string' && runArgs['sandbox-base-dir'].trim()
      ? runArgs['sandbox-base-dir'].trim()
      : undefined;

  const projectName =
    typeof runArgs.project === 'string' && runArgs.project.trim()
      ? await resolveProjectName({ project: runArgs.project, projectDir, config })
      : undefined;

  const out: OrchestratorCliInput = {
    sandboxProfileId: sandboxProfileIdCli,
    agentProfileId: agentProfileIdCli,
    feature: undefined,
    projectDir: undefined,
    maxRuns,
    llm: undefined,
    saifctlDir: saifctlDirCli,
    sandboxBaseDir,
    projectName,
    testImage: testImageCli,
    resolveAmbiguity,
    testRetries,
    dangerousNoLeash,
    cedarPolicyPath,
    cedarScript: undefined,
    coderImage,
    startupScript,
    startupScriptFile,
    gateScript,
    gateScriptFile,
    agentInstallScript,
    agentInstallScriptFile,
    agentScript,
    agentScriptFile,
    stageScript,
    stageScriptFile,
    testScript,
    testScriptFile,
    testProfile: testProfileCli,
    agentEnv,
    agentSecretKeys,
    agentSecretFiles,
    gateRetries,
    reviewerEnabled,
    includeDirty,
    push,
    pr,
    targetBranch,
    gitProvider,
    runStorage,
    stagingEnvironment: undefined,
    codingEnvironment: undefined,
    patchExclude: undefined,
    fromArtifact: undefined,
    verbose: runArgs.verbose === true ? true : undefined,
  };
  return out;
}
