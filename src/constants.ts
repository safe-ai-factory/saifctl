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

/** Absolute path to the task file under a workspace root (sandbox `code/` or `/workspace` in-container). */
export function saifctlTaskFilePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'task.md');
}

/** Where `coder-start.sh` writes the exit code after each subtask's inner loop; host polls this. */
export function subtaskDonePath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'subtask-done');
}

/** Host writes the next subtask prompt here; shell polls between subtasks. */
export function subtaskNextPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'subtask-next.md');
}

/** Host creates this file to signal the shell to exit cleanly after the current subtask. */
export function subtaskExitPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'subtask-exit');
}

/** Host writes a positive integer to override gate retries for the next subtask only; shell consumes on read. */
export function subtaskRetriesPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.saifctl', 'subtask-retries');
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

/**
 * Marker embedded in the gate script of every entry written by
 * `saifctl feat phases compile` when no `--gate-script` is supplied.
 *
 * The compile output is a **review-only** artifact (per Block 6); accepting
 * it as `feat run --subtasks <compiled>` would silently let a placeholder
 * gate stand in for a real one. `loadSubtasksFromFile` greps for this marker
 * and refuses such inputs with a guiding error message. Lives in
 * `constants.ts` (rather than the CLI module) so the runtime detector can
 * import it without taking a dependency on the CLI layer.
 */
export const PLACEHOLDER_GATE_SCRIPT_MARKER = 'SAIFCTL_PHASES_COMPILED_PLACEHOLDER_GATE';

/**
 * Default Leash daemon Docker image used by saifctl when the user has not set `LEASH_IMAGE`.
 *
 * WORKAROUND: This is a patched build of the upstream Leash image that adds transparent HTTP/2
 * tunnelling via ALPN. Without the patch, clients that negotiate HTTP/2 (e.g. the Cursor CLI,
 * gRPC-based tools) enter an infinite reconnect loop inside the Leash-sandboxed container with
 * "malformed HTTP request/response" errors — because the proxy tries to parse HTTP/2 binary
 * frames as HTTP/1.1 text.
 *
 * The fix has been merged upstream as https://github.com/strongdm/leash/pull/71 (commit
 * `164015b`), but no upstream tag yet contains it — latest tag is v1.1.7 (2026-03-04),
 * predating the fix landing on main (2026-04-06). Until upstream cuts a tagged release,
 * we keep this image as the default.
 * Tracked locally at: https://github.com/safe-ai-factory/saifctl/issues/73
 *
 * The image is built from `vendor/leash/Dockerfile.h2patch` (branch `workaround/h2patch-image`
 * of https://github.com/safe-ai-factory/leash). It was built and pushed with:
 *
 *   cd vendor/leash
 *   docker buildx build --platform linux/arm64,linux/amd64 --push \
 *     -f Dockerfile.h2patch \
 *     -t ghcr.io/safe-ai-factory/leash:h2patch-${SHA} \
 *     -t ghcr.io/safe-ai-factory/leash:latest-h2patch .
 *
 * Once upstream cuts a tagged release that ships an image with HTTP/2 support:
 *   1. Bump `@strongdm/leash` in `package.json` to the new version (or remove if unused).
 *   2. Switch this constant to `public.ecr.aws/s5i7k8t3/strongdm/leash:v<new>` (or delete
 *      the constant + the WORKAROUND injection in `src/engines/docker/index.ts`).
 *   3. `git submodule deinit vendor/leash && git rm vendor/leash`
 *   4. Remove the `[submodule "vendor/leash"]` entry from `.gitmodules`.
 */
export const DEFAULT_LEASH_IMAGE = 'ghcr.io/safe-ai-factory/leash:latest-h2patch';

/** Semantic reviewer enabled when not set via CLI or config. */
export const DEFAULT_REVIEWER_ENABLED = true;

/** Bundled Cedar policy when not set via CLI or config. */
export function defaultCedarPolicyPath(): string {
  return join(getSaifctlRoot(), 'src', 'orchestrator', 'policies', 'default.cedar');
}

/**
 * Filename for Cedar policy materialized next to sandbox shell scripts under `…/saifctl/`.
 * The Docker coding engine passes `join(saifctlPath, this)` to Leash as `--policy`.
 */
export const SANDBOX_CEDAR_POLICY_BASENAME = 'policy.cedar';
