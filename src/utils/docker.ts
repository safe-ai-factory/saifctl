/**
 * Docker utility functions shared by the orchestrator.
 * Low-level helpers for container lifecycle, health checks, and log streaming.
 */

import { PassThrough } from 'node:stream';

import Docker from 'dockerode';

export const docker = new Docker();

/**
 * Validates that a Docker image tag string contains only characters that are
 * safe to interpolate into shell commands, preventing injection attacks.
 * Mirrors the same check in scripts/commands/agents.ts at the CLI boundary.
 */
export function assertSafeImageTag(tag: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    throw new Error(
      `[docker] Unsafe image tag rejected: "${tag}". ` +
        `Tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @ signs.`,
    );
  }
}

export interface ContainerHandle {
  id: string;
  name: string;
  container: Docker.Container;
}

/**
 * Pulls a Docker image if it is not already present locally.
 * Wraps the dockerode pull + follow pattern so callers don't have to deal with streams.
 */
export async function pullImage(image: string): Promise<void> {
  console.log(`[docker] Pulling image: ${image}`);
  await new Promise<void>((resolve, reject) => {
    void docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }
      docker.modem.followProgress(stream, (followErr: Error | null) => {
        if (followErr) reject(followErr);
        else resolve();
      });
    });
  });
  console.log(`[docker] Image ready: ${image}`);
}

/**
 * Removes a Docker image by tag. When missingOk is true, errors (e.g. image not
 * found) are swallowed. When missingOk is false, errors are propagated.
 */
export async function removeImageByTag(opts: {
  imageTag: string;
  missingOk: boolean;
}): Promise<void> {
  const { imageTag, missingOk } = opts;
  try {
    console.log(`[docker] Removing image: ${imageTag}`);
    const image = docker.getImage(imageTag);
    await image.remove({ force: true });
    console.log(`[docker] Removed image: ${imageTag}`);
  } catch (err) {
    if (missingOk) {
      // Image not found or already removed — not an error
      console.log(`[docker] Image not found: ${imageTag}`);
      return;
    }
    throw err;
  }
}

/**
 * Creates a Docker network by name. On 409 (already exists), removes the stale
 * network and recreates it. Other errors are propagated.
 */
export async function ensureCreateNetwork(
  name: string,
): Promise<{ networkId: string; networkName: string }> {
  try {
    const network = await docker.createNetwork({ Name: name, Driver: 'bridge' });
    return { networkId: network.id, networkName: name };
  } catch (err: unknown) {
    const isConflict =
      err instanceof Error &&
      (err.message.includes('409') || err.message.includes('already exists'));
    if (!isConflict) throw err;

    console.warn(
      `[docker] Network ${name} already exists (leftover from prior run) — removing and recreating.`,
    );
    await removeNetwork(name);
    const network = await docker.createNetwork({ Name: name, Driver: 'bridge' });
    return { networkId: network.id, networkName: name };
  }
}

/**
 * Removes a Docker network by name. Errors are swallowed with a warning.
 */
export async function removeNetwork(networkName: string): Promise<void> {
  try {
    const networks = await docker.listNetworks({ filters: { name: [networkName] } });
    for (const net of networks) {
      const n = docker.getNetwork(net.Id);
      await n.remove();
    }
  } catch (err) {
    console.warn(`[docker] Warning: could not remove network ${networkName}: ${String(err)}`);
  }
}

/**
 * Stops and removes a list of container handles.
 * Errors are swallowed with a warning to avoid masking the real result.
 */
export async function teardownContainers(handles: ContainerHandle[]): Promise<void> {
  for (const handle of handles) {
    console.log(`[docker] Removing container: ${handle.name} (id: ${handle.id})...`);
    try {
      // force:true stops and removes in one call, even if the container is still running.
      // This is equivalent to `docker rm -f` and avoids a separate stop round-trip
      // that can fail silently and leave the container alive.
      await handle.container.remove({ force: true });
      console.log(`[docker] Removed container: ${handle.name}`);
    } catch (err) {
      console.warn(`[docker] Warning: could not remove ${handle.name}: ${String(err)}`);
    }
  }
}

export interface WaitForContainerReadyOpts {
  containerName: string;
  container: Docker.Container;
  port: number;
  timeoutMs?: number;
}

/**
 * Polls the container's sidecar/health endpoint until it responds or times out.
 */
