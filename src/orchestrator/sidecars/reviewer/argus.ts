/**
 * Ensures the Argus binary for Linux (amd64/arm64) is present.
 * Downloads from the fork release on first use; caches under `/tmp/saifctl/bin/` (sibling of `sandboxes/`).
 *
 * We use **musl** builds so the binary has no GLIBC dependency and runs inside any Linux
 * container regardless of libc version. The coder containers are based on Debian Bookworm
 * (GLIBC 2.36), but the gnu builds require GLIBC 2.39+.
 *
 * Cache filenames include the pinned semver so bumping `ARGUS_VERSION` fetches a new
 * build without manual cache cleanup, e.g.:
 *   /tmp/saifctl/bin/argus-linux-amd64-musl-v0.5.6
 *   /tmp/saifctl/bin/argus-linux-arm64-musl-v0.5.6
 *
 * Upstream: https://github.com/Meru143/argus (argus-ai npm package)
 * Fork (managed releases): https://github.com/safe-ai-factory/argus
 *
 * See `vendor/README.md` for the fork release flow.
 */

import { chmod, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { arch } from 'node:os';
import { join } from 'node:path';

import { consola } from '../../../logger.js';
import { pathExists, spawnAsync } from '../../../utils/io.js';
import { SAIFCTL_TEMP_ROOT } from '../../sandbox.js';

/** Host cache dir (not under the repo). Override with `SAIF_REVIEWER_BIN_DIR`. */
const REVIEWER_BIN_DIR =
  process.env.SAIF_REVIEWER_BIN_DIR?.trim() || join(SAIFCTL_TEMP_ROOT, 'bin');

/** Fork release version — bump this when cutting a new fork release. */
const ARGUS_VERSION = '0.5.6';
const REPO = 'safe-ai-factory/argus';

// musl builds have no GLIBC dependency; they run on any Linux regardless of libc version.
const ASSETS: Record<string, string> = {
  x64: 'argus-x86_64-unknown-linux-musl.tar.gz',
  arm64: 'argus-aarch64-unknown-linux-musl.tar.gz',
};

function getBinaryPath(hostArch: 'arm64' | 'x64'): string {
  const suffix = hostArch === 'arm64' ? 'arm64' : 'amd64';
  const binName = `argus-linux-${suffix}-musl-v${ARGUS_VERSION}`;
  return join(REVIEWER_BIN_DIR, binName);
}

const VERSIONED_ARGUS_FILE = /^argus-linux-(amd64|arm64)-musl-v(.+)$/;

/** Drop cached Argus binaries for other versions (same arch families). */
async function pruneStaleArgusBinaries(): Promise<void> {
  let entries;
  try {
    entries = await readdir(REVIEWER_BIN_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(VERSIONED_ARGUS_FILE);
    if (m?.[2] && m[2] !== ARGUS_VERSION) {
      await unlink(join(REVIEWER_BIN_DIR, entry.name)).catch(() => undefined);
    }
  }
}

/**
 * Downloads and extracts the Argus binary for the given architecture.
 * Returns the absolute path to the cached binary.
 *
 * @param hostArch - 'arm64' (Apple Silicon) or 'x64' (Intel/AMD). Docker on macOS uses
 *   the same arch as the host, so we fetch the matching Linux binary.
 */
export async function ensureArgusBinary(hostArch: 'arm64' | 'x64'): Promise<string> {
  const binaryPath = getBinaryPath(hostArch);
  if (await pathExists(binaryPath)) {
    return binaryPath;
  }

  const asset = ASSETS[hostArch];
  if (!asset) {
    throw new Error(`[argus] Unsupported architecture: ${hostArch}. Supported: x64, arm64`);
  }

  await mkdir(REVIEWER_BIN_DIR, { recursive: true });

  const tag = `argus-core-v${ARGUS_VERSION}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
  const tmpTar = join(REVIEWER_BIN_DIR, `tmp-argus-${hostArch}-v${ARGUS_VERSION}.tar.gz`);
  const tmpExtract = join(REVIEWER_BIN_DIR, `tmp-extract-${hostArch}-v${ARGUS_VERSION}`);

  consola.log(`[argus] Downloading v${ARGUS_VERSION} for Linux ${hostArch}...`);
  try {
    await spawnAsync({
      command: 'curl',
      args: ['-sfL', '-o', tmpTar, url],
      cwd: REVIEWER_BIN_DIR,
      stdio: 'inherit',
    });
  } catch {
    throw new Error(
      `[argus] Failed to download binary from ${url}. ` +
        `Check https://github.com/${REPO}/releases for available assets. ` +
        `Or use --no-reviewer to skip the reviewer.`,
    );
  }

  try {
    await mkdir(tmpExtract, { recursive: true });
    await spawnAsync({
      command: 'tar',
      args: ['-xzf', tmpTar, '-C', tmpExtract],
      cwd: REVIEWER_BIN_DIR,
      stdio: 'inherit',
    });

    const extracted = await findArgusBinary(tmpExtract);
    if (!extracted) {
      throw new Error(`Could not find 'argus' binary in archive from ${url}`);
    }

    await spawnAsync({
      command: 'mv',
      args: [extracted, binaryPath],
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    await chmod(binaryPath, 0o755);
    await pruneStaleArgusBinaries();
  } finally {
    await rm(tmpExtract, { recursive: true, force: true });
    await rm(tmpTar, { force: true });
  }

  consola.log(`[argus] Installed to ${binaryPath}`);
  return binaryPath;
}

/**
 * Pings the GitHub Releases endpoint for the pinned Argus binary asset.
 * Network-only check — does not download or cache. Used by `saifctl doctor`
 * to surface a clear failure when the agent host can't reach the release
 * mirror (firewall, proxy, GitHub outage, asset removed, etc.).
 *
 * Returns the asset URL it probed plus the resolved status.
 */
export async function probeArgusReleaseEndpoint(): Promise<{
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
}> {
  const hostArch = arch();
  const targetArch: 'arm64' | 'x64' = hostArch === 'arm64' ? 'arm64' : 'x64';
  const asset = ASSETS[targetArch] ?? ASSETS.x64;
  const tag = `argus-core-v${ARGUS_VERSION}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  try {
    // GitHub release-asset URLs redirect to a signed CDN URL. fetch follows
    // redirects by default; we only need to know the asset is reachable.
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.ok) return { ok: true, url, status: res.status };
    return { ok: false, url, status: res.status };
  } catch (err) {
    return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
  }
}

async function findArgusBinary(dir: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findArgusBinary(full);
      if (found) return found;
    } else if (entry.name === 'argus') {
      return full;
    }
  }
  return null;
}

/**
 * Returns the path to the Argus binary for the current host architecture.
 * Downloads and caches it if not already present.
 */
export async function getArgusBinaryPath(): Promise<string> {
  const hostArch = arch();
  const targetArch = hostArch === 'arm64' ? 'arm64' : 'x64';
  return ensureArgusBinary(targetArch);
}
