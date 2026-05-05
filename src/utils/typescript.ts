import { consola } from '../logger.js';
import { spawnWait } from './io.js';

// TypeScript validation: ensure generated spec files have no syntax/type errors.
// - catch: spawn threw (e.g. npx/tsc not on PATH). Non-fatal — validation skipped.
// - status === 0: tsc found no errors. Validation passed.
// - status !== 0: tsc ran and reported real errors (bad imports, broken syntax).
/**
 * Run `npx tsc --noEmit` against `files` to catch syntax/type errors in
 * generated spec files. Tsc launch failure (missing PATH) is logged and
 * treated as non-fatal; non-zero `tsc` exit prints the first 20 output lines
 * and exits the process with `errMessage`.
 */
export async function validateTypescript(opts: {
  files: string[];
  cwd: string;
  errMessage: string;
}) {
  const { files, cwd, errMessage } = opts;
  try {
    const tscResult = await spawnWait({
      command: 'npx',
      args: [
        'tsc',
        '--noEmit',
        '--allowJs',
        '--checkJs',
        'false',
        '--strict',
        'false',
        '--moduleResolution',
        'bundler',
        '--module',
        'esnext',
        '--target',
        'esnext',
        '--skipLibCheck',
        'true',
        ...files,
      ],
      cwd,
      timeoutMs: 30_000,
    });
    if (tscResult.code === 0) {
      consola.log(`  TypeScript validation passed.`);
    } else {
      const output = tscResult.stdout + tscResult.stderr;
      consola.error(`  ${errMessage}`);
      for (const line of output.split('\n').filter(Boolean).slice(0, 20)) {
        consola.error(`    ${line}`);
      }
      process.exit(1);
    }
  } catch {
    consola.warn(`  TypeScript validation skipped (tsc not available).`);
  }
}
