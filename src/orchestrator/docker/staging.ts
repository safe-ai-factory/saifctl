/**
 * Staging container (Container A) — the application under test.
 *
 * Builds an ephemeral image with the runtime (node, pnpm, etc.) only — no code
 * baked in. At runtime, the workspace is mounted and startup.sh installs deps
 * (same script as the coder container). Then the sidecar and stage.sh run the app.
 * The sidecar HTTP server runs in every container so the test runner can execute
 * commands via HTTP.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestCatalog } from '../../design-tests/schema.js';
import {
  resolveSandboxStageDockerfilePath,
  type SupportedSandboxProfileId,
} from '../../sandbox-profiles/index.js';
import { createTarArchive } from '../../utils/archive.js';
import {
  type ContainerHandle,
  docker,
  pullImage,
  streamContainerLogs,
  teardownContainers,
  waitForContainerReady,
} from '../../utils/docker.js';

export const DEFAULT_STAGING_IMAGE = 'factory-stage:latest';

// Read the staging startup script from disk (co-located with this file in the build output).
const STAGING_START_SCRIPT = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/staging-start.sh'),
  'utf8',
);
const SIDECAR_BINARY = loadSidecarBinary();

export interface StartStagingContainerOpts {
  /** Sandbox profile id — used to resolve the default Dockerfile.stage when build.dockerfile is not set. */
  sandboxProfileId: SupportedSandboxProfileId;
  /** Absolute path to the code directory inside the sandbox */
  codePath: string;
  /** Absolute path to the project directory (used to resolve build.dockerfile) */
  projectDir: string;
  changeName: string;
  /**
   * Project name (from package.json "name" or --project flag).
   * Embedded in container/image names so they can be scoped per project
   * when running `docker clear` without --all.
   */
  projectName: string;
  catalog: TestCatalog;
  /** Docker network name to join */
  networkName: string;
  /** Unique run id used to name containers */
  runId: string;
  /**
   * Absolute path to the startup script on the host (sandboxBasePath/startup.sh).
   * Mounted read-only at /factory/startup.sh inside the staging container.
   * staging-start.sh runs it once (before starting the sidecar) to install
   * workspace dependencies — the same script the coder container runs.
   */
  startupPath: string;
  /**
   * Absolute path to the staging script on the host (sandboxBasePath/stage.sh).
   * Mounted read-only at /factory/stage.sh and invoked by staging-start.sh after
   * the installation script and the sidecar have run. Set via --profile or --stage-script.
   */
  stagePath: string;
  /**
   * Called immediately after the container starts, before the health-wait.
   * Use to register the handle with a CleanupRegistry so SIGINT during
   * the (potentially long) health-wait still tears down the container.
   */
  onStarted?: (handle: ContainerHandle) => void;
}

interface BuildStagingImageOpts {
  /** Sandbox profile id — used to resolve the default Dockerfile.stage when dockerfile is not set. */
  sandboxProfileId: SupportedSandboxProfileId;
  /** Absolute path to the sandbox code directory (build context). */
  codePath: string;
  /** Absolute path to the project directory (used to resolve custom Dockerfiles). */
  projectDir: string;
  /** Path to a custom Dockerfile relative to projectDir, or null/undefined to use the profile's Dockerfile.stage. */
  dockerfile?: string | null;
  /** Docker image tag to apply (e.g. 'factory-stage-img-abc123'). */
  imageTag: string;
}

/**
 * Builds an ephemeral Docker image that provides the runtime (e.g. node, pnpm) only.
 * Uses the sandbox profile's Dockerfile.stage (or a custom build.dockerfile). The build context
 * is the sandbox's code directory, but the default Dockerfile.stage does not COPY code
 * — dependencies are installed at container start via startup.sh.
 *
 * The image is tagged `factory-stage-img-{runId}` and cleaned up after each run.
 */
async function buildStagingImage(opts: BuildStagingImageOpts): Promise<void> {
  const { sandboxProfileId, codePath, projectDir, dockerfile, imageTag } = opts;
  let dockerfilePath: string;

  if (dockerfile) {
    // Custom Dockerfile specified in tests.json
    dockerfilePath = resolve(projectDir, dockerfile);
    if (!existsSync(dockerfilePath)) {
      throw new Error(
        `[docker] tests.json specifies build.dockerfile "${dockerfile}" but the file was not found at ${dockerfilePath}`,
      );
    }
    console.log(`[docker] Using custom Dockerfile: ${dockerfilePath}`);
  } else {
    // Use the sandbox profile's Dockerfile.stage
    dockerfilePath = resolveSandboxStageDockerfilePath(sandboxProfileId);
    if (!existsSync(dockerfilePath)) {
      throw new Error(
        `[docker] Profile "${sandboxProfileId}" requires Dockerfile.stage at ${dockerfilePath} but it is missing. ` +
          `Each sandbox profile must provide both Dockerfile.coder and Dockerfile.stage.`,
      );
    }
    console.log(`[docker] Using profile ${sandboxProfileId} Dockerfile.stage`);
  }

  // Exclude node_modules and other artifacts from the build context.
  // Custom Dockerfiles may COPY from context; keeping it clean avoids surprises.
  const dockerignorePath = join(codePath, '.dockerignore');
  writeFileSync(
    dockerignorePath,
    ['node_modules', '.git', '*.log', 'dist', 'build', '.cache'].join('\n') + '\n',
    'utf8',
  );

  console.log(`[docker] Building staging container image: ${imageTag}`);
  console.log(`[docker]   Context: ${codePath}`);
  execSync(`docker build -f "${dockerfilePath}" -t "${imageTag}" "${codePath}"`, {
    stdio: 'inherit',
  });
  console.log(`[docker] Staging container image built: ${imageTag}`);
}

