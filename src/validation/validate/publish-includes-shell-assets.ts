/**
 * Ensures packaged runtime assets are listed in the npm publish file list (via
 * `npm pack --dry-run`, matching package.json "files"):
 * - every .sh under runtime-used trees
 * - explicit Cedar policy files used by the CLI default / docs
 */

import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getSaifRoot } from '../../constants.js';

/** Cedar policies that must ship with the package (keep in sync with package.json "files"). */
const REQUIRED_CEDAR_PATHS = [
  'src/orchestrator/policies/leash-policy.cedar',
  'src/orchestrator/policies/leash-policy.deny-network.cedar',
] as const;

/** Directories (relative to package root) whose .sh files must ship in the tarball. */
const SH_ASSET_ROOTS = [
  'src/orchestrator/scripts',
  'src/sandbox-profiles',
  'src/agent-profiles',
  'src/test-profiles',
] as const;

async function collectShRelativePaths(
  packageRoot: string,
  relRoot: (typeof SH_ASSET_ROOTS)[number],
): Promise<string[]> {
  const baseAbs = join(packageRoot, relRoot);
  const out: string[] = [];

  async function walk(currentAbs: string, relSuffix: string): Promise<void> {
    const entries = await readdir(currentAbs, { withFileTypes: true });
    for (const e of entries) {
      const nextRel = relSuffix ? `${relSuffix}/${e.name}` : e.name;
      const nextAbs = join(currentAbs, e.name);
      if (e.isDirectory()) {
        await walk(nextAbs, nextRel);
      } else if (e.name.endsWith('.sh')) {
        out.push(`${relRoot}/${nextRel}`.replace(/\\/g, '/'));
      }
    }
  }

  await walk(baseAbs, '');
  return out;
}

function listNpmPackPaths(packageRoot: string): Set<string> {
  const r = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm prints the file list on stderr; stdout is often empty.
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.includes('Tarball Contents'));
  const end = lines.findIndex((l) => l.includes('Tarball Details'));
  const slice = start >= 0 && end > start ? lines.slice(start + 1, end) : lines;
  const paths = new Set<string>();
  const re = /^npm notice [\d.]+\S*\s+(.+)$/;
  for (const line of slice) {
    const m = line.match(re);
    if (m) {
      paths.add(m[1].trim());
    }
  }
  return paths;
}

export default async function (): Promise<void> {
  const root = getSaifRoot();
  const packed = listNpmPackPaths(root);
  const requiredSh: string[] = [];
  for (const sub of SH_ASSET_ROOTS) {
    requiredSh.push(...(await collectShRelativePaths(root, sub)));
  }

  const missingSh = requiredSh.filter((p) => !packed.has(p)).sort();

  const missingCedar: string[] = [];
  const missingCedarOnDisk: string[] = [];
  for (const p of REQUIRED_CEDAR_PATHS) {
    try {
      await access(join(root, p));
    } catch {
      missingCedarOnDisk.push(p);
      continue;
    }
    if (!packed.has(p)) missingCedar.push(p);
  }

  const parts: string[] = [];
  if (missingSh.length > 0) {
    parts.push(
      'These .sh files exist in the repo but are not in the npm pack output. ' +
        'Expand package.json "files" (or fix .npmignore) so they ship:\n' +
        missingSh.map((p) => `  - ${p}`).join('\n'),
    );
  }
  if (missingCedarOnDisk.length > 0) {
    parts.push(
      'These Cedar policy paths are required by validation but missing on disk:\n' +
        missingCedarOnDisk.map((p) => `  - ${p}`).join('\n'),
    );
  }
  if (missingCedar.length > 0) {
    parts.push(
      'These Cedar policy files are not in the npm pack output. Add them to package.json "files":\n' +
        missingCedar.map((p) => `  - ${p}`).join('\n'),
    );
  }

  if (parts.length > 0) {
    throw new Error(parts.join('\n\n'));
  }
}
