/**
 * Sandbox management for the Software Factory Orchestrator.
 *
 * Creates an isolated copy of the repository in a sandbox base directory
 * (default: /tmp/factory-sandbox/) so the agent can work without touching
 * the host's .git history or files.
 *
 * Directory structure produced:
 *   {sandboxBaseDir}/{proj}-{feat}-{runId}/
 *     gate.sh                ← user-supplied or default gate script; mounted :ro at /factory/gate.sh
 *     code/                  ← rsync copy of repo; workspace for OpenHands; build context/mount
 *                              for staging container (Container A) during tests
 *       .git/                ← fresh git repo for diffing
 *       saifac/features/{feat}/tests/
 *         tests.json         ← test catalog (public cases only; hidden/ dir stripped)
 *         public/            ← public spec files (from rsync, unchanged)
 *         helpers.ts         ← shared transport helpers
 *         infra.spec.ts      ← infra health checks
 *         (hidden/ removed)  ← ALL hidden/ dirs under saifac/features/ deleted so agent
 *                             cannot see holdout tests from any feature (current or others)
 *       ...rest of repo...
 */

import { execSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { minimatch } from 'minimatch';

import type { TestCatalog } from '../design-tests/schema.js';
import type { Feature } from '../specs/discover.js';
import {
  gitAdd,
  gitApply,
  gitClean,
  gitCommit,
  gitDiff,
  gitInit,
  gitResetHard,
} from '../utils/git.js';

/** Recursively removes all directories named "hidden" under baseDir. Exported for testing. */
export function removeAllHiddenDirs(baseDir: string): number {
  let removed = 0;
  if (!existsSync(baseDir)) return removed;

  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(baseDir, entry.name);
    if (entry.name === 'hidden') {
      execSync(`rm -rf "${fullPath}"`);
      removed++;
    } else {
      removed += removeAllHiddenDirs(fullPath);
    }
  }
  return removed;
}

export interface Sandbox {
  /** Run ID suffix used in the sandbox directory name */
  runId: string;
  /** /tmp/factory-sandbox/{proj}-{feat}-{runId} */
  sandboxBasePath: string;
  /** sandboxBasePath/code — rsync copy of the repo */
  codePath: string;
  /** sandboxBasePath/gate.sh — inner gate script; mounted :ro at /factory/gate.sh in the container */
  gatePath: string;
  /**
   * sandboxBasePath/startup.sh — installation script; mounted :ro at /factory/startup.sh.
   * Used by both the coder container and the staging container to install workspace deps.
   * Set via --profile (default: node-pnpm-python) or --startup-script.
   */
  startupPath: string;
  /**
   * sandboxBasePath/agent-start.sh — one-time agent setup script; mounted :ro at /factory/agent-start.sh.
   * coder-start.sh runs this once after the startup script and before the agent loop begins.
   * Used to install the coding agent (e.g. pipx install aider-chat).
   * When absent / empty, the step is skipped.
   */
  agentStartPath: string;
  /**
   * sandboxBasePath/agent.sh — agent runner script; mounted :ro at /factory/agent.sh.
   * coder-start.sh invokes this once per inner round with the task in $FACTORY_TASK_PATH.
   * Resolved from the agent profile (openhands by default). Override with --agent-script.
   */
  agentPath: string;
  /**
   * sandboxBasePath/stage.sh — profile's stage script; mounted read-only in the staging container at /factory/stage.sh.
   * Invoked by staging-start.sh after the installation script and the sidecar have run.
   * Set via --profile or --stage-script.
   */
  stagePath: string;
}

export const DEFAULT_SANDBOX_BASE_DIR = '/tmp/factory-sandbox';

