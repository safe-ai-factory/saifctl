/**
 * Shared CLI argument definitions used across feat and run commands.
 */

import { DEFAULT_SANDBOX_BASE_DIR } from '../orchestrator/sandbox.js';
import { SUPPORTED_STORAGE_KEYS } from '../storage/types.js';

/** Project directory (default: process.cwd() / current directory) */
export const projectDirArg = {
  type: 'string' as const,
  description: 'Project directory (default: current directory)',
};

/** `--project` / `-p`: project name override for the indexer; falls back to package.json `name`. */
export const projectArg = {
  type: 'string' as const,
  alias: 'p' as const,
  description: 'Project name override for the indexer (default: package.json "name")',
};

/** `--test-profile`: test profile id resolved against the test-profiles registry. */
export const testProfileArg = {
  type: 'string' as const,
  description: 'Test profile id (default: node-vitest).',
};

/** Run storage. Single global, DB-specific (key=val), or mixed. Comma-separated. */
export const storageArg = {
  type: 'string' as const,
  description: `Storage: local | s3 | s3://bucket/prefix (global) or runs=local,tasks=s3 (per-DB) or mixed. Comma-separated. Duplicate keys/global invalid. Supported keys: ${SUPPORTED_STORAGE_KEYS.join(', ')}.`,
};

/** Sandbox base directory (default: from sandbox profile) */
export const sandboxBaseDirArg = {
  type: 'string' as const,
  description: `Sandbox base directory (default: ${DEFAULT_SANDBOX_BASE_DIR})`,
};

/** `--indexer`: indexer profile id; `none` (or omitted) disables the indexer. */
export const indexerArg = {
  type: 'string' as const,
  description:
    'Indexer profile (optional; default: none). Pass shotgun to use Shotgun, or none to disable.',
};

/** `--name` / `-n`: kebab-case feature id; prompts when omitted in interactive mode. */
export const nameArg = {
  type: 'string' as const,
  alias: 'n' as const,
  description: 'Feature name (kebab-case). Prompts with a list if omitted.',
};

/** `--saifctl-dir`: location of the saifctl config dir relative to the project root. */
export const saifctlDirArg = {
  type: 'string' as const,
  description: 'Path to saifctl directory (default: saifctl)',
};

const testScriptArg = {
  type: 'string' as const,
  description: 'Path to a shell script that overrides test.sh inside the Test Runner container.',
};
const testImageArg = {
  type: 'string' as const,
  description: 'Test runner Docker image tag (default: saifctl-test-<profile>:latest).',
};

const engineArg = {
  type: 'string' as const,
  description:
    'Override infra engines: `docker`, `local`, or `coding=docker,staging=helm`. Sets environments.*.engine for this run.',
};

const profileArg = {
  type: 'string' as const,
  description:
    'Sandbox profile for the project. Sets defaults for startup-script and stage-script.',
};

const startupScriptArg = {
  type: 'string' as const,
  description:
    'Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.).',
};
const stageScriptArg = {
  type: 'string' as const,
  description:
    'Path to a shell script mounted into the staging container. Must handle app startup.',
};

// Shared model override args — spread into any subcommand that calls LLMs.
/** Shared `--model` and `--base-url` flags — spread into any subcommand that calls LLMs. */
export const modelOverrideArgs = {
  model: {
    type: 'string' as const,
    description:
      'LLM model. Single global (anthropic/claude-opus-4-5) or comma-separated agent=model (pr-summarizer=openai/gpt-4o-mini). At most one global.',
  },
  'base-url': {
    type: 'string' as const,
    description:
      'LLM base URL. Single global (https://..) or comma-separated agent=url (pr-summarizer=https://..). At most one global.',
  },
};

const verboseArg = {
  type: 'boolean' as const,
  alias: 'v' as const,
  description: 'Show verbose logs. Default: quiet logs.',
};

/**
 * `--force` / `-f`. Each command should spread this and override the
 * description with the verb that fits its semantics ("Overwrite existing
 * scaffold files", "Always re-run the designer", etc.).
 */
export const forceArg = {
  type: 'boolean' as const,
  alias: 'f' as const,
  description: 'Overwrite existing files (default: skip when present).',
};

