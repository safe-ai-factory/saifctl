/**
 * Functional decorator for VS Code command handlers: logs debug on entry and trace
 * on exit (in a `finally` block), including when the handler throws or returns early.
 */
import { logger } from './logger';

export type LoggedCommandOptions<TArgs extends unknown[], R> = {
  commandId: string;
  /** Shown after `Command id → start:` (debug level). */
  startDetail?: (...args: TArgs) => string | undefined;
  /** Shown after `Command id ← end:` (trace level). Receives the handler return value. */
  endDetail?: (
    result: R | undefined,
    args: TArgs,
  ) => string | undefined | Promise<string | undefined>;
};

export function loggedCommand<TArgs extends unknown[], R = void>(
  commandId: string,
  fn: (...args: TArgs) => R | Promise<R>,
): (...args: TArgs) => Promise<R | undefined>;
export function loggedCommand<TArgs extends unknown[], R = void>(
  opts: LoggedCommandOptions<TArgs, R>,
  fn: (...args: TArgs) => R | Promise<R>,
): (...args: TArgs) => Promise<R | undefined>;
export function loggedCommand<TArgs extends unknown[], R = void>(
  commandIdOrOpts: string | LoggedCommandOptions<TArgs, R>,
  fn: (...args: TArgs) => R | Promise<R>,
): (...args: TArgs) => Promise<R | undefined> {
  const commandId =
    typeof commandIdOrOpts === 'string' ? commandIdOrOpts : commandIdOrOpts.commandId;
  const startDetail = typeof commandIdOrOpts === 'string' ? undefined : commandIdOrOpts.startDetail;
  const endDetail = typeof commandIdOrOpts === 'string' ? undefined : commandIdOrOpts.endDetail;

  return async (...args: TArgs): Promise<R | undefined> => {
    const startExtra = startDetail?.(...args);
    logger.debug(`Command ${commandId} → start${startExtra ? `: ${startExtra}` : ''}`);

    let result: R | undefined;
    try {
      result = await fn(...args);
      return result;
    } finally {
      const endExtra = await endDetail?.(result, args);
      logger.trace(`Command ${commandId} ← end${endExtra ? `: ${endExtra}` : ''}`);
    }
  };
}
