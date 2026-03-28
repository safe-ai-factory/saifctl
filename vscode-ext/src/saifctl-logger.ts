/**
 * VS Code extension logger — mirrors `safe-ai-factory/src/logger.ts` defaults.
 * Kept local because the extension bundle is CommonJS while the main package logger is ESM.
 *
 * Uses consola/basic (plain reporter) because the extension host is not a TTY;
 * the fancy reporter's ANSI codes and spinners would appear as raw escape sequences
 * in the VS Code Output panel.
 */
import { type ConsolaInstance, createConsola, LogLevels } from 'consola/basic';

export const logger: ConsolaInstance = createConsola({
  defaults: {
    tag: 'saifctl',
  },
});

export const consola: ConsolaInstance = logger;

const baselineLogLevel = logger.level;

export function setVerboseLogging(verbose: boolean): void {
  logger.level = verbose ? LogLevels.debug : baselineLogLevel;
}

/** Mirrors `safe-ai-factory/src/logger.ts` — plain stdout for pipe/copy-friendly CLI output. */
export function outputCliData(message: string): void {
  process.stdout.write(message);
  process.stdout.write('\n');
}

export { LogLevels };
export type { ConsolaInstance };
