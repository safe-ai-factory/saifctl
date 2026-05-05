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

import { consola } from '../../logger.js';
import { spawnAsync, spawnCapture } from '../../utils/io.js';

/** Result of a `shotgun-sh codebase query` invocation. */
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
export async function runShotgunCli(args: string[], opts: RunShotgunCliOptions): Promise<void> {
  const python = resolveShotgunPython();
  const allArgs = ['-m', 'shotgun.main', ...args];
  if (opts?.printCmd) {
    const display = [python, ...allArgs]
      .map((a, i) => (i === 0 ? a : formatArgForDisplay(a)))
      .join(' ');
    consola.log(`  $ ${display}`);
  }
  await spawnAsync({
    command: python,
    args: allArgs,
    cwd: opts.projectDir,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    stdio: 'inherit',
  });
}

/**
 * Runs `<python> -m shotgun.main codebase query <graphId> "<question>"` and returns the raw output.
 */
export async function queryShotgunIndex(
  opts: QueryShotgunIndexOptions,
): Promise<ShotgunQueryResult> {
  const python = resolveShotgunPython();
  const { graphId, question, projectDir } = opts;
  const display = [
    python,
    '-m',
    'shotgun.main',
    'codebase',
    'query',
    graphId,
    formatArgForDisplay(question),
  ].join(' ');
  consola.log(`  $ ${display}`);

  try {
    const raw = await spawnCapture({
      command: python,
      args: ['-m', 'shotgun.main', 'codebase', 'query', graphId, question],
      cwd: projectDir,
    });
    return { raw: raw.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`shotgun-sh codebase query failed: ${msg}`);
  }
}

/**
 * Capture stdout from `<python> -m shotgun.main <args>` (pipe mode).
 */
export async function runShotgunCapture(
  args: string[],
  opts: RunShotgunCliOptions,
): Promise<string> {
  const python = resolveShotgunPython();
  if (opts?.printCmd) {
    const allArgs = ['-m', 'shotgun.main', ...args];
    const display = [python, ...allArgs]
      .map((a, i) => (i === 0 ? a : formatArgForDisplay(a)))
      .join(' ');
    consola.log(`  $ ${display}`);
  }
  return spawnCapture({
    command: python,
    args: ['-m', 'shotgun.main', ...args],
    cwd: opts.projectDir,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  });
}
