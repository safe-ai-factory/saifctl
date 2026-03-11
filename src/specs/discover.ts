/**
 * Recursive discovery of features in saif/features.
 *
 * Supports Next.js-style route groups: directories named (group-name) are
 * traversed. Feature ID = entire relative path from features/.
 *
 * Example:
 *   saif/features/my-feat/              -> feature: my-feat
 *   saif/features/(auth)/login/        -> feature: (auth)/login
 *   saif/features/(auth)/router/       -> feature: (auth)/router
 *   saif/features/(user)/router/       -> feature: (user)/router  (distinct from above)
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Canonical feature descriptor. Paths computed once, passed through. */
export interface Feature {
  /** Canonical slug (filesystem/Docker-safe). */
  name: string;
  /** Absolute path to the feature directory. */
  absolutePath: string;
  /** Path relative to project root (e.g. saif/features/(auth)/login). */
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
 * Recursively scans `${projectDir}/${saifDir}/features` for feature directories.
 * Feature ID = relative path from baseDir (e.g. "(auth)/login", "my-feat").
 * First non-parenthesised dir nested within base is the feature dir (path-based only).
 *
 * @param projectDir - Project root
 * @param saifDir - Path to saif directory (e.g. "saif")
 *
 * @returns Map<featureId, absolutePath> where featureId is the relative path
 */
export function discoverFeatures(projectDir: string, saifDir: string): Map<string, string> {
  const baseDir = join(projectDir, saifDir, 'features');

  const features = new Map<string, string>();

  function scan(currentPath: string, relativePrefix: string): void {
    if (!existsSync(currentPath)) return;

    const entries = readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const fullPath = join(currentPath, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (isGroupDir(entry.name)) {
        scan(fullPath, relativePath);
      } else {
        features.set(relativePath, fullPath);
      }
    }
  }

  scan(baseDir, '');
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
export function resolveFeature(opts: {
  input: string;
  projectDir: string;
  saifDir: string;
}): Feature {
  const { input, projectDir, saifDir } = opts;
  const map = discoverFeatures(projectDir, saifDir);
  const slug = resolveInputToSlug(input, map);
  const byDisplay = map.get(input);
  const absolutePath = byDisplay ?? findPathBySlug(map, slug)!;
  const relativePath = relative(projectDir, absolutePath);
  return { name: slug, absolutePath, relativePath };
}
