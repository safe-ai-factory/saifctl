import { spawn, type StdioOptions } from 'node:child_process';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';

/** Read a file as UTF-8 text. */
export async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

/** Options for {@link writeUtf8}. */
export interface WriteUtf8Options {
  /** Unix file mode, e.g. `0o755`. */
  mode?: number;
}

/** Write UTF-8 text; optional file mode (chmod). */
/** eslint-disable-next-line max-params */
export async function writeUtf8(
  filePath: string,
  data: string,
  options?: WriteUtf8Options,
): Promise<void> {
  await writeFile(filePath, data, {
    encoding: 'utf8',
    ...(options?.mode != null ? { mode: options.mode } : {}),
  });
}

/** Read a file as a raw buffer (binary). */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

/** Append UTF-8 text to a file (creates the file if missing). */
export async function appendUtf8(filePath: string, data: string): Promise<void> {
  await appendFile(filePath, data, 'utf8');
}

/** True if `path` is reachable (same idea as {@link import('node:fs').existsSync}). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Options for {@link spawnAsync} — argv-style spawn with no shell, configurable stdio. */
export interface SpawnAsyncOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

function formatCmd(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/**
 * Spawn `[command, ...args]` with no shell. Resolves with no return value on exit 0; rejects on
 * non-zero exit or spawn failure.
 *
 * Prefer this over {@link spawnWait} when you do not need captured output — e.g. side-effect
 * commands or `stdio: 'inherit'` so the child streams straight to the terminal. Unlike
 * {@link spawnWait}, `stdio` is configurable (defaults to `'pipe'`), there is no timeout option,
 * and exit code != 0 always rejects instead of resolving with `code`.
 */
export function spawnAsync(opts: SpawnAsyncOpts): Promise<void> {
  const { command, args, cwd, env, stdio } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: stdio ?? 'pipe',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${formatCmd(command, args)} exited with code ${code}`));
      }
    });
  });
}

/** Options for {@link spawnCapture} / {@link spawnWait}: argv-style spawn with optional `timeoutMs` (SIGTERM on expiry). */
export type SpawnCaptureOpts = Pick<SpawnAsyncOpts, 'command' | 'args' | 'cwd' | 'env'> & {
  /** When set, kill the child and reject if still running after this many ms. */
  timeoutMs?: number;
};

/** Result of {@link spawnWait}: exit code/signal plus captured stdout and stderr. */
export interface SpawnWaitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `[command, ...args]` with no shell; capture stdout/stderr as UTF-8 until exit. Always
 * resolves with `{ code, signal, stdout, stderr }` for normal completion — inspect `code` for
 * failure. Rejects only on spawn failure or {@link SpawnCaptureOpts.timeoutMs} (SIGTERM).
 *
 * Stdio is fixed to `['ignore','pipe','pipe']` so output can be buffered. Prefer {@link spawnAsync}
 * when you want `stdio: 'inherit'` or no capture; use {@link spawnCapture} when you want stdout as
 * a string and a thrown error on non-zero exit.
 *
 * Drains stderr so the child cannot hang on a full buffer.
 */
export function spawnWait(opts: SpawnCaptureOpts): Promise<SpawnWaitResult> {
  const { command, args, cwd, env, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (timeoutMs != null && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(new Error(`${formatCmd(command, args)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) return;
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

/**
 * Like {@link spawnWait} (same capture + optional `timeoutMs`) but returns stdout as a string and
 * rejects on non-zero exit with stderr/stdout in the message.
 */
export function spawnCapture(opts: SpawnCaptureOpts): Promise<string> {
  return spawnWait(opts).then((r) => {
    if (r.code === 0) {
      return r.stdout;
    }
    const hint = r.stderr.trim() || r.stdout.trim() || '(no output)';
    throw new Error(`${formatCmd(opts.command, opts.args)} exited with code ${r.code}: ${hint}`);
  });
}

/** Options for {@link spawnUserCmd} — runs a string `script` through the system shell. */
export interface SpawnUserCmdOpts {
  /**
   * User-given or config-given command line, run as-is through the system shell (as in an
   * interactive terminal), e.g. `npm run lint`. Use when you need shell semantics: PATH lookup, env
   * vars, globs, `&&` / `|`, or invoking npm/pnpm-style scripts. Prefer {@link spawnAsync} /
   * {@link spawnCapture} with argv when the executable and arguments are known — no shell avoids
   * injection and quoting bugs.
   */
  script: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/**
 * Run a user-given command line via `spawn(..., { shell: true })` (cross-platform). Resolves on
 * exit 0; rejects on non-zero exit or spawn failure. Default `stdio` is `'inherit'` so output
 * streams to the terminal.
 *
 * For validation hooks, `pnpm …` lines, or any string the user could type in a shell. For
 * structured argv and no shell, use {@link spawnAsync} instead.
 */
export function spawnUserCmd(opts: SpawnUserCmdOpts): Promise<void> {
  const { script, cwd, env, stdio = 'inherit' } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(script, {
      shell: true,
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
      stdio,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Shell command exited with code ${code}: ${script}`));
      }
    });
  });
}

/**
 * Like {@link spawnUserCmd} but captures output with piped stdio: stdout and stderr are
 * concatenated into one string (interleaved as chunks arrive), so warnings on stderr stay visible in
 * context — useful for user-given CLI lines where you want “terminal-like” capture without
 * inheritance.
 *
 * Resolves with that merged string on exit 0. On failure, rejects with
 * `{ name: 'ShellCommand', command, output, code }` (not `Error`), preserving the captured output
 * for callers that branch on it.
 */
export function spawnUserCmdCapture(
  script: string,
  opts: Pick<SpawnUserCmdOpts, 'cwd' | 'env'> = {},
): Promise<string> {
  const { cwd, env } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(script, {
      shell: true,
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d: string | Buffer) => {
      out += String(d);
    });
    child.stderr!.on('data', (d: string | Buffer) => {
      out += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject({ name: 'ShellCommand', command: script, output: out, code: code ?? 1 });
      }
    });
  });
}
