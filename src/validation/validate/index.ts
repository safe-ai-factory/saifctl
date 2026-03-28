/**
 * Validation runner — discovers and executes all validation scripts in this
 * directory. Each script must export a default async function. If any script
 * throws, the runner exits with code 1.
 *
 * Exported as runValidation() for use by the commands CLI.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getSaifctlRoot } from '../../constants.js';
import { consola } from '../../logger.js';

/** Package-root based: works when this module is bundled into dist/chunks. */
const __dirname = join(getSaifctlRoot(), 'src', 'validation', 'validate');

/**
 * Run all validation scripts in this directory.
 * Caller is responsible for handling --help (typically via commands runner).
 */
export async function runValidation(): Promise<void> {
  const files = await readdir(__dirname);
  const scripts = files.filter((f) => f.endsWith('.ts') && f !== 'index.ts').sort();

  if (scripts.length === 0) {
    consola.log('No validation scripts found.');
    return;
  }

  let failed = false;

  for (const script of scripts) {
    consola.log(`\n=== ${script} ===\n`);
    try {
      const mod = (await import(pathToFileURL(join(__dirname, script)).href)) as {
        default?: unknown;
      };
      if (typeof mod.default !== 'function') {
        throw new Error(`${script} does not export a default function`);
      }
      await (mod.default as () => Promise<void>)();
      consola.log(`\nPASS: ${script}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      consola.error(`\nFAIL: ${script} -- ${message}`);
      failed = true;
    }
  }

  consola.log('');

  if (failed) {
    throw new Error('One or more validation scripts failed.');
  }
  consola.log('All validation scripts passed.');
}
