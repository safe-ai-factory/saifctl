/**
 * Shared CLI helpers used across command implementations.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cancel, intro, isCancel, outro, select } from '@clack/prompts';

import { LLM_API_KEYS } from '../constants.js';
import {
  DEFAULT_DESIGNER_PROFILE,
  type DesignerProfile,
  resolveDesignerProfile,
} from '../designer-profiles/index.js';
import {
  DEFAULT_INDEXER_PROFILE,
  type IndexerProfile,
  resolveIndexerProfile,
} from '../indexer-profiles/index.js';
import { DEFAULT_PROFILE, resolveTestProfile, type TestProfile } from '../test-profiles/index.js';

/**
 * Ensures at least one LLM API key is set. Throws if none are set.
 */
export function requireLlmApiKey(): void {
  const hasAny = LLM_API_KEYS.some((name) => {
    const v = process.env[name];
    return v != null && String(v).trim() !== '';
  });
  if (!hasAny) {
    throw new Error(
      `None of the LLM API keys are set. Set at least one of: ${LLM_API_KEYS.join(', ')}`,
    );
  }
}

/**
 * Validates that a change/feature name is safe (kebab-case).
 * Exits with an error message if invalid.
 */
export function validateChangeName(name: string): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    console.error(
      `Invalid feature name: "${name}". ` +
        `Names must be kebab-case (lowercase letters, digits, and hyphens only, e.g. "add-login").`,
    );
    process.exit(1);
  }
}

/**
 * Resolves the project directory from --project-dir.
 * Returns the absolute path. Defaults to process.cwd() when omitted or empty.
 */
export function parseProjectDir(args: { 'project-dir'?: string }): string {
  const raw = args['project-dir'];
  const dir = typeof raw === 'string' && raw.trim() ? raw.trim() : '.';
  return resolve(process.cwd(), dir);
}

/**
 * Resolves the openspec directory from --openspec-dir. Returns 'openspec' when omitted or empty.
 */
export function parseOpenspecDir(args: { 'openspec-dir'?: string }): string {
  const raw = args['openspec-dir'];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'openspec';
}

/**
 * Resolves the project name: --project override, else package.json "name" from repo root.
 * Throws if neither yields a usable name.
 */
export function resolveProjectName(opts: { project?: string }, projectDir: string): string {
  const fromOpt = typeof opts.project === 'string' ? opts.project.trim() : '';
  if (fromOpt) return fromOpt;

  try {
    const pkg = JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    throw new Error(
      `Cannot determine project name: no package.json found at ${resolve(projectDir, 'package.json')}. ` +
        `Specify -p/--project.`,
    );
  }

  throw new Error(
    `Cannot determine project name: package.json at ${resolve(projectDir, 'package.json')} has no "name" field. ` +
      `Specify -p/--project.`,
  );
}

/**
 * Returns the feature name from args if present and valid. Otherwise undefined.
 */
export function getFeatNameFromArgs(args: { name?: string }): string | undefined {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined;
  if (name) validateChangeName(name);
  return name || undefined;
}

/**
 * Resolves feature name from args or prompts the user to select from OpenSpec changes.
 * Exits if no changes exist or user cancels.
 */
export async function getFeatNameOrPrompt(
  args: { name?: string },
  projectDir: string,
): Promise<string> {
  const fromArgs = getFeatNameFromArgs(args);
  if (fromArgs) return fromArgs;

  const raw = execSync('npx openspec list --json', { encoding: 'utf-8', cwd: projectDir });
  let changes: { name: string }[];
  try {
    const data = JSON.parse(raw) as { changes?: { name: string }[] };
    changes = data?.changes ?? [];
  } catch {
    changes = [];
  }

  if (changes.length === 0) {
    console.error('No OpenSpec changes found. Run `saif feat new` first.');
    process.exit(1);
  }

  changes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  intro('Select feature');
  const result = await select({
    message: 'Feature / change',
    options: changes.map((c) => ({ value: c.name, label: c.name })),
  });
  outro('');
  if (isCancel(result)) {
    cancel('Operation cancelled.');
    process.exit(1);
  }
  return result as string;
}

/**
 * Resolves the designer profile from --designer. Returns DEFAULT_DESIGNER_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseDesignerProfile(args: { designer?: string }): DesignerProfile {
  const raw = typeof args.designer === 'string' ? args.designer.trim() : '';
  if (!raw) return DEFAULT_DESIGNER_PROFILE;
  try {
    return resolveDesignerProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the indexer profile from --indexer.
 * Returns undefined when indexer is "none", DEFAULT_INDEXER_PROFILE when omitted,
 * or the resolved profile when a valid id is given. Exits on invalid id.
 */
export function parseIndexerProfile(args: { indexer?: string }): IndexerProfile | undefined {
  const indexerRaw = typeof args.indexer === 'string' ? args.indexer.trim() : '';

  // Allow explicit `--indexer none` to disable the indexer.
  if (indexerRaw === 'none') return undefined;

  if (!indexerRaw) return DEFAULT_INDEXER_PROFILE;
  try {
    return resolveIndexerProfile(indexerRaw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}

/**
 * Resolves the test profile from --test-profile. Returns DEFAULT_PROFILE when omitted.
 * Exits with an error if the given profile id is invalid.
 */
export function parseTestProfile(args: { 'test-profile'?: string }): TestProfile {
  const raw = typeof args['test-profile'] === 'string' ? args['test-profile'].trim() : '';
  if (!raw) return DEFAULT_PROFILE;
  try {
    return resolveTestProfile(raw);
  } catch (err) {
    console.error(`Error: ${String(err instanceof Error ? err.message : err)}`);
    process.exit(1);
  }
}
