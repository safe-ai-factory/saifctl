/**
 * Filters user-supplied agent env variables before passing to an engine.
 * Reserved keys must not shadow factory-injected variables.
 */

import { join, resolve } from 'node:path';

import type { SaifctlConfig } from '../config/schema.js';
import {
  LLM_API_KEYS,
  saifctlTaskFilePath,
  subtaskDonePath,
  subtaskExitPath,
  subtaskNextPath,
  subtaskRetriesPath,
} from '../constants.js';
import type { ContainerEnv } from '../engines/types.js';
import type { LlmConfig } from '../llm-config.js';
import { consola } from '../logger.js';
import { pathExists, readUtf8 } from '../utils/io.js';

// Since these keys are injected into the coder container, we raise error
// if they are set by the user, because that likely means that the user
// is trying to override the coder container's environment variables,
// which is not allowed.
const RESERVED_ENV_KEYS = new Set([
  'SAIFCTL_INITIAL_TASK',
  'SAIFCTL_GATE_RETRIES',
  'SAIFCTL_GATE_SCRIPT',
  'SAIFCTL_REVIEWER_ENABLED',
  'SAIFCTL_STARTUP_SCRIPT',
  'SAIFCTL_AGENT_INSTALL_SCRIPT',
  'SAIFCTL_AGENT_SCRIPT',
  'SAIFCTL_TASK_PATH',
  'SAIFCTL_WORKSPACE_BASE',
  'SAIFCTL_RUN_ID',
  'SAIFCTL_ENABLE_SUBTASK_SEQUENCE',
  'SAIFCTL_NEXT_SUBTASK_PATH',
  'SAIFCTL_SUBTASK_DONE_PATH',
  'SAIFCTL_SUBTASK_EXIT_PATH',
  'SAIFCTL_SUBTASK_RETRIES_PATH',
  /** Factory-enforced: uv must use OS TLS (corporate MITM / Leash CA in trust store). */
  'UV_NATIVE_TLS',
  /** Factory-enforced: LiteLLM/httpx/requests use OS CA bundle (not certifi-only) for MITM proxies. */
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  /** Factory-enforced: Node.js ignores SSL_CERT_FILE; NODE_EXTRA_CA_CERTS appends the OS bundle
   *  (including Leash-injected MITM CAs) to Node's built-in trust store. Required for all
   *  Node-based agents (cursor, claude, kilocode, copilot, opencode, etc.). */
  'NODE_EXTRA_CA_CERTS',
  'LLM_API_KEY',
  /**
   * Full provider-prefixed model string (e.g. `anthropic/claude-haiku-4-5`,
   * `openrouter/anthropic/claude-haiku-4-5`). What LiteLLM-style multi-provider
   * agents (aider, openhands, mini-swe-agent, terminus, deepagents, opencode,
   * kilocode, forge) consume directly.
   */
  'LLM_MODEL',
  /**
   * Bare model id with the provider prefix stripped
   * (e.g. `claude-haiku-4-5`). What single-provider native CLIs that talk
   * directly to one vendor's API (claude, codex, gemini, copilot, cursor,
   * qwen) want — those tools reject the factory's `provider/model` form.
   * Mirrors {@link LlmConfig.modelId} 1:1; matches the long-standing
   * REVIEWER_LLM_MODEL semantics.
   */
  'LLM_MODEL_ID',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'REVIEWER_LLM_PROVIDER',
  'REVIEWER_LLM_MODEL',
  'REVIEWER_LLM_API_KEY',
  'REVIEWER_LLM_BASE_URL',
]);

/**
 * Filters agentEnv, emitting warnings for any keys that shadow reserved
 * factory variables. Returns a safe copy.
 */
export function filterAgentEnv(agentEnv: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(agentEnv)) {
    if (key.startsWith('SAIFCTL_') || RESERVED_ENV_KEYS.has(key)) {
      consola.warn(
        `[agent-runner] WARNING: --agent-env ${key} is a reserved factory variable and will be ignored.`,
      );
      continue;
    }
    result[key] = val;
  }
  return result;
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates and filters `--agent-secret` / `--agent-secret-file` key names (same reserved rules as
 * {@link filterAgentEnv}). Invalid names are skipped with a warning.
 */
export function filterAgentSecretKeyNames(keys: string[]): string[] {
  const result: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (!key) continue;
    if (!ENV_VAR_NAME_PATTERN.test(key)) {
      consola.warn(
        `[agent-runner] WARNING: --agent-secret "${raw}" is not a valid env var name and will be ignored.`,
      );
      continue;
    }
    if (key.startsWith('SAIFCTL_') || RESERVED_ENV_KEYS.has(key)) {
      consola.warn(
        `[agent-runner] WARNING: --agent-secret ${key} is a reserved factory variable and will be ignored.`,
      );
      continue;
    }
    result.push(key);
  }
  return result;
}

