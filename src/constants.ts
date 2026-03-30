/**
 * Package-level constants. Prefer a single source of truth for paths that
 * must stay consistent regardless of where the process is invoked from.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the SaifCTL tool repository root.
 *
 * Resolved from this module's file path:
 * - When source - `src/constants.ts` → parent is repo root;
 * - When bundled into `dist/cli.js` - `import.meta.url` is that file so `dist/` → parent is repo root.
 */
export function getSaifctlRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..');
}

/** `version` field from the published package's package.json (same root as {@link getSaifctlRoot}). */
export function getSaifctlPackageVersion(): string {
  const pkgPath = join(getSaifctlRoot(), 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`Missing or invalid "version" in ${pkgPath}`);
  }
  return pkg.version;
}

/**
 * Workspace-relative path to the per-round agent task file (markdown).
 * Written by coder-start.sh before each inner gate round; read via `$SAIFCTL_TASK_PATH`.
 */
export const SAIFCTL_TASK_FILE_RELATIVE = '.saifctl/task.md';

/** Absolute path to the task file under a workspace root (sandbox `code/` or `/workspace` in-container). */
export function saifctlTaskFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'task.md');
}

/** Environment variable names for LLM API keys. At least one must be set for init and agent workflows. */
export const LLM_API_KEYS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'DASHSCOPE_API_KEY',
] as const;

// ---------------------------------------------------------------------------
// Orchestrator defaults
// ---------------------------------------------------------------------------

/** Max full pipeline runs before giving up when not set via CLI or config. */
export const DEFAULT_ORCHESTRATOR_MAX_RUNS = 5;

/** Full test suite re-runs on failure when not set via CLI or config. */
export const DEFAULT_ORCHESTRATOR_TEST_RETRIES = 1;

/** Inner gate retries (agent → gate → feedback) when not set via CLI or config. */
export const DEFAULT_ORCHESTRATOR_GATE_RETRIES = 10;

/** Ambiguous-spec handling when not set via CLI or config. */
export const DEFAULT_RESOLVE_AMBIGUITY: 'off' | 'prompt' | 'ai' = 'ai';

/** Run the coder container with plain `docker run` (no Leash) when not set via CLI or config. */
export const DEFAULT_DANGEROUS_NO_LEASH = false;

/** Semantic reviewer enabled when not set via CLI or config. */
export const DEFAULT_REVIEWER_ENABLED = true;

/** Bundled Cedar policy when not set via CLI or config. */
export function defaultCedarPolicyPath(): string {
  return join(getSaifctlRoot(), 'src', 'orchestrator', 'policies', 'default.cedar');
}