export async function waitForContainerReady(opts: WaitForContainerReadyOpts): Promise<void> {
  const { containerName, container, port, timeoutMs = 180_000 } = opts;
  // Health check via `node -e "fetch(...)"` — avoids depending on curl which is not
  // present in the node:25 base image. Uses built-in fetch available since Node 18.
  const healthCmd = [
    'node',
    '-e',
    `fetch('http://localhost:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
  ];

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastExitCode = -1;

  console.log(`[docker] Waiting for ${containerName} to be ready on port ${port}...`);

  while (Date.now() < deadline) {
    attempt++;
    try {
      // First check if the container is still running — if it exited, stop waiting
      const info = await container.inspect();
      if (!info.State.Running) {
        console.warn(
          `[docker] ${containerName} exited (code ${info.State.ExitCode ?? '?'}) before becoming ready`,
        );
        return;
      }

      const exec = await container.exec({
        Cmd: healthCmd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((res) => stream.on('end', res));
      const inspect = await exec.inspect();
      lastExitCode = inspect.ExitCode ?? -1;

      if (lastExitCode === 0) {
        console.log(`[docker] ${containerName} is ready (attempt ${attempt})`);
        return;
      }
    } catch (err) {
      console.log(`[docker] Health check error (attempt ${attempt}): ${String(err)}`);
    }
    await sleep(500);
  }

  console.warn(
    `[docker] ${containerName} did not become ready within ${timeoutMs}ms ` +
      `(${attempt} attempts, last exit code: ${lastExitCode})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a container's logs to the terminal with a `[label]` prefix.
 *
 * Uses Docker's modem.demuxStream to write directly to a PassThrough sink that
 * we read line-by-line. This avoids the buffering that occurs when attaching
 * Node.js stream `data` event handlers after an `await` — demuxStream writes
 * synchronously into the sink, so output appears immediately as the container
 * produces it rather than being held until the health-check loop finishes.
 */
export function streamContainerLogs(container: Docker.Container, label: string): () => void {
  let stopped = false;

  void container
    .logs({ follow: true, stdout: true, stderr: true, timestamps: false })
    .then((stream: NodeJS.ReadableStream) => {
      // Use a PassThrough so we get a readable side to scan for newlines while
      // demuxStream writes to it synchronously from the Docker framing layer.
      const out = new PassThrough();
      const err = new PassThrough();

      // demuxStream splits the multiplexed Docker log stream into stdout/stderr
      docker.modem.demuxStream(stream, out, err);

      let buf = '';
      function onChunk(chunk: Buffer | string) {
        if (stopped) return;
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line) process.stdout.write(`[${label}] ${line}\n`);
        }
      }
      function onEnd() {
        if (buf) process.stdout.write(`[${label}] ${buf}\n`);
        buf = '';
      }

      out.on('data', onChunk);
      out.on('end', onEnd);
      err.on('data', onChunk);
      err.on('end', onEnd);
    })
    .catch((e: unknown) => {
      if (!stopped) console.warn(`[docker] Failed to stream logs for ${label}: ${String(e)}`);
    });

  return () => {
    stopped = true;
  };
}

/**
 * Demultiplexes Docker's multiplexed log stream format.
 * Each frame is: [stream_type(1), 0, 0, 0, size(4BE)] + payload
 */
export function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  if (!Buffer.isBuffer(buffer)) {
    return { stdout: String(buffer), stderr: '' };
  }

  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) break;
    const payload = buffer.slice(offset, offset + size).toString('utf8');
    offset += size;

    if (streamType === 1) stdout += payload;
    else if (streamType === 2) stderr += payload;
  }

  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Cleanup registry — tracks live containers/networks for graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Tracks all Docker containers and networks created during a run so that
 * SIGINT/SIGTERM handlers can tear them down even if the mode function is
 * mid-await when the signal fires.
 *
 * Mode functions call `register` immediately after each resource is created.
 * The signal handler calls `cleanup()` which stops/removes everything in
 * reverse order (test runner first, network last).
 */
export class CleanupRegistry {
  private containers: ContainerHandle[] = [];
  private networks: string[] = [];
  private images: string[] = [];

  registerContainers(handles: ContainerHandle[]): void {
    this.containers.push(...handles);
  }

  registerNetwork(name: string): void {
    if (name) this.networks.push(name);
  }

  /** Register an ephemeral Docker image tag to be removed on cleanup. */
  registerImage(tag: string): void {
    if (tag) this.images.push(tag);
  }

  deregisterContainers(handles: ContainerHandle[]): void {
    const ids = new Set(handles.map((h) => h.id));
    this.containers = this.containers.filter((h) => !ids.has(h.id));
  }

  deregisterNetwork(name: string): void {
    this.networks = this.networks.filter((n) => n !== name);
  }

  /** Deregister an image tag (call after the image has already been removed). */
  deregisterImage(tag: string): void {
    this.images = this.images.filter((t) => t !== tag);
  }

  async cleanup(): Promise<void> {
    const containersToStop = [...this.containers];
    const networksToRemove = [...this.networks];
    const imagesToRemove = [...this.images];
    this.containers = [];
    this.networks = [];
    this.images = [];

    if (containersToStop.length > 0 || networksToRemove.length > 0) {
      console.log(
        `[orchestrator] Tearing down ${containersToStop.length} container(s) and ${networksToRemove.length} network(s)...`,
      );
    }

    await teardownContainers(containersToStop);
    for (const net of networksToRemove) {
      await removeNetwork(net);
    }
    for (const tag of imagesToRemove) {
      console.log(`[orchestrator] Removing test image: ${tag}`);
      await removeImageByTag({ imageTag: tag, missingOk: true });
    }
  }
}