export interface CreateSandboxOpts {
  /** Resolved feature (name, absolutePath, relativePath). */
  feature: Feature;
  /** Absolute path to the project directory */
  projectDir: string;
  /**
   * Project name prefix for the sandbox directory (e.g. 'crawlee-one').
   *
   * The directory is named `{proj}-{feat}-{runId}`.
   */
  projectName: string;
  /** Caller-supplied runId; defaults to a random short id */
  runId?: string;
  /**
   * Path to the saifac directory, relative to project directory.
   */
  saifDir: string;
  /**
   * Base directory where sandbox entries are created.
   * Defaults to `/tmp/factory-sandbox`.
   */
  sandboxBaseDir: string;
  /**
   * Content of the gate script to write into the sandbox as `gate.sh`.
   * The script is mounted read-only at `/factory/gate.sh` inside the coder container
   * and called by `coder-start.sh` after each OpenHands run. It must exit 0 to pass,
   * non-zero to fail (stdout+stderr are fed back to the agent as task feedback).
   *
   * Defaults to the gate.sh from the resolved sandbox profile when not provided.
   */
  gateScript: string;
  /**
   * Content of the startup script to write into the sandbox as `startup.sh`.
   * The script is mounted read-only at `/factory/startup.sh` inside the coder container
   * and executed once by `coder-start.sh` before the agent loop begins.
   *
   * Use for workspace setup that must run after the workspace is mounted:
   * `pnpm install`, `pip install -r requirements.txt`, `cargo fetch`, etc.
   *
   * Set via --profile or --startup-script. When neither is provided, the profile's
   * installation script is used (e.g. pnpm install for node-pnpm-python).
   */
  startupScript: string;
  /**
   * Content of the agent setup script to write into the sandbox as `agent-start.sh`.
   * The script is mounted read-only at `/factory/agent-start.sh` inside the coder container
   * and executed once by `coder-start.sh` after the startup script and before the agent loop.
   *
   * Use to install the coding agent at runtime (e.g. `pipx install aider-chat`).
   * When the script is empty or not provided, the step is skipped.
   *
   * Defaults to the agent profile's agent-start.sh.
   */
  agentStartScript: string;
  /**
   * Content of the agent script to write into the sandbox as `agent.sh`.
   * The script is mounted read-only at `/factory/agent.sh` inside the coder container
   * and invoked by `coder-start.sh` once per inner round.
   *
   * The script must read the task from `$FACTORY_TASK_PATH` and run the desired
   * coding agent (OpenHands, Aider, Claude Code, Codex, etc.).
   *
   * Resolved from the agent profile's agent.sh (openhands by default).
   */
  agentScript: string;
  /**
   * Content of the staging script to write into the sandbox as `stage.sh`.
   * Mounted read-only in the staging container (Container A) at /factory/stage.sh and
   * invoked by staging-start.sh after startup.sh and the sidecar have run.
   *
   * The script is responsible for app startup (e.g. `npm run start`) or keeping
   * the container alive (`wait`) for CLI-only projects.
   *
   * Defaults to the profile's stage.sh when not provided.
   */
  stageScript: string;
  /**
   * When true, `git commit` omits `-q` so per-file summaries are printed.
   * When false/omitted, commits use `-q` for quieter output.
   */
  verbose?: boolean;
}

/**
 * Creates an isolated sandbox for the feature.
 *
 * 1. rsync repo → sandboxBasePath/code/ (honoring .gitignore)
 * 2. Remove ALL hidden/ dirs under saifac/features/ so the coder agent cannot see holdout
 *    tests from any feature (current or others)
 * 3. git init + initial commit inside code/ (clean baseline for diffing)
 * 4. Write gate.sh (user-supplied or default) to sandboxBasePath/gate.sh
 * 5. Write startup.sh (from profile or --startup-script) to sandboxBasePath/startup.sh
 * 6. Write agent-start.sh (from agent profile or --agent-start-script) to sandboxBasePath/agent-start.sh
 * 7. Write agent.sh (from agent profile or --agent-script) to sandboxBasePath/agent.sh
 * 8. Write stage.sh (from profile or --stage-script) to sandboxBasePath/stage.sh
 */
