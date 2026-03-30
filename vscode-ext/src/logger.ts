/**
 * VS Code extension logger.
 *
 * Consola is the primary logger. When running inside the extension host,
 * call `attachOutputChannel(channel)` once during activation to install a
 * reporter that mirrors every log line into the VS Code Output panel.
 *
 * Uses consola/basic (plain reporter) because the extension host is not a TTY;
 * the fancy reporter's ANSI codes and spinners would appear as raw escape sequences.
 *
 * Every line mirrored to the SaifCTL Output channel is prefixed with `[SaifCTL] `
 * (see formatEntry) so logs are easy to grep and filter.
 */
import { type ConsolaInstance, createConsola, LogLevels, type LogObject } from 'consola/basic';
import * as vscode from 'vscode';

export { LogLevels };
export type { ConsolaInstance };

export const logger: ConsolaInstance = createConsola({
  defaults: { tag: 'saifctl' },
});

const baselineLogLevel = logger.level;

export function setVerboseLogging(verbose: boolean): void {
  // Trace is the most verbose consola level so resolver dir-by-dir logs appear in the Output panel.
  logger.level = verbose ? LogLevels.trace : baselineLogLevel;
}

////////////////////////////////////
// VSCode Output Channel - Forward consola logs to the Output panel
////////////////////////////////////

/**
 * Install a reporter that forwards every log entry to a VS Code LogOutputChannel.
 * Safe to call multiple times (replaces the reporter set).
 * Must be called after `vscode.window.createOutputChannel` is available (i.e. inside activate()).
 */
function attachOutputChannel(channel: vscode.LogOutputChannel): void {
  logger.setReporters([
    {
      log(entry: LogObject): void {
        const msg = formatEntry(entry);
        switch (entry.level) {
          case LogLevels.error:
            channel.error(msg);
            break;
          case LogLevels.warn:
            channel.warn(msg);
            break;
          case LogLevels.info:
          case LogLevels.log:
            channel.info(msg);
            break;
          case LogLevels.debug:
            channel.debug(msg);
            break;
          default:
            // trace and anything else
            channel.trace(msg);
        }
      },
    },
  ]);
}

const OUTPUT_PREFIX = '[SaifCTL]';

/** Flatten consola LogObject args into a single string for the Output channel. */
function formatEntry(entry: LogObject): string {
  const body = entry.args
    .map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  // Avoid double prefix when callers already include it (e.g. legacy messages).
  if (/^\s*\[SaifCTL\]/.test(body)) {
    return body;
  }
  return `${OUTPUT_PREFIX} ${body}`;
}

// The { log: true } flag gives info/warn/error/debug/trace levels and the
// log-level dropdown in the Output panel UI.
export const saifctlOutputChannel = vscode.window.createOutputChannel('SaifCTL', { log: true });

// Route all consola calls (logger.info, consola.log, etc.) into this channel
// so every log ends up in the Output panel, not just extension-host stdout.
attachOutputChannel(saifctlOutputChannel);
