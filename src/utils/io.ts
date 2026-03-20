import { spawn, type StdioOptions } from 'node:child_process';

export interface SpawnAsyncOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/**
 * Spawn a process and resolve when it exits with code 0.
 * Rejects on non-zero exit.
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
        reject(new Error(`${command} ${args[0]} exited with code ${code}`));
      }
    });
  });
}

export type SpawnCaptureOpts = Pick<SpawnAsyncOpts, 'command' | 'args' | 'cwd' | 'env'>;

/**
 * Spawn a process, capture stdout as UTF-8. Rejects on non-zero exit.
 */
export function spawnCapture(opts: SpawnCaptureOpts): Promise<string> {
  const { command, args, cwd, env } = opts;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new Error(`${command} ${args[0]} exited with code ${code}`));
      }
    });
  });
}
