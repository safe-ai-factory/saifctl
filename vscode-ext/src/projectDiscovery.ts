/**
 * Discover directories that contain a `saifctl/` folder (SaifCTL project roots).
 * Same rules as the Features tree: recursive walk from workspace root, skip noisy dirs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SaifctlProject {
  /** Display label: basename of workspace root, or path relative to workspace root */
  name: string;
  /** Absolute path to the project directory (parent of `saifctl/`) */
  projectPath: string;
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.saifctl',
]);

/**
 * A real saifctl/ config directory contains a `features/` subdirectory.
 * This distinguishes it from npm packages (e.g. tombstone packages) that happen
 * to be named `saifctl` and live alongside project code.
 */
async function isSaifctlConfigDir(saifctlPath: string): Promise<boolean> {
  try {
    const inner = await fs.promises.readdir(saifctlPath, { withFileTypes: true });
    return inner.some((e) => e.isDirectory() && e.name === 'features');
  } catch {
    return false;
  }
}

/**
 * Returns all SaifCTL project roots under `workspaceRoot`, sorted by `name`.
 */
export async function discoverSaifctlProjects(workspaceRoot: string): Promise<SaifctlProject[]> {
  const projects: SaifctlProject[] = [];

  const search = async (currentDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    let isProjectRoot = false;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (entry.name === 'saifctl') {
        if (!isProjectRoot && (await isSaifctlConfigDir(path.join(currentDir, 'saifctl')))) {
          const name =
            currentDir === workspaceRoot
              ? path.basename(currentDir) || 'Workspace'
              : path.relative(workspaceRoot, currentDir) || path.basename(workspaceRoot);

          projects.push({ name, projectPath: currentDir });
          isProjectRoot = true;
        }
        continue;
      }

      if (!entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name)) {
        await search(path.join(currentDir, entry.name));
      }
    }
  };

  await search(workspaceRoot);
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

/**
 * Discover SaifCTL projects under each workspace root path (multi-root), deduped by absolute path.
 */
export async function discoverSaifctlProjectsInWorkspaceRoots(
  workspaceFolderPaths: readonly string[],
): Promise<SaifctlProject[]> {
  const byPath = new Map<string, SaifctlProject>();
  for (const root of workspaceFolderPaths) {
    const found = await discoverSaifctlProjects(root);
    for (const p of found) {
      byPath.set(p.projectPath, p);
    }
  }
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}
