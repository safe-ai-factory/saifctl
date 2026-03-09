import { ensureCreateNetwork } from '../../utils/docker';

export interface CreateNetworkOpts {
  projectName: string;
  changeName: string;
  runId: string;
}

/**
 * Creates a dedicated Docker network for isolating a single verification run.
 *
 * Format: factory-net-{projectName}-{changeName}-{runId}
 * This allows `docker clear` to scope network cleanup by project.
 *
 * How runId is built:
 * - runId = {sandboxSuffix}-r{attempts} (iterative loop: feat:start, feat:continue)
 *   or {sandboxSuffix}-a{attempts} (test mode)
 * - sandboxSuffix comes from the last segment of the sandbox path, e.g. xcc87d8
 *   from /tmp/factory-sandbox/agents-greet-cmd-xcc87d8
 * - attempts is the run counter (1..maxRuns) within a single process
 *
 * On network name conflict, we delete old network and create new one because:
 * - feat:continue starts a fresh process; the first iteration uses attempts=1,
 *   hence runId = xcc87d8-r1. If a prior run crashed or was interrupted before
 *   removeNetwork() in its finally block ran, that network is still present.
 * - The next feat:continue call also uses attempts=1 → same runId → same
 *   network name. Docker.createNetwork() then returns 409 "already exists".
 * - Rather than failing the run, we remove the stale network and recreate it,
 *   so the user can resume without manually cleaning up Docker.
 *
 * Returns the network id and network name.
 */
export async function createSandboxNetwork(
  opts: CreateNetworkOpts,
): Promise<{ networkId: string; networkName: string }> {
  const { projectName, changeName, runId } = opts;
  const networkName = `factory-net-${projectName}-${changeName}-${runId}`;
  return await ensureCreateNetwork(networkName);
}
