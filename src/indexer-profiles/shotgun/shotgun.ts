/**
 * Low-level Shotgun CLI helpers.
 *
 * These functions wrap `shotgun-sh` subprocess calls. They are used internally
 * by the Shotgun indexer profile (src/indexer-profiles/shotgun.ts).
 *
 * Invocation: `<python> -m shotgun.main <args>`
 * where `<python>` defaults to `python` and can be overridden via the
 * SHOTGUN_PYTHON env var (e.g. `SHOTGUN_PYTHON=/path/to/.venv/bin/python`).
 *
 * @see {@link file://src/indexer-profiles/shotgun.ts}
 * @see {@link file://.cursor/skills/project/setup-swe-factory/SKILL.md Phase 2}
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface ShotgunQueryResult {
  /** Raw stdout from shotgun-sh codebase query. */
  raw: string;
}

/** Options for queryShotgunIndex. */
export interface QueryShotgunIndexOptions {
  graphId: string;
  question: string;
  /** Project directory (where pyproject.toml lives). */
  projectDir: string;
}

/**
 * Returns the Python binary to use for `shotgun.main` invocations.
 * Reads SHOTGUN_PYTHON from the environment; falls back to `"python"`.
 */
export function resolveShotgunPython(): string {
  return process.env.SHOTGUN_PYTHON?.trim() || 'python';
}

/** Options for runShotgunCli. */
export interface RunShotgunCliOptions {
  /** Project directory. */
  projectDir: string;
  /** Environment overrides (merged with process.env). */
  env?: Record<string, string>;
  /** Print the command to stdout before running (e.g. `  $ python -m shotgun.main ...`). */
  printCmd?: boolean;
}

function formatArgForDisplay(arg: string): string {
  return arg.includes(' ') || arg.includes('\n') ? JSON.stringify(arg) : arg;
}

/**
 * Runs `<python> -m shotgun.main <args>` with stdio inherited.
 * Use for interactive or long-running commands (e.g. spec generation).
 */
export function runShotgunCli(
  args: string[],
  opts: RunShotgunCliOptions,
): SpawnSyncReturns<string> {
  const python = resolveShotgunPython();
  const allArgs = ['-m', 'shotgun.main', ...args];
  if (opts?.printCmd) {
    const display = [python, ...allArgs]
      .map((a, i) => (i === 0 ? a : formatArgForDisplay(a)))
      .join(' ');
    console.log(`  $ ${display}`);
  }
  const result = spawnSync(python, allArgs, {
    stdio: 'inherit',
    cwd: opts.projectDir,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`shotgun.main exited with code ${result.status ?? 'unknown'}`);
  }
  return result;
}

/**
 * Runs `<python> -m shotgun.main codebase query <graphId> "<question>"` and returns the raw output.
 */
export function queryShotgunIndex(opts: QueryShotgunIndexOptions): ShotgunQueryResult {
  const { graphId, question, projectDir } = opts;
  const result = runShotgunCli(['codebase', 'query', graphId, question], {
    projectDir,
    printCmd: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `shotgun-sh codebase query failed: ${result.stderr?.trim() ?? result.error?.message ?? 'unknown'}`,
    );
  }
  return { raw: (result.stdout ?? '').trim() };
}