export async function createSandbox(opts: CreateSandboxOpts): Promise<Sandbox> {
  const {
    feature,
    projectDir,
    saifDir,
    projectName,
    sandboxBaseDir,
    gateScript,
    startupScript,
    agentStartScript,
    agentScript,
    stageScript,
    verbose,
  } = opts;
  const runId = opts.runId ?? Math.random().toString(36).substring(2, 9);

  const dirName = `${projectName}-${feature.name}-${runId}`;
  const sandboxBasePath = `${sandboxBaseDir}/${dirName}`;
  const codePath = join(sandboxBasePath, 'code');
  const gatePath = join(sandboxBasePath, 'gate.sh');
  const startupPath = join(sandboxBasePath, 'startup.sh');
  const agentStartPath = join(sandboxBasePath, 'agent-start.sh');
  const agentPath = join(sandboxBasePath, 'agent.sh');
  const stagePath = join(sandboxBasePath, 'stage.sh');

  console.log(`[sandbox] Creating isolated sandbox at ${sandboxBasePath}`);
  mkdirSync(codePath, { recursive: true });

  // rsync the repo into code/, respecting .gitignore to skip node_modules etc.
  execSync(`rsync -a --filter=':- .gitignore' --exclude='.git' "${projectDir}/" "${codePath}/"`, {
    stdio: 'inherit',
  });

  // Read the test catalog to discover which tests are hidden.
  const testsJsonPath = join(feature.absolutePath, 'tests', 'tests.json');
  if (!existsSync(testsJsonPath)) {
    throw new Error(
      `tests.json not found at ${testsJsonPath}. Run 'saifac feat design -n ${feature.name}' first.`,
    );
  }
  const catalog = JSON.parse(readFileSync(testsJsonPath, 'utf8')) as TestCatalog;

  // Remove ALL hidden/ dirs from saifac/features so the agent
  // cannot see holdout tests from any feature (current or others).
  const saifBase = join(codePath, saifDir);
  const featuresHidden = removeAllHiddenDirs(join(saifBase, 'features'));
  if (featuresHidden > 0) {
    console.log(
      `[sandbox] Removed ${featuresHidden} hidden/ dir(s) from code copy (agent cannot see holdout tests)`,
    );
  }

  // Overwrite the current feature's tests.json to contain only public tests.
  const inCodeTestsDir = join(codePath, feature.relativePath, 'tests');
  const publicCatalog: TestCatalog = {
    ...catalog,
    testCases: catalog.testCases.filter((tc) => tc.visibility === 'public'),
  };
  mkdirSync(inCodeTestsDir, { recursive: true });
  writeFileSync(join(inCodeTestsDir, 'tests.json'), JSON.stringify(publicCatalog, null, 2), 'utf8');

  const hiddenCount = catalog.testCases.filter((tc) => tc.visibility === 'hidden').length;
  const publicCount = publicCatalog.testCases.length;
  console.log(`[sandbox] ${publicCount} public test cases visible to agent, ${hiddenCount} hidden`);

  // Initialize a fresh git repo inside code/ for patch extraction
  await gitInit({ cwd: codePath, stdio: 'inherit' });
  await gitAdd({ cwd: codePath, stdio: 'inherit' });
  await gitCommit({
    cwd: codePath,
    message: 'Base state',
    verbose,
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'factory',
      GIT_AUTHOR_EMAIL: 'factory@localhost',
      GIT_COMMITTER_NAME: 'factory',
      GIT_COMMITTER_EMAIL: 'factory@localhost',
    },
  });
  console.log(`[sandbox] git init + initial commit done in ${codePath}`);

  // Write gate.sh: user-supplied content or the built-in pnpm check default.
  // Mounted read-only at /factory/gate.sh inside the coder container.
  writeFileSync(gatePath, gateScript, 'utf8');
  chmodSync(gatePath, 0o755);
  console.log(`[sandbox] Gate script written to ${gatePath}`);

  // Write startup.sh — always present; mounted read-only at /factory/startup.sh.
  // Set via --profile or --startup-script.
  writeFileSync(startupPath, startupScript, 'utf8');
  chmodSync(startupPath, 0o755);
  console.log(`[sandbox] Startup script written to ${startupPath}`);

  // Write agent-start.sh — mounted read-only at /factory/agent-start.sh.
  // Run once after project startup, before the agent loop. Used to install the agent.
  writeFileSync(agentStartPath, agentStartScript, 'utf8');
  chmodSync(agentStartPath, 0o755);
  console.log(`[sandbox] Agent start script written to ${agentStartPath}`);

  // Write agent.sh — mounted read-only at /factory/agent.sh.
  // Defaults to the agent profile's agent.sh (OpenHands). Override with --agent-script.
  writeFileSync(agentPath, agentScript, 'utf8');
  chmodSync(agentPath, 0o755);
  console.log(`[sandbox] Agent script written to ${agentPath}`);

  // Write stage.sh — mounted read-only in the staging container at /factory/stage.sh.
  // Set via --profile or --stage-script.
  writeFileSync(stagePath, stageScript, 'utf8');
  chmodSync(stagePath, 0o755);
  console.log(`[sandbox] Stage script written to ${stagePath}`);

  return {
    sandboxBasePath,
    codePath,
    gatePath,
    startupPath,
    agentStartPath,
    agentPath,
    stagePath,
    runId,
  };
}

