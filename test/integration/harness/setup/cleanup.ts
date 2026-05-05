/**
 * Belt-and-braces container cleanup for integration scenarios.
 *
 * The orchestrator's own CleanupRegistry (src/utils/cleanup.ts) handles the
 * happy path and SIGINT. This module catches the *unhappy* path: vitest test
 * timeout, unhandled rejection, or a bug in the orchestrator that leaks a
 * container. It runs `docker rm -f` on any container whose name matches the
 * harness's container naming.
 *
 * Container shapes the harness produces (per src/engines/docker/index.ts):
 *   leash-target-{workspaceId}              — coder target (Leash workspace)
 *   leash-target-{workspaceId}-leash        — Leash manager (suffix `-leash`)
 *   saifctl-stage-{projectName}-{feat}-{id} — staging container
 *   saifctl-test-{projectName}-{id}         — test runner container
 *
 * `workspaceId` derives from the last two path segments of the sandbox base
 * path, lowercased and truncated to 40 chars (`leashWorkspaceId`). With the
 * harness's project name `saifctl-integ-fixture` and a 7-char runId, the
 * marker `saifctl-integ-fixture` is always preserved through truncation.
 *
 * Match strategy: prefix + marker. Avoids the prior substring-only check,
 * which would also remove unrelated containers a developer happens to have
 * running with the marker in their name.
 */
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Docker from 'dockerode';

const docker = new Docker();

/** Project-name marker that appears in every harness container name. */
const HARNESS_PROJECT_MARKER = 'saifctl-integ-fixture';

/** Known harness container prefixes — matches the four shapes documented above. */
const HARNESS_CONTAINER_PREFIXES = ['leash-target-', 'saifctl-stage-', 'saifctl-test-'] as const;

function isHarnessContainerName(name: string): boolean {
  if (!HARNESS_CONTAINER_PREFIXES.some((p) => name.startsWith(p))) return false;
  return name.includes(HARNESS_PROJECT_MARKER);
}

export async function pruneStrayHarnessContainers(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  let containers: Docker.ContainerInfo[];
  try {
    containers = await docker.listContainers({ all: true });
  } catch {
    return { removed };
  }

  for (const info of containers) {
    const name = info.Names[0]?.replace(/^\//, '') ?? '';
    if (!isHarnessContainerName(name)) continue;
    try {
      await docker.getContainer(info.Id).remove({ force: true });
      removed.push(name);
    } catch {
      // Container may have died between listContainers and remove — ignore.
    }
  }
  return { removed };
}

/** Resolved real path of `tmpdir()` cached at module load — `realpath` may differ from `tmpdir()` on macOS where `/tmp` symlinks to `/private/tmp`. */
const TMPDIR_REAL = resolveSafe(tmpdir());

function resolveSafe(p: string): string {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

/**
 * Belt-and-braces guard against accidentally removing a non-tmp directory.
 * Two checks must both hold:
 *
 *   1. `projectDir` resolves to a path under the OS tmp root (`os.tmpdir()`).
 *   2. The basename starts with the harness `mkdtemp` prefix (`saifctl-integ-`).
 *
 * Either check alone is bypassable. Together they make the only paths this
 * function will remove the ones the harness itself created.
 */
export async function removeTmpProject(projectDir: string): Promise<void> {
  const resolved = resolveSafe(projectDir);
  if (!resolved.startsWith(TMPDIR_REAL)) return;
  try {
    const s = await stat(resolved);
    if (!s.isDirectory()) return;
  } catch {
    return;
  }
  // Final basename check — harness paths always come from `mkdtemp(.../saifctl-integ-)`.
  const base = resolved.split('/').filter(Boolean).pop() ?? '';
  if (!base.startsWith('saifctl-integ-')) return;
  await rm(resolved, { recursive: true, force: true });
}