/**
 * Starts Container A — the application under test.
 *
 * The workspace (codePath) is mounted into the container. Execution order:
 * 1. startup.sh (mounted at /factory/startup.sh) installs deps — same script as coder.
 * 2. staging-start.sh starts the sidecar in the background.
 * 3. stage.sh (profile's stage script) starts the app (e.g. pnpm run start) or keeps the container alive (wait).
 *
 * Uses `docker build` to create a runtime-only image (node, pnpm, etc.); code is
 * mounted at start, not baked in. Uses the sandbox profile's Dockerfile.stage; override
 * via `containers.staging.build.dockerfile` in tests.json for other sandboxes.
 */
export async function startStagingContainer(
  opts: StartStagingContainerOpts,
): Promise<ContainerHandle> {
  const {
    codePath,
    projectDir,
    changeName,
    projectName,
    catalog,
    networkName,
    runId,
    startupPath,
    stagePath,
    onStarted,
  } = opts;
  const containerConfig = catalog.containers.staging;
  const containerName = `factory-stage-${projectName}-${changeName}-${runId}`;

  // ── Build the ephemeral staging image ────────────────────────────────────
  // No `build` key or no `dockerfile`: use the sandbox profile's Dockerfile.stage.
  // `build.dockerfile: "path"`: use a custom Dockerfile for non-Node sandboxes.
  const imageTag = `factory-stage-${projectName}-${changeName}-img-${runId}`;
  await buildStagingImage({
    sandboxProfileId: opts.sandboxProfileId,
    codePath,
    projectDir,
    dockerfile: containerConfig.build?.dockerfile,
    imageTag,
  });

  console.log(`[docker] Starting staging container: ${containerName}`);
  console.log(`[docker] Staging container image: ${imageTag}`);

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName,
    // staging-start.sh is injected into /factory via putArchive and invoked directly.
    // /bin/sh is used for compatibility with both Debian and Alpine base images.
    Cmd: ['/bin/sh', '/factory/staging-start.sh'],
    HostConfig: {
      NetworkMode: networkName,
      Binds: [
        `${codePath}:/workspace`,
        `${startupPath}:/factory/startup.sh:ro`,
        `${stagePath}:/factory/stage.sh:ro`,
      ],
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
    },
    // Add "staging" as a network alias so the test runner can reach this container
    // by a stable, short hostname regardless of the full container name (which
    // includes runId). Each run has its own bridge network so the alias is unique.
    // E.g. "staging:8080/exec" → "http://staging:8080/exec".
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: { Aliases: ['staging'] },
      },
    },
    Env: [
      `FACTORY_CHANGE_NAME=${changeName}`,
      `FACTORY_SIDECAR_PORT=${containerConfig.sidecarPort}`,
      `FACTORY_SIDECAR_PATH=${containerConfig.sidecarPath}`,
      `FACTORY_STARTUP_SCRIPT=/factory/startup.sh`,
      `FACTORY_STAGE_SCRIPT=/factory/stage.sh`,
    ],
    WorkingDir: '/workspace',
  });

  // Inject only the sidecar binary and staging-start.sh via putArchive. Both must be
  // executable:
  // - sidecar is a compiled binary invoked directly
  // - staging-start.sh is the container entrypoint (Cmd).
  //
  // Bind mounts can lose executable bits across host/container boundaries,
  // so we inject via tar with mode 0000755. Other .sh scripts are only mounted because
  // they are invoked via `sh /factory/stage.sh`, so they need not be +x.
  const tarBuffer = createTarArchive([
    { filename: 'sidecar', content: SIDECAR_BINARY, mode: '0000755' },
    { filename: 'staging-start.sh', content: STAGING_START_SCRIPT, mode: '0000755' },
  ]);
  await container.putArchive(tarBuffer, { path: '/factory' });

  await container.start();
  console.log(`[docker] ${containerName} started`);
  streamContainerLogs(container, containerName);

  const handle: ContainerHandle = { id: container.id, name: containerName, container };
  onStarted?.(handle);

  // Always wait for the sidecar to become ready — it is started in every container.
  await waitForContainerReady({
    containerName,
    container,
    port: containerConfig.sidecarPort,
  });

  return handle;
}