/**
 * Removes the disposable sandbox directory.
 * Safe to call even if the directory does not exist.
 */
export function destroySandbox(sandboxBasePath: string): void {
  console.log(`[sandbox] Removing sandbox ${sandboxBasePath}`);
  execSync(`rm -rf "${sandboxBasePath}"`);
}

/** A pattern used to exclude files from the extracted patch. */
export type PatchExcludeRule =
  | { type: 'glob'; pattern: string }
  | { type: 'regex'; pattern: RegExp };

export interface ExtractPatchOpts {
  /**
   * File sections whose path matches any rule are stripped from the patch.
   * Paths are relative to the repo root (e.g. "saifac/features/foo/tests/tests.json").
   * Glob patterns are matched with minimatch; regex patterns are tested directly.
   */
  exclude?: PatchExcludeRule[];
}

/**
 * Extracts a git patch from changes in the code directory since the base commit.
 *
 * Any file sections matched by an `exclude` rule are stripped (reward-hacking prevention).
 * Writes patch.diff to sandboxBasePath (parent of codePath) so that `git clean -fd`
 * inside codePath cannot delete it before it is applied.
 *
 * Resets the sandbox back to base state so the next attempt starts clean.
 *
 * Returns both the patch content and the path where patch.diff was written.
 */
export async function extractPatch(
  codePath: string,
  opts: ExtractPatchOpts = {},
): Promise<{ patch: string; patchPath: string }> {
  // Write outside the git working tree so git clean cannot delete it.
  const sandboxBasePath = join(codePath, '..');
  const patchPath = join(sandboxBasePath, 'patch.diff');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'factory',
    GIT_AUTHOR_EMAIL: 'factory@localhost',
    GIT_COMMITTER_NAME: 'factory',
    GIT_COMMITTER_EMAIL: 'factory@localhost',
  };

  await gitAdd({ cwd: codePath, env: gitEnv });
  const rawPatch = await gitDiff({ cwd: codePath, env: gitEnv, args: ['HEAD'] });

  const patch = opts.exclude?.length ? filterPatchHunks(rawPatch, opts.exclude) : rawPatch;
  writeFileSync(patchPath, patch, 'utf8');

  // Reset for next attempt
  await gitResetHard({ cwd: codePath, env: gitEnv });
  await gitClean({ cwd: codePath, env: gitEnv });

  return { patch, patchPath };
}

/**
 * Removes file sections from a unified diff whose paths match any of the given exclude rules.
 *
 * A unified diff is a sequence of file sections, each starting with:
 *   diff --git a/<path> b/<path>
 * We split on those headers, test the path against each rule, and reassemble.
 */
export function filterPatchHunks(patch: string, exclude: PatchExcludeRule[]): string {
  if (!patch || exclude.length === 0) return patch;

  const sections = patch.split(/(?=^diff --git )/m);
  const filtered: string[] = [];
  const dropped: string[] = [];

  for (const section of sections) {
    const match = /^diff --git a\/(.+?) b\//.exec(section);
    if (match && isExcluded(match[1], exclude)) {
      dropped.push(match[1]);
    } else {
      filtered.push(section);
    }
  }

  if (dropped.length > 0) {
    console.warn(
      `[sandbox] Dropped ${dropped.length} file(s) from patch (reward-hacking prevention):\n` +
        dropped.map((p) => `  - ${p}`).join('\n'),
    );
  }

  return filtered.join('');
}

function isExcluded(filePath: string, rules: PatchExcludeRule[]): boolean {
  return rules.some((rule) =>
    rule.type === 'glob'
      ? minimatch(filePath, rule.pattern, { matchBase: false })
      : rule.pattern.test(filePath),
  );
}

/**
 * Applies a patch file to the code directory.
 * Used by 'test' mode to inject a candidate implementation.
 */
export async function applyPatch(codePath: string, patchPath: string): Promise<void> {
  if (!existsSync(patchPath)) {
    throw new Error(`Patch file not found: ${patchPath}`);
  }
  console.log(`[sandbox] Applying patch from ${patchPath}`);
  await gitApply({ cwd: codePath, patchFile: patchPath, stdio: 'inherit' });
}
