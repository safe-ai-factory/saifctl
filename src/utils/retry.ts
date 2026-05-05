/**
 * Generic retry-with-backoff utility.
 */

/** Returns true when `err` should trigger a retry rather than an immediate rethrow. */
export type IsRetriable = (err: unknown) => boolean;

/** Options for {@link retryWithBackoff}: the operation, retry predicate, attempt cap, and backoff schedule. */
export interface RetryWithBackoffOpts<T> {
  /** The operation to attempt. */
  fn: () => Promise<T>;
  /**
   * Return true when an error is transient and the call should be retried.
   * Return false to rethrow immediately without further attempts.
   */
  isRetriable: IsRetriable;
  /** Maximum number of attempts (first call counts as attempt 0). */
  maxAttempts: number;
  /**
   * Delay in milliseconds before attempt `i + 1` (called after each failed attempt except
   * the last one). `i` is 0-indexed: 0 = after the first failure.
   */
  backoffMs: (attemptIndex: number) => number;
}

/**
 * Call `fn` up to `maxAttempts` times. On a retriable error, wait `backoffMs(attemptIndex)` ms
 * before retrying. Rethrows immediately on non-retriable errors or when attempts are exhausted.
 *
 * @example
 * await retryWithBackoff({
 *   fn: () => rm(path, { recursive: true, force: true }),
 *   isRetriable: isTransientFsError,
 *   maxAttempts: 15,
 *   backoffMs: (i) => Math.min(800, 40 * 2 ** Math.min(i, 4)),
 * });
 */
export async function retryWithBackoff<T>(opts: RetryWithBackoffOpts<T>): Promise<T> {
  const { fn, isRetriable, maxAttempts, backoffMs } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetriable(err)) throw err;
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs(attempt)));
      }
    }
  }

  throw lastErr;
}

/** Returns true when `err` is a Node.js filesystem error with one of the given `codes`. */
export function isErrnoCode(err: unknown, codes: ReadonlySet<string>): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code != null && codes.has(code);
}