function assertValidAgentSecretKeyName(key: string, source: string): void {
  const k = key.trim();
  if (!ENV_VAR_NAME_PATTERN.test(k)) {
    consola.error(`Error: ${source}: invalid env var name "${key}"`);
    process.exit(1);
  }
}

/** Later duplicate names win (same semantics as overlapping --agent-env). */
function dedupeAgentSecretKeyNamesLastWins(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i].trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.reverse();
}

/**
 * Merges `config.defaults.agentSecretKeys` with extra secret key names (e.g. from `--agent-secret`).
 * Values are never read here — only key names; {@link resolveAgentSecretEnv} reads from `process.env`.
 * File-based secrets are loaded inside {@link buildCoderContainerEnv}.
 */
export async function mergeAgentSecretKeysFromReads(opts: {
  config?: SaifctlConfig;
  extraSecretKeys: string[];
}): Promise<string[]> {
  const { config, extraSecretKeys } = opts;
  const merged: string[] = [];

  for (const k of config?.defaults?.agentSecretKeys ?? []) {
    assertValidAgentSecretKeyName(k, 'config.defaults.agentSecretKeys');
    merged.push(k.trim());
  }

  for (const raw of extraSecretKeys) {
    for (const seg of raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      assertValidAgentSecretKeyName(seg, '--agent-secret');
      merged.push(seg);
    }
  }

  return dedupeAgentSecretKeyNamesLastWins(merged);
}

/**
 * Filters `KEY=value` pairs from `--agent-secret-file` the same way as {@link filterAgentEnv}
 * (reserved factory keys are dropped with a warning).
 */
export function filterAgentSecretPairs(pairs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(pairs)) {
    if (key.startsWith('SAIFCTL_') || RESERVED_ENV_KEYS.has(key)) {
      consola.warn(
        `[agent-runner] WARNING: --agent-secret-file ${key} is a reserved factory variable and will be ignored.`,
      );
      continue;
    }
    result[key] = val;
  }
  return result;
}

/**
 * Reads `.env`-style `KEY=value` lines from project-relative paths (same rules as `--agent-env-file`).
 * Returns filtered pairs safe for the coder secret env.
 */
