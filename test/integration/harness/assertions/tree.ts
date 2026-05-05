/**
 * Working-tree assertions for integration scenarios.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function fileExists(projectDir: string, relPath: string): Promise<boolean> {
  try {
    const s = await stat(join(projectDir, relPath));
    return s.isFile();
  } catch {
    return false;
  }
}

export async function readProjectFile(projectDir: string, relPath: string): Promise<string> {
  return readFile(join(projectDir, relPath), 'utf-8');
}

export interface AssertNoSecretInStringOpts {
  haystack: string;
  secret: string;
  label: string;
}

export function assertNoSecretInString(opts: AssertNoSecretInStringOpts): void {
  if (!opts.secret) return;
  if (opts.haystack.includes(opts.secret)) {
    throw new Error(`Secret leak detected in ${opts.label}: API key value found in output`);
  }
}
