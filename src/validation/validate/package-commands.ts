/**
 * Validates that each file in scripts/commands/ exports a CommandDef with
 * required fields: name, description, usage, options, handler.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getSaifctlRoot } from '../../constants.js';

const commandsDir = join(getSaifctlRoot(), 'scripts', 'commands');

const REQUIRED_FIELDS = ['name', 'description', 'usage', 'options', 'handler'] as const;

function checkCommandDef(def: unknown, file: string): string[] {
  const errors: string[] = [];
  if (!def || typeof def !== 'object') {
    errors.push(`${file}: default export must be a CommandDef object`);
    return errors;
  }
  const obj = def as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push(`${file}: missing required field "${field}"`);
    } else if (field === 'handler') {
      if (typeof obj[field] !== 'function') {
        errors.push(`${file}: "handler" must be a function`);
      }
    } else if (field === 'options') {
      if (!obj[field] || typeof obj[field] !== 'object' || Array.isArray(obj[field])) {
        errors.push(`${file}: "options" must be a plain object (ParseArgsOptionsConfig)`);
      }
    } else if (field === 'name' || field === 'description' || field === 'usage') {
      if (typeof obj[field] !== 'string') {
        errors.push(`${file}: "${field}" must be a string`);
      }
    }
  }
  return errors;
}

export default async function (): Promise<void> {
  const errors: string[] = [];

  const files = await readdir(commandsDir);
  const tsFiles = files.filter((f) => f.endsWith('.ts')).sort();

  for (const file of tsFiles) {
    const url = pathToFileURL(join(commandsDir, file)).href;
    try {
      const mod = (await import(url)) as { default?: unknown };
      const def = mod.default;
      errors.push(...checkCommandDef(def, file));
    } catch (err) {
      errors.push(`${file}: failed to load (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      'Package commands validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}