// Tests-only args — used by design-fail2pass, test (staging + test runner, no coder agent)
/**
 * Test-runner-related flags shared by subcommands that exercise staging + tests
 * without spawning a coder agent (`design-fail2pass`, `run test`).
 */
export const featTestsArgs = {
  'sandbox-base-dir': sandboxBaseDirArg,
  engine: engineArg,
  profile: profileArg,
  'test-script': testScriptArg,
  'test-image': testImageArg,
  'startup-script': startupScriptArg,
  'stage-script': stageScriptArg,
  'include-dirty': {
    type: 'boolean' as const,
    description:
      'Include untracked and uncommitted files in the sandbox copy. Default: only committed files (HEAD).',
  },
};

// Agent args — used by run start / inspect (coder container).
const featAgentArgs = {
  'gate-script': {
    type: 'string' as const,
    description:
      'Path to a shell script run inside the Leash container after each round. Defaults to profile gate.',
  },
  agent: {
    type: 'string' as const,
    description: 'Agent profile (default: openhands). Used for gate script resolution.',
  },
  'agent-script': {
    type: 'string' as const,
    description: 'Path to the coding agent script. Overrides profile default.',
  },
  'agent-install-script': {
    type: 'string' as const,
    description: 'Path to the one-time agent install script. Overrides profile default.',
  },
};

// Args for `run test` — re-test a Run's patch (no agent/coding flags).
/**
 * Args for `saifctl run test` — re-runs the staging + test-runner pipeline
 * against a stored Run's patch. No agent/coder flags (no implementation step).
 */
export const runTestArgs = {
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
  project: projectArg,
  'test-profile': testProfileArg,
  ...featTestsArgs,
  ...modelOverrideArgs,
  'test-retries': {
    type: 'string' as const,
    description: 'How many times to retry when the tests fail (default: 1).',
  },
  'resolve-ambiguity': {
    type: 'string' as const,
    description:
      'How to handle test failures caused by ambiguous specs failures. "ai" (use AI for clarification) | "prompt" (ask human for clarification) | "off" (all failures treated as genuine) (default: ai).',
  },
  'no-reviewer': {
    type: 'boolean' as const,
    description:
      'Skip the semantic AI reviewer (Argus) after static checks. Use when Argus is unavailable.',
  },
  storage: storageArg,
  push: {
    type: 'string' as const,
    description:
      'Push feature branch after tests pass. Accepts Git URL, slug (owner/repo), or remote name.',
  },
  pr: {
    type: 'boolean' as const,
    description: 'Open a Pull Request after pushing. Requires --push and provider token env var.',
  },
  branch: {
    type: 'string' as const,
    description:
      'Override the git branch name used when applying the patch to the host (default: saifctl/<feature>-<runId>-<diffHash>).',
  },
  'git-provider': {
    type: 'string' as const,
    description:
      'Git hosting provider for push/PR. github | gitlab | bitbucket | azure | gitea (default: github).',
  },
  verbose: verboseArg,
};

const dangerousNoLeashArg = {
  type: 'boolean' as const,
  description:
    'Skip Leash; run the coder container with plain docker run (same image, mounts, env, and container name as Leash — no Cedar / Leash proxy). For no container, use `--engine local`',
};

const cedarArg = {
  type: 'string' as const,
  description:
    'Absolute path to Cedar policy file for Leash (default: src/orchestrator/policies/default.cedar).',
};

const coderImageArg = {
  type: 'string' as const,
  description: 'Docker image for the coder container (default: from --profile).',
};

const gateRetriesArg = {
  type: 'string' as const,
  description: 'Max gate retries per run (default: 10).',
};

const subtasksArg = {
  type: 'string' as const,
  // Undocumented escape hatch (Block 3 of TODO_phases_and_critics). The
  // supported sources are `phases/` (preferred) or `subtasks.json` in the
  // feature dir; this flag bypasses both. Kept available for emergency
  // manual control but intentionally not promoted in --help.
  description:
    '(internal escape hatch; prefer phases/ or subtasks.json in the feature dir) Path to a subtasks JSON file (relative to project dir or absolute).',
};

