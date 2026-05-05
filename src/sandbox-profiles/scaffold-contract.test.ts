/**
 * Cross-profile contract: every `Dockerfile.coder` ships the drop-privileges
 * scaffold (release-readiness/X-08-P2). Without it, agents that refuse to run as root (Claude
 * Code with `--dangerously-skip-permissions`, etc.) hang or fail to start.
 *
 * Adding a new sandbox profile? The scaffold is:
 *
 *   RUN useradd -m -s /bin/bash saifctl \
 *     && mkdir -p /home/saifctl/.npm-global \
 *     && chown -R saifctl:saifctl /home/saifctl
 *   ENV SAIFCTL_UNPRIV_USER=saifctl
 *   ENV SAIFCTL_UNPRIV_NPM_PREFIX=/home/saifctl/.npm-global
 *
 * See src/sandbox-profiles/node-pnpm/Dockerfile.coder for the canonical
 * version with full rationale, and src/agent-profiles/claude/agent.sh for
 * the consumer that requires these env vars.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSaifctlRoot } from '../constants.js';

const PROFILES_DIR = join(getSaifctlRoot(), 'src', 'sandbox-profiles');

async function discoverCoderDockerfiles(): Promise<string[]> {
  const entries = await readdir(PROFILES_DIR);
  const dockerfiles: string[] = [];
  for (const name of entries) {
    const subPath = join(PROFILES_DIR, name);
    const s = await stat(subPath).catch(() => null);
    if (!s?.isDirectory()) continue;
    const dockerfile = join(subPath, 'Dockerfile.coder');
    const ds = await stat(dockerfile).catch(() => null);
    if (ds?.isFile()) dockerfiles.push(dockerfile);
  }
  return dockerfiles;
}

describe('Dockerfile.coder drop-privileges scaffold (release-readiness/X-08-P2)', () => {
  it('every coder Dockerfile pre-creates the saifctl user with the npm-global prefix', async () => {
    const dockerfiles = await discoverCoderDockerfiles();
    expect(dockerfiles.length).toBeGreaterThan(0); // smoke: discovery worked

    const missing: string[] = [];
    for (const path of dockerfiles) {
      const content = await readFile(path, 'utf-8');
      const hasUserCreate = /useradd\s+.*\s+saifctl\b/.test(content);
      const hasNpmPrefixDir = /\/home\/saifctl\/\.npm-global/.test(content);
      const hasUnprivUserEnv = /ENV\s+SAIFCTL_UNPRIV_USER=saifctl/.test(content);
      const hasUnprivPrefixEnv =
        /ENV\s+SAIFCTL_UNPRIV_NPM_PREFIX=\/home\/saifctl\/\.npm-global/.test(content);
      if (!(hasUserCreate && hasNpmPrefixDir && hasUnprivUserEnv && hasUnprivPrefixEnv)) {
        missing.push(path);
      }
    }
    // Print which file failed for fast triage; assert empty so the failure
    // message lists every offender at once instead of bailing on the first.
    expect(
      missing,
      `Dockerfiles missing the drop-privileges scaffold:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