export async function loadAgentSecretEnvFromSecretFiles(
  projectDir: string,
  relativePaths: string[],
): Promise<Record<string, string>> {
  if (relativePaths.length === 0) return {};

  // Absolute paths under projectDir; refuse to run if any listed file is missing (typos, wrong cwd).
  const resolved = relativePaths.map((p) => resolve(projectDir, p));
  const missing: string[] = [];
  for (const p of resolved) {
    if (!(await pathExists(p))) missing.push(p);
  }
  if (missing.length > 0) {
    consola.error(`Error: --agent-secret-file: file(s) not found: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Same merge order as --agent-env-file: later files overwrite duplicate keys.
  const result: Record<string, string> = {};
  for (const filePath of resolved) {
    const lines = (await readUtf8(filePath)).split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        consola.warn(
          `[agent-runner] WARNING: skipping malformed agent-secret-file line (no '='): ${trimmed}`,
        );
        continue;
      }
      // First '=' separates key from value; values may contain '='.
      result[trimmed.slice(0, eq).trimEnd()] = trimmed.slice(eq + 1).trimStart();
    }
  }

  return filterAgentSecretPairs(result);
}

/**
 * Resolves filtered secret key names to values from `process.env`. Missing or empty values log a
 * warning and are omitted (caller may still inject the same key via automatic LLM forwarding).
 */
export function resolveAgentSecretEnv(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of filterAgentSecretKeyNames(keys)) {
    const val = process.env[key];
    if (val === undefined || val === '') {
      consola.warn(
        `[agent-runner] WARNING: --agent-secret ${key}: not set or empty in host environment; skipping.`,
      );
      continue;
    }
    out[key] = val;
  }
  return out;
}

/** In-container workspace mount path (Docker / Leash). */
const CONTAINER_WORKSPACE = '/workspace';

/**
 * Where the coder process runs, which determines whether SAIFCTL_* paths
 * resolve to in-container `/workspace` or to host directories.
 */
export type CoderContainerEnvMode =
  | { kind: 'container' }
  /** Host-side agent spawn (`--engine local`): workspace paths are host directories, not `/workspace`. */
  | { kind: 'host'; codePath: string; saifctlPath: string };

/** Debian/bookworm and saifctl coder images: merged CA store (includes proxy-injected CAs). */
const DEBIAN_SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

/**
 * Path to the OS CA bundle for Python HTTP clients (LiteLLM uses HTTPX; requests honors REQUESTS_CA_BUNDLE).
 * Container mode always uses the Debian path. Host mode picks the first existing path among common locations.
 */
async function resolveSystemCaBundlePath(mode: CoderContainerEnvMode): Promise<string | null> {
  if (mode.kind === 'container') {
    return DEBIAN_SYSTEM_CA_BUNDLE;
  }
  const candidates = [
    DEBIAN_SYSTEM_CA_BUNDLE,
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/cert.pem',
  ];
  for (const p of candidates) {
    if (await pathExists(p)) return p;
  }
  return null;
}

/**
 * Builds env vars for the coder container.
 *
 * Public vs secret split is for safe debug logging
 * in engines; both maps are merged when spawning the real process.
 *
 * The `agentEnv` argument is passed through {@link filterAgentEnv} so callers need not.
 * `projectDir` is used to resolve `agentSecretFiles` paths (see {@link loadAgentSecretEnvFromSecretFiles}).
 */
export async function buildCoderContainerEnv(opts: {
  mode: CoderContainerEnvMode;
  llmConfig: LlmConfig;
  reviewer: { llmConfig: LlmConfig } | null;
  /** User-supplied public env; reserved factory keys are stripped via {@link filterAgentEnv}. */
  agentEnv: Record<string, string>;
  /** Project root; used to resolve {@link agentSecretFiles} paths. */
  projectDir: string;
  /**
   * Host env var names whose values are copied from `process.env` into {@link ContainerEnv.secretEnv}
   * (e.g. from `--agent-secret` / config). Applied after file-based agent secrets; host values
   * win on duplicate keys.
   */
  agentSecretKeys: string[];
  /**
   * Project-relative paths to secret `.env` files (`KEY=value`); read on the host. Not logged as values by
   * engines. Later files override earlier keys; host {@link agentSecretKeys} win on duplicate names.
   */
  agentSecretFiles: string[];
  taskPrompt: string;
  gateRetries: number;
  runId: string;
  /**
   * When true, sets `SAIFCTL_ENABLE_SUBTASK_SEQUENCE` so the shell stays alive between subtasks
   * waiting for the next prompt or exit signal. Must be true when the run has more than one subtask.
   */
  enableSubtaskSequence: boolean;
  /**
   * When true, omits task/gate/subtask-specific env vars (SAIFCTL_INITIAL_TASK, SAIFCTL_GATE_RETRIES,
   * SAIFCTL_ENABLE_SUBTASK_SEQUENCE, and subtask signal paths). Used by `sandbox --interactive` which
   * runs sandbox-start.sh instead of coder-start.sh and has no task or gate loop.
   */
  sandboxInteractive?: boolean;
}): Promise<ContainerEnv> {
  const {
    mode,
    llmConfig,
    reviewer,
    agentEnv,
    projectDir,
    agentSecretKeys,
    agentSecretFiles,
    taskPrompt,
    gateRetries,
    runId,
    enableSubtaskSequence,
    sandboxInteractive,
  } = opts;

  const agentSecretEnvFromFile = await loadAgentSecretEnvFromSecretFiles(
    projectDir,
    agentSecretFiles,
  );

  const safeAgentEnv = filterAgentEnv(agentEnv);

  const env: Record<string, string> = {
    ...safeAgentEnv,
    // uv defaults to rustls, which ignores the OS CA bundle; native TLS picks up injected CAs
    // (e.g. StrongDM Leash MITM). Applies to all uv invocations in the coder container / local agent.
    UV_NATIVE_TLS: '1',
    SAIFCTL_RUN_ID: runId,
    // Two model env vars exposed to every agent — see FORWARDED_AGENT_ENV_KEYS
    // docstrings above for which agents read which:
    //   LLM_MODEL    — full `provider/model[/sub-model]` form (LiteLLM-style)
    //   LLM_MODEL_ID — bare model id (native single-provider CLIs like Claude Code)
    // Each agent.sh picks the one its CLI expects. Mirrors LlmConfig.fullModelString
    // and LlmConfig.modelId 1:1; no shell-side parsing required.
    LLM_MODEL: llmConfig.fullModelString,
    LLM_MODEL_ID: llmConfig.modelId,
    ...(llmConfig.provider ? { LLM_PROVIDER: llmConfig.provider } : {}),
    ...(llmConfig.baseURL ? { LLM_BASE_URL: llmConfig.baseURL } : {}),
    // Task/gate/subtask vars are omitted for sandbox-interactive (sandbox-start.sh has no loop).
    ...(!sandboxInteractive
      ? {
          SAIFCTL_INITIAL_TASK: taskPrompt,
          SAIFCTL_GATE_RETRIES: String(gateRetries),
          ...(reviewer ? { SAIFCTL_REVIEWER_ENABLED: '1' } : {}),
          ...(reviewer ? { REVIEWER_LLM_MODEL: reviewer.llmConfig.modelId } : {}),
          ...(reviewer?.llmConfig.provider
            ? { REVIEWER_LLM_PROVIDER: reviewer.llmConfig.provider }
            : {}),
          ...(reviewer?.llmConfig.baseURL
            ? { REVIEWER_LLM_BASE_URL: reviewer.llmConfig.baseURL }
            : {}),
          ...(enableSubtaskSequence ? { SAIFCTL_ENABLE_SUBTASK_SEQUENCE: '1' } : {}),
        }
      : {}),
  };

  if (mode.kind === 'container') {
    Object.assign(env, {
      SAIFCTL_WORKSPACE_BASE: CONTAINER_WORKSPACE,
      SAIFCTL_STARTUP_SCRIPT: '/saifctl/startup.sh',
      SAIFCTL_AGENT_INSTALL_SCRIPT: '/saifctl/agent-install.sh',
      // Agent script and subtask signal paths are not needed for sandbox-interactive.
      ...(!sandboxInteractive
        ? {
            SAIFCTL_AGENT_SCRIPT: '/saifctl/agent.sh',
            SAIFCTL_SUBTASK_DONE_PATH: subtaskDonePath(CONTAINER_WORKSPACE),
            SAIFCTL_NEXT_SUBTASK_PATH: subtaskNextPath(CONTAINER_WORKSPACE),
            SAIFCTL_SUBTASK_EXIT_PATH: subtaskExitPath(CONTAINER_WORKSPACE),
            SAIFCTL_SUBTASK_RETRIES_PATH: subtaskRetriesPath(CONTAINER_WORKSPACE),
          }
        : {}),
    });
  } else {
    const { codePath, saifctlPath } = mode;
    Object.assign(env, {
      SAIFCTL_WORKSPACE_BASE: codePath,
      SAIFCTL_STARTUP_SCRIPT: join(saifctlPath, 'startup.sh'),
      SAIFCTL_AGENT_INSTALL_SCRIPT: join(saifctlPath, 'agent-install.sh'),
      ...(!sandboxInteractive
        ? {
            SAIFCTL_GATE_SCRIPT: join(saifctlPath, 'gate.sh'),
            SAIFCTL_AGENT_SCRIPT: join(saifctlPath, 'agent.sh'),
            SAIFCTL_TASK_PATH: saifctlTaskFilePath(codePath),
            SAIFCTL_SUBTASK_DONE_PATH: subtaskDonePath(codePath),
            SAIFCTL_NEXT_SUBTASK_PATH: subtaskNextPath(codePath),
            SAIFCTL_SUBTASK_EXIT_PATH: subtaskExitPath(codePath),
            SAIFCTL_SUBTASK_RETRIES_PATH: subtaskRetriesPath(codePath),
          }
        : {}),
    });
  }

  const secretEnv: Record<string, string> = {
    LLM_API_KEY: llmConfig.apiKey,
  };
  for (const key of LLM_API_KEYS) {
    const val = process.env[key];
    if (val) secretEnv[key] = val;
  }
  if (reviewer) {
    secretEnv.REVIEWER_LLM_API_KEY = reviewer.llmConfig.apiKey;
  }

  Object.assign(secretEnv, agentSecretEnvFromFile);
  const fromAgentSecrets = resolveAgentSecretEnv(agentSecretKeys);
  Object.assign(secretEnv, fromAgentSecrets);

  const systemCaBundle = await resolveSystemCaBundlePath(mode);
  if (systemCaBundle) {
    env.SSL_CERT_FILE = systemCaBundle;
    env.REQUESTS_CA_BUNDLE = systemCaBundle;
    env.CURL_CA_BUNDLE = systemCaBundle;
    // Node.js has its own bundled CA store and ignores SSL_CERT_FILE.
    // NODE_EXTRA_CA_CERTS appends the OS bundle (which includes Leash-injected
    // MITM CAs) without replacing Node's built-in roots.
    env.NODE_EXTRA_CA_CERTS = systemCaBundle;
  }

  return { env, secretEnv };
}
