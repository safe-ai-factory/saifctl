/**
 * Recursive discovery of features in saifctl/features.
 *
 * Supports Next.js-style route groups: directories named (group-name) are
 * traversed. Feature ID = entire relative path from features/.
 *
 * Example:
 *   saifctl/features/my-feat/              -> feature: my-feat
 *   saifctl/features/(auth)/login/        -> feature: (auth)/login
 *   saifctl/features/(auth)/router/       -> feature: (auth)/router
 *   saifctl/features/(user)/router/       -> feature: (user)/router  (distinct from above)
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { pathExists } from '../utils/io.js';

/** Canonical feature descriptor. Paths computed once, passed through. */
export interface Feature {
  /** Canonical slug (filesystem/Docker-safe). */
  name: string;
  /** Absolute path to the feature directory. */
  absolutePath: string;
  /** Path relative to project root (e.g. saifctl/features/(auth)/login). */
  relativePath: string;
}

/**
 * True if a directory name is a group (Next.js-style), e.g. "(auth)".
 */
export function isGroupDir(dirName: string): boolean {
  return dirName.startsWith('(') && dirName.endsWith(')');
}

/**
 * Produces a filesystem- and Docker-safe slug from a feature name.
 * Used for sandbox dir names, container names, image tags, and branch names.
 *
 * Replaces `/` with `-` and strips parentheses from group names.
 * Example: (auth)/login → auth-login
 */
export function featureNameToSafeSlug(featureName: string): string {
  return featureName.replace(/[()/]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Recursively scans `${projectDir}/${saifctlDir}/features` for feature directories.
 * Feature ID = relative path from baseDir (e.g. "(auth)/login", "my-feat").
 * First non-parenthesised dir nested within base is the feature dir (path-based only).
 *
 * @param projectDir - Project root
 * @param saifctlDir - Path to saifctl directory (e.g. "saifctl")
 *
 * @returns Map<featureId, absolutePath> where featureId is the relative path
 */
export async function discoverFeatures(
  projectDir: string,
  saifctlDir: string,
): Promise<Map<string, string>> {
  const baseDir = join(projectDir, saifctlDir, 'features');

  const features = new Map<string, string>();

  async function scan(currentPath: string, relativePrefix: string): Promise<void> {
    if (!(await pathExists(currentPath))) return;

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // `_`-prefixed dirs are reserved for documentation / worked examples
      // (e.g. `_phases-example/`). Mirrors the same convention used by phase
      // and critic discovery (see specs/phases/discover.ts).
      if (entry.name.startsWith('_')) continue;

      const fullPath = join(currentPath, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (isGroupDir(entry.name)) {
        await scan(fullPath, relativePath);
      } else {
        features.set(relativePath, fullPath);
      }
    }
  }

  await scan(baseDir, '');
  return features;
}

function findPathBySlug(map: Map<string, string>, slug: string): string | undefined {
  for (const [display, path] of map) {
    if (featureNameToSafeSlug(display) === slug) return path;
  }
  return undefined;
}

/**
 * Resolves user input (display path or slug) to the canonical slug.
 *
 * @throws Error if the feature is not found.
 */
function resolveInputToSlug(input: string, map: Map<string, string>): string {
  if (map.has(input)) return featureNameToSafeSlug(input);
  if (findPathBySlug(map, input)) return input;
  const available = [...map.keys()].sort().join(', ') || '(none)';
  throw new Error(`Feature "${input}" not found. Available: ${available}`);
}

/**
 * Resolves user input to a Feature object. One discovery, all paths computed.
 *
 * @throws Error if the feature is not found.
 */
export async function resolveFeature(opts: {
  input: string;
  projectDir: string;
  saifctlDir: string;
}): Promise<Feature> {
  const { input, projectDir, saifctlDir } = opts;
  const map = await discoverFeatures(projectDir, saifctlDir);
  const slug = resolveInputToSlug(input, map);
  const byDisplay = map.get(input);
  const absolutePath = byDisplay ?? findPathBySlug(map, slug)!;
  const relativePath = relative(projectDir, absolutePath);
  return { name: slug, absolutePath, relativePath };
}
