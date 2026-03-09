/**
 * Shared CLI helpers used across command implementations.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cancel, intro, isCancel, outro, select } from '@clack/prompts';

import {
  type AgentProfile,
  DEFAULT_AGENT_PROFILE,
  resolveAgentProfile,
  resolveAgentScriptPath,
  resolveAgentStartScriptPath,
} from '../agent-profiles/index.js';
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
import { type ModelOverrides } from '../llm-config.js';
import { DEFAULT_SANDBOX_BASE_DIR } from '../orchestrator/sandbox.js';
import {
  DEFAULT_SANDBOX_PROFILE,
  readSandboxGateScript,
  readSandboxStageScript,
  readSandboxStartupScript,
  resolveSandboxProfile,
  type SandboxProfile,
} from '../sandbox-profiles/index.js';
import {
  DEFAULT_PROFILE,
  resolveTestProfile,
  resolveTestScriptPath,
  type SupportedProfileId,
  type TestProfile,
} from '../test-profiles/index.js';

/**
 * Resolves the sandbox base directory from --sandbox-base-dir.
 * Returns DEFAULT_SANDBOX_BASE_DIR when omitted or empty.
 */
export function parseSandboxBaseDir(args: { 'sandbox-base-dir'?: string }): string {
  const raw = args['sandbox-base-dir'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_SANDBOX_BASE_DIR;
}

/** Args shape for orchestrator commands (design-fail2pass, run, continue, test, etc.) */
export interface OrchestratorArgs {
  profile?: string;
  'test-script'?: string;
  'test-image'?: string;
  'startup-script'?: string;
  'gate-script'?: string;
  'stage-script'?: string;
  agent?: string;
  'agent-script'?: string;
  'agent-start-script'?: string;
}

/**
 * Validates that a change/feature name is safe (kebab-case).
 * Exits with an error message if invalid.
 */
export function validateChangeName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    console.error(
      `Invalid feature name: "${name}". ` +
        `Names must be kebab-case (lowercase letters, digits, and hyphens only, e.g. "add-login").`,
    );
    process.exit(1);
  }
}

/**
 * Resolves the project directory from --project-dir.
 * Returns the absolute path. Defaults to process.cwd() when omitted or empty.
 */
export function parseProjectDir(args: { 'project-dir'?: string }): string {
  const raw = args['project-dir'];
  const dir = typeof raw === 'string' && raw.trim() ? raw.trim() : '.';
  return resolve(process.cwd(), dir);
}

/**
 * Resolves the openspec directory from --openspec-dir. Returns 'openspec' when omitted or empty.
 */