/**
 * Debug mode: spins up the staging container (+ any ephemeral containers) and
 * streams its logs to the terminal until the process receives SIGINT (Ctrl+C).
 *
 * Useful for diagnosing startup failures — you see exactly what the installation
 * script, the sidecar, or the web server prints before the test runner ever connects.
 *
 * Cleans up containers and network on exit.
 */
export async function debugStagingContainer(opts: StartStagingContainerOpts): Promise<void> {
  const { changeName, catalog, networkName } = opts;
  const handles: ContainerHandle[] = [];

  const runId = opts.runId;

  console.log(`\n[debug] Starting staging container for "${changeName}" (Ctrl+C to stop)\n`);

  try {
    const additionalContainers = await startAdditionalContainers({
      additionalContainers: catalog.containers.additional,
      networkName,
      runId,
    });
    handles.push(...additionalContainers);

    const stagingContainerHandle = await startStagingContainer(opts);
    handles.push(stagingContainerHandle);

    // Block until SIGINT
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        console.log('\n[debug] SIGINT received — tearing down...');
        resolve();
      });
    });
  } finally {
    await teardownContainers(handles);
  }
}

export interface StartAdditionalContainersOpts {
  additionalContainers: TestCatalog['containers']['additional'];
  networkName: string;
  runId: string;
}

/**
 * Starts ephemeral containers from tests.json containers.additional.
 * Returns handles so they can be torn down later.
 */
export async function startAdditionalContainers(
  opts: StartAdditionalContainersOpts,
): Promise<ContainerHandle[]> {
  const { additionalContainers, networkName, runId } = opts;
  const handles: ContainerHandle[] = [];

  for (const spec of additionalContainers) {
    const name = `factory-${spec.name}-${runId}`;
    console.log(`[docker] Starting additional container: ${name} (${spec.image})`);

    await pullImage(spec.image);

    const container = await docker.createContainer({
      Image: spec.image,
      name,
      HostConfig: {
        NetworkMode: networkName,
        SecurityOpt: ['no-new-privileges'],
      },
      // Add spec.name as network alias so other containers can reach via hostname (e.g. postgres)
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: { Aliases: [spec.name] },
        },
      },
    });
    await container.start();
    handles.push({ id: container.id, name, container });
    console.log(`[docker] ${name} started`);
    streamContainerLogs(container, name);
  }

  return handles;
}

/**
 * Reads the pre-compiled Go sidecar binary for the current host architecture.
 *
 * The binary is a statically-linked Linux executable, so it runs in any Linux
 * container regardless of the installed language runtime (Node.js, Python, Go,
 * Rust, etc.). Two variants are shipped:
 *   out/sidecar-linux-amd64  — for x86_64 hosts / cloud VMs
 *   out/sidecar-linux-arm64  — for Apple Silicon (M-series) / AWS Graviton
 *
 * Because Docker on macOS runs containers inside a Linux VM that matches the
 * host CPU architecture, os.arch() reliably selects the right binary.
 */
function loadSidecarBinary(): Buffer {
  const hostArch = arch(); // 'arm64' on Apple Silicon, 'x64' on Intel/AMD
  const binaryName = hostArch === 'arm64' ? 'sidecar-linux-arm64' : 'sidecar-linux-amd64';
  const binaryPath = resolve(dirname(fileURLToPath(import.meta.url)), '../sidecar/out', binaryName);

  if (!existsSync(binaryPath)) {
    throw new Error(
      `[sidecar] Pre-compiled sidecar binary not found at ${binaryPath}. ` +
        `Run: cd src/orchestrator/sidecar && ` +
        `GOOS=linux GOARCH=${hostArch === 'arm64' ? 'arm64' : 'amd64'} CGO_ENABLED=0 go build -o out/${binaryName} .`,
    );
  }

  return readFileSync(binaryPath);
}

interface StagingImageTagOpts {
  projectName: string;
  changeName: string;
  runId: string;
}

/**
 * Returns the ephemeral staging image tag for the current run.
 *
 * Format: factory-stage-{projectName}-{changeName}-img-{runId}
 * This allows `docker clear` to scope cleanup by project or remove all.
 */
export function getStagingImageTag(catalog: TestCatalog, opts: StagingImageTagOpts): string | null {
  const build = (catalog.containers.staging as { build?: { dockerfile?: string | null } }).build;
  if (build?.dockerfile === null) return null;
  const { projectName, changeName, runId } = opts;
  return `factory-stage-${projectName}-${changeName}-img-${runId}`;
}
