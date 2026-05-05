/**
 * Stdout/stderr interception for the integration harness.
 *
 * Wraps `process.stdout.write` and `process.stderr.write` while a scenario
 * runs, recording every chunk into an internal buffer AND forwarding to the
 * original stream so the developer still sees live test output. `stop()`
 * restores the originals and returns the joined buffers.
 *
 * Why intercept at the stdio level (rather than via a consola reporter):
 * the orchestrator emits logs through three paths — consola (`[saifctl] …`),
 * `defaultEngineLog` (raw `process.stdout.write` for container lines, see
 * src/engines/logs.ts:28-38), and direct child-process stderr forwarding.
 * One stdio intercept catches all three; a consola reporter would miss
 * container log lines.
 *
 * Used by the harness to:
 *   1. Verify secrets (`ANTHROPIC_API_KEY`) never appear in any log output
 *      the test process produced — D-07 / X08-P2 pitfall #4.
 *   2. Mirror every chunk to a disk file in real time when `mirrorPath` is
 *      set, so logs survive **vitest test timeouts** (the in-memory buffer
 *      is lost when the test fn is aborted; the file persists). This is the
 *      primary triage surface when an LLM run times out.
 *
 * Concurrency: vitest config uses `pool: 'forks' + singleFork: true`
 * (vitest.integration.config.ts), so scenarios run sequentially in one
 * process — no concurrent capture race.
 */
import { closeSync, openSync, writeSync } from 'node:fs';

export interface CapturedStdio {
  stdout: string;
  stderr: string;
}

export interface StdioCaptureHandle {
  /** Restores originals and returns the captured buffers. Idempotent. */
  stop(): CapturedStdio;
  /**
   * Disk file the capture is mirroring to (when `mirrorPath` was set), or
   * `null`. Surfaced on the harness result so a failing/timing-out test can
   * point the user at it for triage.
   */
  mirrorPath: string | null;
}

export interface StdioCaptureOpts {
  /**
   * If set, every captured chunk is appended to this file in real time
   * (synchronous `writeSync` so it survives `process.exit` / vitest abort).
   * Stdout and stderr are interleaved in arrival order with `[stderr]` /
   * `[stdout]` line prefixes for disambiguation.
   */
  mirrorPath?: string;
}

/**
 * Matches both `write(chunk, cb?)` and `write(chunk, encoding, cb?)` overloads
 * of node's WriteStream — and forwards args to the original via `apply`, which
 * preserves typing without an `any`-cast.
 */
type StreamWrite = typeof process.stdout.write;

export function startStdioCapture(opts: StdioCaptureOpts = {}): StdioCaptureHandle {
  const origStdoutWrite: StreamWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite: StreamWrite = process.stderr.write.bind(process.stderr);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Open the mirror file synchronously so any caller that catches a
  // throw-on-open never sees a half-initialised handle. `'a'` so re-runs
  // append rather than truncate (helpful when the same scenario is rerun
  // against an existing tmp project for debugging).
  const mirrorFd = opts.mirrorPath ? openSync(opts.mirrorPath, 'a') : null;

  const toStr = (chunk: unknown): string => {
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf-8');
    return String(chunk);
  };

  const writeMirror = (label: 'stdout' | 'stderr', text: string): void => {
    if (mirrorFd === null) return;
    // Tag at line granularity so consumers can distinguish stdout vs stderr
    // without a separate file. Trailing newline preserved so the next chunk
    // doesn't glue to the previous one when both sources are interleaved.
    try {
      writeSync(mirrorFd, `[${label}] ${text}`);
    } catch {
      // Disk full / fd closed mid-run shouldn't crash the test — the
      // in-memory buffer is still authoritative for the assertion.
    }
  };

  interface WrapTarget {
    orig: StreamWrite;
    sink: string[];
    label: 'stdout' | 'stderr';
  }

  const wrap = (target: WrapTarget): StreamWrite => {
    const fn = function wrapped(this: unknown, ...args: Parameters<StreamWrite>): boolean {
      const text = toStr(args[0]);
      target.sink.push(text);
      writeMirror(target.label, text);
      return Reflect.apply(target.orig, this, args) as boolean;
    };
    return fn as unknown as StreamWrite;
  };

  process.stdout.write = wrap({ orig: origStdoutWrite, sink: stdoutChunks, label: 'stdout' });
  process.stderr.write = wrap({ orig: origStderrWrite, sink: stderrChunks, label: 'stderr' });

  let stopped = false;
  return {
    mirrorPath: opts.mirrorPath ?? null,
    stop(): CapturedStdio {
      if (!stopped) {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
        if (mirrorFd !== null) {
          try {
            closeSync(mirrorFd);
          } catch {
            // already closed — fine
          }
        }
        stopped = true;
      }
      return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
    },
  };
}
