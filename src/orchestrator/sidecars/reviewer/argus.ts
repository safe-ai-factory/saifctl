/**
 * Ensures the Argus binary for Linux (amd64/arm64) is present.
 * Fetches from GitHub releases when missing. Used before mounting into the coder container.
 *
 * Binaries are stored at src/orchestrator/argus/out/argus-linux-{arch}.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';

import { getSaifRoot } from '../../../constants.js';

const ARGUS_VERSION = '0.5.2';
/** GitHub release tag. Argus uses argus-review-vX.Y.Z for the review CLI. */
const RELEASE_TAG = `argus-review-v${ARGUS_VERSION}`;
const REPO = 'Meru143/argus';

const ASSETS: Record<string, string> = {
  x64: 'argus-x86_64-unknown-linux-gnu.tar.gz',
  arm64: 'argus-aarch64-unknown-linux-gnu.tar.gz',
};

function getOutDir(): string {
  return join(getSaifRoot(), 'src', 'orchestrator', 'sidecars', 'reviewer', 'out');
}

function getBinaryPath(hostArch: 'arm64' | 'x64'): string {
  const binName = hostArch === 'arm64' ? 'argus-linux-arm64' : 'argus-linux-amd64';
  return join(getOutDir(), binName);
}

/**
 * Downloads and extracts the Argus binary for the given architecture.
 * Returns the absolute path to the binary.
 *
 * @param hostArch - 'arm64' (Apple Silicon) or 'x64' (Intel/AMD). Docker on macOS uses
 *   the same arch as the host, so we fetch the matching Linux binary.
 */
export function ensureArgusBinary(hostArch: 'arm64' | 'x64'): string {
  const binaryPath = getBinaryPath(hostArch);
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  const asset = ASSETS[hostArch];
  if (!asset) {
    throw new Error(`Unsupported architecture: ${hostArch}. Supported: x64, arm64`);
  }

  const outDir = getOutDir();
  mkdirSync(outDir, { recursive: true });

  const url = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${asset}`;
  const tmpTar = join(outDir, `tmp-argus-${hostArch}.tar.gz`);

  console.log(`[argus] Downloading v${ARGUS_VERSION} for Linux ${hostArch}...`);
  try {
    execSync(`curl -sfL -o "${tmpTar}" "${url}"`, { stdio: 'inherit' });
  } catch {
    throw new Error(
      `[argus] Failed to download binary from ${url}. ` +
        `See https://github.com/Meru143/argus for build-from-source instructions. ` +
        `Or use --no-reviewer to skip the reviewer.`,
    );
  }

  // Extract the 'argus' binary from the tarball. The archive contains a single file named 'argus'.
  const tmpExtract = join(outDir, `tmp-extract-${hostArch}`);
  mkdirSync(tmpExtract, { recursive: true });
  execSync(`tar -xzf "${tmpTar}" -C "${tmpExtract}"`, { stdio: 'inherit' });

  // Find the binary (could be at root or in a subdir)
  const extracted = findArgusBinary(tmpExtract);
  if (!extracted) {
    execSync(`rm -rf "${tmpExtract}" "${tmpTar}"`);
    throw new Error(`Could not find argus binary in archive from ${url}`);
  }

  execSync(`mv "${extracted}" "${binaryPath}"`);
  execSync(`chmod +x "${binaryPath}"`);
  execSync(`rm -rf "${tmpExtract}" "${tmpTar}"`);

  console.log(`[argus] Installed to ${binaryPath}`);
  return binaryPath;
}

function findArgusBinary(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findArgusBinary(full);
      if (found) return found;
    } else if (entry.name === 'argus') {
      return full;
    }
  }
  return null;
}

/**
 * Returns the path to the Argus binary for the current host architecture.
 * Ensures it exists (downloads if missing).
 */
export function getArgusBinaryPath(): string {
  const hostArch = arch();
  const targetArch = hostArch === 'arm64' ? 'arm64' : 'x64';
  return ensureArgusBinary(targetArch);
}