export function parseOpenspecDir(args: { 'openspec-dir'?: string }): string {
  const raw = args['openspec-dir'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'openspec';
}

/**
 * Resolves the project name: --project override, else package.json "name" from repo root.
 * Throws if neither yields a usable name.
 */
export function resolveProjectName(opts: { project?: string }, projectDir: string): string {
  const fromOpt = typeof opts.project === 'string' ? opts.project.trim() : '';
  if (fromOpt) return fromOpt;

  try {
    const pkg = JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8')) as {
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
  if (name) validateChangeName(name);
  return name || undefined;
}

/**
 * Resolves feature name from args or prompts the user to select from OpenSpec changes.
 * Exits if no changes exist or user cancels.
 */
export async function getFeatNameOrPrompt(
  args: { name?: string },
  projectDir: string,
): Promise<string> {
  const fromArgs = getFeatNameFromArgs(args);
  if (fromArgs) return fromArgs;

  const raw = execSync('npx openspec list --json', { encoding: 'utf-8', cwd: projectDir });
  let changes: { name: string }[];
  try {
    const data = JSON.parse(raw) as { changes?: { name: string }[] };
    changes = data?.changes ?? [];
  } catch {
    changes = [];
  }

  if (changes.length === 0) {
    console.error('No OpenSpec changes found. Run `saif feat new` first.');
    process.exit(1);
  }

  changes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  intro('Select feature');
  const result = await select({
    message: 'Feature / change',
    options: changes.map((c) => ({ value: c.name, label: c.name })),
  });
  outro('');
  if (isCancel(result)) {
    cancel('Operation cancelled.');
    process.exit(1);
  }
  return result as string;
}

/**
 * Resolves the designer profile from --designer. Returns DEFAULT_DESIGNER_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseDesignerProfile(args: { designer?: string }): DesignerProfile {
  const raw = typeof args.designer === 'string' ? args.designer.trim() : '';
  if (!raw) return DEFAULT_DESIGNER_PROFILE;
  try {
    return resolveDesignerProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the indexer profile from --indexer.
 * Returns undefined when indexer is "none", DEFAULT_INDEXER_PROFILE when omitted,
 * or the resolved profile when a valid id is given. Exits on invalid id.
 */
export function parseIndexerProfile(args: { indexer?: string }): IndexerProfile | undefined {
  const indexerRaw = typeof args.indexer === 'string' ? args.indexer.trim() : '';

  // Allow explicit `--indexer none` to disable the indexer.
  if (indexerRaw === 'none') return undefined;

  if (!indexerRaw) return DEFAULT_INDEXER_PROFILE;
  try {
    return resolveIndexerProfile(indexerRaw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the test profile from --test-profile. Returns DEFAULT_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseTestProfile(args: { 'test-profile'?: string }): TestProfile {
  const raw = typeof args['test-profile'] === 'string' ? args['test-profile'].trim() : '';
  if (!raw) return DEFAULT_PROFILE;
  try {
    return resolveTestProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Validates that a Docker image tag is safe to interpolate into shell commands. */
export function validateImageTag(tag: string, flagName: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    console.error(
      `Invalid ${flagName} value: "${tag}". ` +
        `Image tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @ signs.`,
    );
    process.exit(1);
  }
}

/** Resolves the sandbox profile from --profile. Returns DEFAULT_SANDBOX_PROFILE when omitted. */
export function parseSandboxProfile(args: OrchestratorArgs): SandboxProfile {
  const raw = typeof args.profile === 'string' ? args.profile.trim() : '';
  if (!raw) return DEFAULT_SANDBOX_PROFILE;
  try {
    return resolveSandboxProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Returns the test image tag. Defaults to factory-test-<profileId>:latest. */
export function parseTestImage(args: OrchestratorArgs, profileId: string): string {
  const v = args['test-image'];
  const tag = typeof v === 'string' && v.trim() ? v.trim() : `factory-test-${profileId}:latest`;
  validateImageTag(tag, '--test-image');
  return tag;
}

/** Reads startup script from --startup-script or profile default. */
export async function parseStartupScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
}): Promise<string> {
  const { args, projectDir } = opts;
  const raw = args['startup-script'];
  if (typeof raw !== 'string' || !raw.trim()) {
    const profile = parseSandboxProfile(args);
    return readSandboxStartupScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!existsSync(scriptPath)) {
    console.error(`Error: --startup-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readFileSync(scriptPath, 'utf8');
}

/** Reads gate script from --gate-script or profile default. */
export async function parseGateScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
}): Promise<string> {
  const { args, projectDir } = opts;
  const raw = args['gate-script'];
  const profile = parseSandboxProfile(args);
  if (typeof raw !== 'string' || !raw.trim()) {
    return readSandboxGateScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!existsSync(scriptPath)) {
    console.error(`Error: --gate-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readFileSync(scriptPath, 'utf8');
}

/** Reads stage script from --stage-script or profile default. */
export async function parseStageScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
}): Promise<string> {
  const { args, projectDir } = opts;
  const raw = args['stage-script'];
  const profile = parseSandboxProfile(args);
  if (typeof raw !== 'string' || !raw.trim()) {
    return readSandboxStageScript(profile.id);
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!existsSync(scriptPath)) {
    console.error(`Error: --stage-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readFileSync(scriptPath, 'utf8');
}

/** Reads agent scripts from --agent-script / --agent-start-script or profile defaults. */
export async function parseAgentScripts(opts: {
  args: OrchestratorArgs;
  projectDir: string;
}): Promise<{ agentStartScript: string; agentScript: string }> {
  const { args, projectDir } = opts;
  const rawAgent = typeof args.agent === 'string' ? args.agent.trim() : '';
  const agentProfile = !rawAgent
    ? DEFAULT_AGENT_PROFILE
    : (() => {
        try {
          return resolveAgentProfile(rawAgent);
        } catch (err) {
          console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
          process.exit(1);
        }
      })();

  const rawStart = args['agent-start-script'];
  const agentStartScript =
    typeof rawStart === 'string' && rawStart.trim()
      ? (() => {
          const p = resolve(projectDir, rawStart.trim());
          if (!existsSync(p)) {
            console.error(`Error: --agent-start-script file not found: ${p}`);
            process.exit(1);
          }
          return readFileSync(p, 'utf8');
        })()
      : readFileSync(resolveAgentStartScriptPath(agentProfile.id), 'utf8');

  const rawScript = args['agent-script'];
  const agentScript =
    typeof rawScript === 'string' && rawScript.trim()
      ? (() => {
          const p = resolve(projectDir, rawScript.trim());
          if (!existsSync(p)) {
            console.error(`Error: --agent-script file not found: ${p}`);
            process.exit(1);
          }
          return readFileSync(p, 'utf8');
        })()
      : readFileSync(resolveAgentScriptPath(agentProfile.id), 'utf8');

  return { agentStartScript, agentScript };
}

/** Reads test script from --test-script or profile default. */
export async function parseTestScript(opts: {
  args: OrchestratorArgs;
  projectDir: string;
  profileId: SupportedProfileId;
}): Promise<string> {
  const { args, projectDir, profileId } = opts;
  const raw = args['test-script'];
  if (typeof raw !== 'string' || !raw.trim()) {
    return readFileSync(resolveTestScriptPath(profileId), 'utf8');
  }
  const scriptPath = resolve(projectDir, raw.trim());
  if (!existsSync(scriptPath)) {
    console.error(`Error: --test-script file not found: ${scriptPath}`);
    process.exit(1);
  }
  return readFileSync(scriptPath, 'utf8');
}

/**
 * Parses CLI model override flags into a `ModelOverrides` object.
 *
 * Accepts:
 *   --model <provider/model>              → applies to all agents
 *   --base-url <url>                      → applies to all agents
 *   --agent-model <name>=<provider/model> → applies to a named agent only
 *   --agent-base-url <name>=<url>         → applies to a named agent only
 *
 * `--agent-model` and `--agent-base-url` may be repeated (citty passes multiple
 * values as an array, a single value as a string, or omits them entirely).
 */
export function parseModelOverrides(args: {
  model?: string;
  'base-url'?: string;
  'agent-model'?: string | string[];
  'agent-base-url'?: string | string[];
}): ModelOverrides {
  const overrides: ModelOverrides = {};

  // Global model override used by all agents unless a per-agent override exists.
  // Example: `--model openai/gpt-4o`
  if (typeof args.model === 'string' && args.model.trim()) {
    overrides.model = args.model.trim();
  }

  // Global base URL override for all provider requests.
  // Example: `--base-url https://api.openai.com/v1`
  if (typeof args['base-url'] === 'string' && args['base-url'].trim()) {
    overrides.baseUrl = args['base-url'].trim();
  }

  // Per-agent model overrides
  // Example: `--agent-model tests-writer=openai/gpt-4o`
  const agentModelRaw = args['agent-model'];
  if (agentModelRaw != null) {
    const entries = Array.isArray(agentModelRaw) ? agentModelRaw : [agentModelRaw];
    overrides.agentModels = {};
    for (const entry of entries) {
      // Parse "<agentName>=<model>" pairs.
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) {
        console.warn(
          `[cli] Ignoring malformed --agent-model value "${entry}": expected name=model`,
        );
        continue;
      }
      const name = entry.slice(0, eqIdx).trim();
      const model = entry.slice(eqIdx + 1).trim();
      if (name && model) overrides.agentModels[name] = model;
    }
  }

  // Per-agent base URL overrides from `--agent-base-url name=url`.
  // Example: `--agent-base-url tests-writer=https://api.openai.com/v1`
  const agentBaseUrlRaw = args['agent-base-url'];
  if (agentBaseUrlRaw != null) {
    const entries = Array.isArray(agentBaseUrlRaw) ? agentBaseUrlRaw : [agentBaseUrlRaw];
    overrides.agentBaseUrls = {};
    for (const entry of entries) {
      // Parse "<agentName>=<url>" pairs.
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) {
        console.warn(
          `[cli] Ignoring malformed --agent-base-url value "${entry}": expected name=url`,
        );
        continue;
      }
      const name = entry.slice(0, eqIdx).trim();
      const url = entry.slice(eqIdx + 1).trim();
      if (name && url) overrides.agentBaseUrls[name] = url;
    }
  }

  return overrides;
}

// ── Feat run/continue parsers (used by saif feat run) ────────────────────────

/** Args shape for feat run. Extends OrchestratorArgs with run-specific flags. */
export interface FeatRunArgs extends OrchestratorArgs {
  'max-runs'?: string;
  'keep-sandbox'?: boolean;
  'test-retries'?: string;
  'resolve-ambiguity'?: string;
  'dangerous-debug'?: boolean;
  cedar?: string;
  'coder-image'?: string;
  'gate-retries'?: string;
  env?: string | string[];
  'env-file'?: string;
  'agent-log-format'?: string;
  push?: string;
  pr?: boolean;
  'git-provider'?: string;
}

export function parseMaxRuns(args: FeatRunArgs): number {
  const raw = args['max-runs'];
  if (typeof raw !== 'string') return 5; // default
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error(`Invalid --max-runs value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

export function parseTestRetries(args: FeatRunArgs): number {
  const raw = args['test-retries'];
  if (typeof raw !== 'string') return 1; // default
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error(`Invalid --test-retries value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

export function parseResolveAmbiguity(args: FeatRunArgs): 'off' | 'prompt' | 'ai' {
  const raw = args['resolve-ambiguity'];
  if (raw === 'prompt' || raw === 'ai' || raw === 'off') return raw;
  if (raw) {
    console.warn(`[cli] Unknown --resolve-ambiguity value "${raw}"; using "ai".`);
  }
  return 'ai';
}

export function parseDangerousDebug(args: FeatRunArgs): boolean {
  return args['dangerous-debug'] === true;
}

export function parseCedarPolicyPath(args: FeatRunArgs): string {
  const v = args.cedar;
  return typeof v === 'string' && v.trim()
    ? v.trim()
    : join(getSaifRoot(), 'src', 'orchestrator', 'leash-policy.cedar');
}

export function parseCoderImage(args: FeatRunArgs): string {
  const v = args['coder-image'];
  if (typeof v === 'string' && v.trim()) {
    validateImageTag(v.trim(), '--coder-image');
    return v.trim();
  }
  const profile = parseSandboxProfile(args);
  return profile.coderImageTag;
}

export function parseGateRetries(args: FeatRunArgs): number {
  const raw = args['gate-retries'];
  if (typeof raw !== 'string') return 10; // default
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error(`Invalid --gate-retries value: ${raw}. Must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Parses --env KEY=VALUE flags and --env-file <path> into a single env map.
 * --env-file entries are processed first; --env flags override them.
 */
export function parseAgentEnv(opts: {
  args: FeatRunArgs;
  projectDir: string;
}): Record<string, string> {
  const { args, projectDir } = opts;
  const result: Record<string, string> = {};

  const envFile = args['env-file'];
  if (typeof envFile === 'string' && envFile.trim()) {
    const envFilePath = resolve(projectDir, envFile.trim());
    if (!existsSync(envFilePath)) {
      console.error(`Error: --env-file not found: ${envFilePath}`);
      process.exit(1);
    }
    const lines = readFileSync(envFilePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        console.warn(`[cli] WARNING: skipping malformed env-file line (no '='): ${trimmed}`);
        continue;
      }
      result[trimmed.slice(0, eq).trimEnd()] = trimmed.slice(eq + 1).trimStart();
    }
  }

  const envFlags = args.env;
  const entries = Array.isArray(envFlags) ? envFlags : envFlags ? [envFlags] : [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const eq = entry.indexOf('=');
    if (eq === -1) {
      console.warn(`[cli] WARNING: skipping malformed --env value (no '='): ${entry}`);
      continue;
    }
    result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  return result;
}

export function parseAgentLogFormat(
  args: FeatRunArgs,
  agentProfile: AgentProfile,
): 'openhands' | 'raw' {
  const raw = args['agent-log-format'];
  if (raw === 'raw') return 'raw';
  if (raw === 'openhands') return 'openhands';
  if (raw) {
    console.warn(
      `[cli] Unknown --agent-log-format "${raw}"; falling back to profile default (${agentProfile.defaultLogFormat}).`,
    );
  }
  return agentProfile.defaultLogFormat;
}

export function parsePush(args: FeatRunArgs): string | null {
  const raw = args.push;
  return typeof raw === 'string' ? raw.trim() : null;
}

export function parsePr(args: FeatRunArgs): boolean {
  const hasPr = args.pr === true;
  if (hasPr && !parsePush(args)) {
    console.error('Error: --pr requires --push <target>.');
    process.exit(1);
  }
  return hasPr;
}

export function parseGitProvider(args: FeatRunArgs): GitProvider {
  const raw = args['git-provider'];
  const id = typeof raw === 'string' && raw.trim() ? raw.trim() : 'github';
  try {
    return getGitProvider(id);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/** Resolves --agent to AgentProfile. Returns DEFAULT_AGENT_PROFILE when omitted. */
export function parseAgentProfile(args: OrchestratorArgs): AgentProfile {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : '';
  if (!raw) return DEFAULT_AGENT_PROFILE;
  try {
    return resolveAgentProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}
