/**
 * Application-wide Consola instance.
 *
 * Prefer `import { consola } from '../logger.js'` (or `./logger.js`) instead of
 * `import { consola } from 'consola'` so tags, level, and reporters stay consistent.
 *
 * For machine- or copy-friendly CLI output (tables, JSON, path lists), use
 * {@link outputCliData} instead of `consola.log` so lines are not prefixed with
 * tag/timestamp.
 *
 * Environment (handled by Consola when this instance is created):
 * - `CONSOLA_LEVEL` — numeric minimum log level
 * - `DEBUG` — influences default level when `CONSOLA_LEVEL` is unset
 *
 * CLI `--verbose` hooks into {@link setVerboseLogging}.
 *
 * VS Code extension: duplicate defaults live in `vscode-ext/src/saifctl-logger.ts`.
 */

import { type ConsolaInstance, createConsola, LogLevels } from 'consola';

export const logger: ConsolaInstance = createConsola({
  defaults: {
    tag: 'saifctl',
  },
});

/** Same instance as {@link logger}; use either name. */
export const consola: ConsolaInstance = logger;

/** Level from env/reporter defaults on first load, before CLI overrides. */
const baselineLogLevel = logger.level;

/**
 * Turns verbose logging on or off for the shared `logger` instance.
 * Call from CLI after parsing flags (e.g. `saifctl feat run --verbose`).
 */
export function setVerboseLogging(verbose: boolean): void {
  logger.level = verbose ? LogLevels.debug : baselineLogLevel;
}

/**
 * Print CLI command payload to stdout without Consola formatting (no tag/timestamp).
 * Use for pipe- or copy-friendly output: tables, JSON, path lists, bulk id lines.
 * Appends one newline after `message` (same as `console.log` for a single string).
 */
export function outputCliData(message: string): void {
  process.stdout.write(message);
  process.stdout.write('\n');
}

export { LogLevels };
export type { ConsolaInstance };