/**
 * `--strict` / `--no-strict` (Block 7 of TODO_phases_and_critics) — flips the
 * project-wide default for `tests.mutable`. Applies project-wide; saifctl/tests/
 * stays immutable regardless. Distinct from `--dangerous-no-leash`, which
 * removes the gate/test guarantee entirely.
 *
 * Default `true` (strict ⇒ default-immutable) per §9. The actual default is
 * applied by `resolveStrictFlag` so the CLI can distinguish "user passed
 * --strict" from "user passed nothing" and fall back to
 * `defaults.strict` from saifctl/config.yml.
 */
const strictArg = {
  type: 'boolean' as const,
  default: undefined,
  description:
    "Default mutability for feature/phase test dirs. --strict (default) keeps tests immutable unless tests.mutable: true is set; --no-strict flips the default. Independent of --dangerous-no-leash (which removes the gate/test guarantee entirely). 'saifctl/tests/' stays immutable regardless.",
};

const agentEnvArg = {
  type: 'string' as const,
  description:
    'Extra env var(s). Single KEY=VALUE or comma-separated KEY1=VAL1,KEY2=VAL2. Values cannot contain commas; use --agent-env-file or config for that.',
};

const agentEnvFileArg = {
  type: 'string' as const,
  description:
    'Single path or comma-separated paths to .env file(s). Later overrides earlier for duplicate keys (e.g. ./a.env,./b.env).',
};

const agentSecretArg = {
  type: 'string' as const,
  description:
    'Env var name(s) to copy from the host into the coder secret env (comma-separated). Values are never passed on the CLI — only names — so secrets never show up in logs.',
};

const agentSecretFileArg = {
  type: 'string' as const,
  description:
    'Path(s) to .env file(s) with KEY=value secret pairs (same format as --agent-env-file; # comments allowed). Comma-separated paths; later overrides earlier. Paths are stored in the run artifact and re-read when starting from a Run (values are not persisted in the artifact).',
};

/**
 * CLI flags forwarded to `saifctl sandbox` by tools like saifdocs.
 * Omits feat-only options (e.g. --gate-script, --subtasks, push/PR, test runner).
 */
export const sandboxPassthroughArgs = {
  ...modelOverrideArgs,
  agent: featAgentArgs.agent,
  'agent-script': featAgentArgs['agent-script'],
  'agent-install-script': featAgentArgs['agent-install-script'],
  profile: profileArg,
  'startup-script': startupScriptArg,
  'coder-image': coderImageArg,
  cedar: cedarArg,
  engine: engineArg,
  'dangerous-no-leash': dangerousNoLeashArg,
  'sandbox-base-dir': sandboxBaseDirArg,
  'agent-env': agentEnvArg,
  'agent-env-file': agentEnvFileArg,
  'agent-secret': agentSecretArg,
  'agent-secret-file': agentSecretFileArg,
  'gate-retries': gateRetriesArg,
  verbose: verboseArg,
};

// Shared body for feat run and `run start` (feature name is feat-run only; start-from-artifact uses the Run).
const featRunCoreArgs = {
  ...runTestArgs,
  ...featAgentArgs,

  'max-runs': {
    type: 'string' as const,
    description: 'Max full pipeline runs before giving up (default: 5).',
  },
  'dangerous-no-leash': dangerousNoLeashArg,
  cedar: cedarArg,
  'coder-image': coderImageArg,
  'gate-retries': gateRetriesArg,
  subtasks: subtasksArg,
  'agent-env': agentEnvArg,
  'agent-env-file': agentEnvFileArg,
  'agent-secret': agentSecretArg,
  'agent-secret-file': agentSecretFileArg,
  strict: strictArg,
};

// Run-specific args (feat run, run start). Builds on runTestArgs + agent flags + coder-only options.
/**
 * Args for `saifctl feat run` (and `run start`): runTestArgs plus coder-agent
 * flags and run-only options like `--max-runs`, `--cedar`, and `--strict`.
 */
export const featRunArgs = {
  name: nameArg,
  ...featRunCoreArgs,
};

/** Same options as `feat run` except `--name` / `-n` (feature comes from the Run only). */
export const featFromArtifactArgs = {
  ...featRunCoreArgs,
};
