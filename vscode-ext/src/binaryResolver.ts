/**
 * Resolves how to invoke `saifctl`: user override, local node_modules, or PATH.
 */

import { access, constants, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCAN_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.saifctl',
]);

/** Optional hooks for verbose / trace logging during resolution (no-op if omitted). */
export type ResolverLog = {
  trace?: (msg: string) => void;
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
};

function localBinCandidates(dir: string): string[] {
  const base = join(dir, 'node_modules', '.bin', 'saifctl');
  if (process.platform === 'win32') {
    return [`${base}.cmd`, `${base}.ps1`, base];
  }
  return [base];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findLocalBinary(startDir: string, log?: ResolverLog): Promise<string | null> {
  let current = startDir;
  while (true) {
    log?.trace?.(`findLocalBinary: directory ${current}`);
    for (const candidate of localBinCandidates(current)) {
      log?.trace?.(`findLocalBinary: try ${candidate}`);
      if (await pathExists(candidate)) {
        log?.debug?.(`findLocalBinary: found ${candidate}`);
        return candidate;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function detectPackageManager(dir: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  let current = dir;
  while (true) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      entries = [];
    }
    if (entries.includes('pnpm-lock.yaml')) return 'pnpm';
    if (entries.includes('yarn.lock')) return 'yarn';
    if (entries.includes('package-lock.json') || entries.includes('npm-shrinkwrap.json')) {
      return 'npm';
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 'npm';
}

/**
 * Scans all given workspace folder roots for directories that contain a `saifctl/`
 * subdirectory (i.e. saifctl project roots), then returns the first one that has a
 * locally-installed saifctl binary reachable by walking up from that dir.
 *
 * Falls back to the first workspace folder if none has a local bin (PATH resolution
 * still works for global installs).
 */
export async function findBestInstallCwd(
  workspaceFolderPaths: string[],
  log?: ResolverLog,
): Promise<string> {
  if (workspaceFolderPaths.length === 0) return process.cwd();

  log?.debug?.(
    `findBestInstallCwd: workspace folder(s) (${workspaceFolderPaths.length}): ${workspaceFolderPaths.join(', ')}`,
  );

  const projectRoots: string[] = [];

  const scan = async (dir: string): Promise<void> => {
    log?.trace?.(`findBestInstallCwd scan: ${dir}`);
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as {
        name: string;
        isDirectory: () => boolean;
      }[];
    } catch {
      return;
    }
    let foundSaifctlDir = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'saifctl') {
        if (!foundSaifctlDir) {
          projectRoots.push(dir);
          log?.debug?.(`findBestInstallCwd: saifctl project root ${dir}`);
          foundSaifctlDir = true;
        }
        continue;
      }
      if (!entry.name.startsWith('.') && !SCAN_IGNORE.has(entry.name)) {
        await scan(join(dir, entry.name));
      }
    }
  };

  for (const root of workspaceFolderPaths) {
    log?.trace?.(`findBestInstallCwd: scanning workspace root ${root}`);
    await scan(root);
  }

  log?.debug?.(
    `findBestInstallCwd: discovered ${projectRoots.length} project root(s) with saifctl/: ${projectRoots.join(', ') || '(none)'}`,
  );

  for (const projectRoot of projectRoots) {
    const bin = await findLocalBinary(projectRoot, log);
    if (bin) {
      log?.debug?.(`findBestInstallCwd: using install cwd ${projectRoot} (local bin: ${bin})`);
      return projectRoot;
    }
    log?.debug?.(`findBestInstallCwd: no local bin walking up from ${projectRoot}`);
  }

  const fallback = workspaceFolderPaths[0];
  log?.info?.(
    `findBestInstallCwd: no local saifctl in any project root; falling back to first workspace folder: ${fallback}`,
  );
  return fallback;
}

export type ResolveCliInvocationOptions = {
  cwd: string;
  userBinaryPath: string;
  log?: ResolverLog;
};

/**
 * Resolve the path to the `saifctl` binary.
 *
 * The resolution is cached per `cwd`. The extension clears the cache when:
 * - `saifctl.binaryPath` changes,
 * - a `saifctl/` directory is created or removed under the workspace, or
 * - `node_modules/.bin/saifctl*` changes (install/uninstall).
 *
 * Order of resolution:
 * 1. User override (settings)
 * 2. Local node_modules (upward walk)
 * 3. Plain `saifctl` (assumes `saifctl` is on the PATH)
 */
export async function resolveCliInvocation(opts: ResolveCliInvocationOptions): Promise<string> {
  const { cwd, userBinaryPath, log } = opts;
  const trimmed = typeof userBinaryPath === 'string' ? userBinaryPath.trim() : '';
  if (trimmed) {
    log?.debug?.(
      `resolveCliInvocation: using user binaryPath override: ${JSON.stringify(trimmed)}`,
    );
    return trimmed;
  }

  log?.debug?.(`resolveCliInvocation: walking up from cwd ${cwd} for node_modules/.bin/saifctl`);
  const localBin = await findLocalBinary(cwd, log);
  if (localBin) {
    const pm = await detectPackageManager(cwd);
    if (pm === 'pnpm') return 'pnpm exec saifctl';
    if (pm === 'yarn') return 'yarn saifctl';
    return localBin;
  }

  return 'saifctl';
}
