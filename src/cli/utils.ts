/**
 * Shared CLI helpers used across command implementations.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LLM_API_KEYS } from '../constants.js';

/**
 * Ensures CONTEXT7_API_KEY is set. Throws if missing.
 */
export function requireContext7ApiKey(): string {
  const key = process.env.CONTEXT7_API_KEY;
  if (!key || key.trim() === '') {
    throw new Error('CONTEXT7_API_KEY is not set. Set it in your environment before running init.');
  }
  return key;
}

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
 * Resolves the project name: --project override, else package.json "name" from repo root.
 * Throws if neither yields a usable name.
 */
export function resolveProjectName(opts: { project?: string }, repoRoot: string): string {
  const fromOpt = typeof opts.project === 'string' ? opts.project.trim() : '';
  if (fromOpt) return fromOpt;

  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    throw new Error(
      `Cannot determine project name: no package.json found at ${resolve(repoRoot, 'package.json')}. ` +
        `Specify -p/--project.`,
    );
  }

  throw new Error(
    `Cannot determine project name: package.json at ${resolve(repoRoot, 'package.json')} has no "name" field. ` +
      `Specify -p/--project.`,
  );
}
