/**
 * DockerProvisioner — the single Docker-aware implementation of the Provisioner interface.
 *
 * Encapsulates all Docker API calls, `docker compose` CLI invocations, log demuxing,
 * sidecar injection, and the Leash network attachment workaround.
 * The orchestrator (loop.ts, modes.ts) never imports dockerode or child_process for Docker purposes
 * (Docker CLI here uses `spawnAsync`/`spawnWait`; the Leash agent still uses `spawn` for streaming I/O).
 *
 * Lifecycle per run:
 *   setup()        → create bridge network + `docker compose up`
 *   startStaging() → docker build + createContainer + putArchive + start + health-wait
 *   runTests()     → createContainer + start + wait + demux logs + parse JUnit XML
 *   runAgent()     → spawn Leash CLI + Leash network-attach workaround
 *   teardown()     → containers + images + compose down + network
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import Docker from 'dockerode';

import type { DockerEnvironment } from '../../config/schema.js';
import { getSaifRoot, saifacTaskFilePath } from '../../constants.js';
import { consola } from '../../logger.js';
import {
  resolveSandboxCoderDockerfilePath,
  type SupportedSandboxProfileId,
} from '../../sandbox-profiles/index.js';
import type { Feature } from '../../specs/discover.js';
import { createTarArchive } from '../../utils/archive.js';
import {
  pathExists,
  readFileBuffer,
  readUtf8,
  spawnAsync,
  spawnWait,
  writeUtf8,
} from '../../utils/io.js';
import type {
  AgentResult,
  Provisioner,
  ProvisionerSetupOpts,
  ProvisionerTeardownOpts,
  RunAgentOpts,
  RunTestsOpts,
  StagingHandle,
  StartStagingOpts,
  TestsResult,
} from '../types.js';
import { detectRunnerError, parseJUnitXmlFromFile } from '../utils/test-parser.js';
import { filterAgentEnv, printOpenHandsSegment } from './agent-log.js';
import { resolveLeashCliPath } from './resolve-leash-cli.js';

// ---------------------------------------------------------------------------
// Docker client singleton
// ---------------------------------------------------------------------------

const docker = new Docker();

// ---------------------------------------------------------------------------
// runDocker — async spawn wrapper (no shell, avoids injection)
// ---------------------------------------------------------------------------

interface RunDockerOptions {
  /** 'inherit' streams output to parent; 'pipe' captures stdout/stderr */
  stdio?: 'inherit' | 'pipe';
}

/**
 * Runs a docker CLI command via spawn. No shell invocation — avoids injection.
 * Throws on non-zero exit. Returns { stdout, stderr } when stdio is 'pipe'.
 */
async function runDocker(
  args: string[],
  options: RunDockerOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdio = 'pipe' } = options;
  if (stdio === 'inherit') {
    await spawnAsync({
      command: 'docker',
      args,
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    return { stdout: '', stderr: '' };
  }
  const r = await spawnWait({ command: 'docker', args, cwd: process.cwd() });
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `docker exited with ${r.code}`;
    throw new Error(msg);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Embedded scripts and binaries loaded at module init
// ---------------------------------------------------------------------------

let stagingStartScriptPromise: Promise<string> | null = null;

function loadStagingStartScript(): Promise<string> {
  if (!stagingStartScriptPromise) {
    stagingStartScriptPromise = readUtf8(
      join(getSaifRoot(), 'src', 'orchestrator', 'scripts', 'staging-start.sh'),
    );
  }
  return stagingStartScriptPromise;
}

const CODER_START_SCRIPT = join(getSaifRoot(), 'src', 'orchestrator', 'scripts', 'coder-start.sh');

let sidecarBinaryCache: Buffer | null = null;

/** In-container workspace path that Leash bind-mounts the sandbox into. */
const CONTAINER_WORKSPACE = '/workspace';

/**
 * Resolve symlinks on the host path before passing to `docker run -v`.
 * On macOS, `/tmp` often symlinks to `/private/tmp`; mixing non-canonical paths with
 * Colima/Docker Desktop bind mounts can yield empty mounts (e.g. `/saifac/startup.sh` missing).
 * Leash also uses `getcwd()` as `callerDir`; keep {@link spawn} `cwd` aligned with the same path.
 */
async function dockerHostBindPath(hostPath: string): Promise<string> {
  try {
    return await realpath(hostPath);
  } catch {
    return hostPath;
  }
}

/**
 * Assemble all per-run orchestration scripts into a single directory so they
 * can be mounted as one directory volume (`--volume <dir>:/saifac:ro`).
 *
 * The directory is placed inside `sandboxBasePath` and is therefore cleaned up
 * for free by `destroySandbox`.
 */
async function assembleSaifacDir(opts: {
  sandboxBasePath: string;
  coderStartScript: string;
  gatePath: string;
  startupPath: string;
  agentInstallPath: string;
  agentPath: string;
  reviewerScriptPath?: string;
}): Promise<string> {
  const {
    sandboxBasePath,
    coderStartScript,
    gatePath,
    startupPath,
    agentInstallPath,
    agentPath,
    reviewerScriptPath,
  } = opts;
  const saifacDir = join(sandboxBasePath, 'saifac');
  await mkdir(saifacDir, { recursive: true });

  await copyFile(coderStartScript, join(saifacDir, 'coder-start.sh'));
  await copyFile(gatePath, join(saifacDir, 'gate.sh'));
  await copyFile(startupPath, join(saifacDir, 'startup.sh'));
  await copyFile(agentInstallPath, join(saifacDir, 'agent-install.sh'));
  await copyFile(agentPath, join(saifacDir, 'agent.sh'));
  if (reviewerScriptPath) {
    await copyFile(reviewerScriptPath, join(saifacDir, 'reviewer.sh'));
  }

  return saifacDir;
}

// ---------------------------------------------------------------------------
// Internal container/network tracking
// ---------------------------------------------------------------------------

interface ContainerHandle {
  id: string;
  name: string;
  container: Docker.Container;
}

class DockerRegistry {
  private containers: ContainerHandle[] = [];
  private networks: string[] = [];
  private images: string[] = [];

  registerContainers(handles: ContainerHandle[]): void {
    this.containers.push(...handles);
  }
  registerNetwork(name: string): void {
    if (name) this.networks.push(name);
  }
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

    for (const handle of containersToStop) {
      try {
        await handle.container.remove({ force: true });
      } catch (err) {
        consola.warn(`[docker] Warning: could not remove ${handle.name}: ${String(err)}`);
      }
    }
    for (const net of networksToRemove) {
      await removeDockerNetwork(net);
    }
    for (const tag of imagesToRemove) {
      await removeDockerImage(tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Network diagnostics (bridge / staging / test-runner visibility)
// ---------------------------------------------------------------------------

function formatContainerNetworkEndpoint(
  networks: Record<string, { Aliases?: string[]; IPAddress?: string }> | undefined,
  preferredNetwork: string,
): string {
  if (!networks || Object.keys(networks).length === 0) {
    return '(no networks in container inspect)';
  }
  const preferred = networks[preferredNetwork];
  if (preferred) {
    const aliases = Array.isArray(preferred.Aliases) ? preferred.Aliases : [];
    return `on "${preferredNetwork}" aliases=${JSON.stringify(aliases)} ip=${preferred.IPAddress ?? '?'}`;
  }
  const summary = Object.entries(networks).map(([k, v]) => ({
    networkKey: k,
    aliases: Array.isArray(v.Aliases) ? v.Aliases : [],
    ip: v.IPAddress ?? '?',
  }));
  return `expected key "${preferredNetwork}" missing; attached: ${JSON.stringify(summary)}`;
}

async function logStagingContainerNetworkAliases(opts: {
  container: Docker.Container;
  networkName: string;
  containerName: string;
}): Promise<void> {
  const { container, networkName, containerName } = opts;
  try {
    const info = await container.inspect();
    const nets = info.NetworkSettings?.Networks as
      | Record<string, { Aliases?: string[]; IPAddress?: string }>
      | undefined;
    const detail = formatContainerNetworkEndpoint(nets, networkName);
    consola.log(`[docker] ${containerName} — ${detail}`);
  } catch (err) {
    consola.warn(
      `[docker] Could not inspect staging container "${containerName}" for network aliases: ${String(err)}`,
    );
  }
}

async function logBridgeNetworkEndpoints(opts: {
  networkName: string;
  context: string;
}): Promise<void> {
  const { networkName, context } = opts;
  try {
    const listed = await docker.listNetworks({ filters: { name: [networkName] } });
    const match = listed.find((n) => n.Name === networkName) ?? listed[0];
    if (!match) {
      consola.warn(`[docker] (${context}) No Docker network matched filter name="${networkName}"`);
      return;
    }
    if (match.Name !== networkName) {
      consola.warn(
        `[docker] (${context}) listNetworks returned "${match.Name}" (wanted exact "${networkName}")`,
      );
    }
    const net = docker.getNetwork(match.Id);
    const data = await net.inspect();
    const containers = data.Containers ?? {};
    const rows = Object.values(containers).map((c) => ({
      name: c.Name.replace(/^\//, ''),
      ipv4: c.IPv4Address,
    }));
    consola.log(
      `[docker] (${context}) Bridge "${data.Name}" id=${data.Id.slice(0, 12)}… driver=${data.Driver} endpointCount=${rows.length}:`,
    );
    consola.log(`[docker] (${context})   ${JSON.stringify(rows)}`);
  } catch (err) {
    consola.warn(
      `[docker] (${context}) Could not inspect network "${networkName}": ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// DockerProvisioner
// ---------------------------------------------------------------------------

export class DockerProvisioner implements Provisioner {
  private readonly composeFile?: string;

  // State set during setup(), read by later methods
  private networkName = '';
  private runId = '';
  private projectDir = '';
  private composeProjectName = '';

  private readonly registry = new DockerRegistry();

  constructor(private readonly config: DockerEnvironment) {
    this.composeFile = config.file;
  }

  // ── 1. setup ──────────────────────────────────────────────────────────────

  async setup(opts: ProvisionerSetupOpts): Promise<void> {
    const { runId, projectName, featureName, projectDir } = opts;
    this.runId = runId;
    this.projectDir = projectDir;

    // Create an isolated bridge network for this run
    this.networkName = `saifac-net-${projectName}-${featureName}-${runId}`;
    await ensureCreateNetwork(this.networkName);
    this.registry.registerNetwork(this.networkName);
    consola.log(`[docker] Bridge network ready: ${this.networkName}`);

    // Bring up compose services (if configured)
    if (this.composeFile) {
      this.composeProjectName = `saifac-${runId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
      const absoluteFile = resolve(projectDir, this.composeFile);

      if (!(await pathExists(absoluteFile))) {
        throw new Error(
          `[docker] Compose file not found: "${this.composeFile}" (resolved: ${absoluteFile}). ` +
            `Check environments.coding.file or environments.staging.file in saifac/config.ts.`,
        );
      }

      consola.log(
        `[docker] Starting compose project "${this.composeProjectName}" (file: ${absoluteFile})`,
      );
      await runDocker(
        ['compose', '-p', this.composeProjectName, '-f', absoluteFile, 'up', '-d', '--wait'],
        { stdio: 'inherit' },
      );

      // Attach every compose service to the SAIFAC bridge network
      await this.attachComposeSvcToNetwork(absoluteFile);

      const serviceNames = await this.listComposeServices(absoluteFile);
      consola.log(
        `[docker] Compose project "${this.composeProjectName}" up — services: ${serviceNames.join(', ')}`,
      );
    }
  }

  // ── 2. startStaging ───────────────────────────────────────────────────────

  async startStaging(opts: StartStagingOpts): Promise<StagingHandle> {
    const {
      sandboxProfileId,
      codePath,
      projectDir,
      stagingEnvironment,
      feature,
      projectName,
      startupPath,
      stagePath,
    } = opts;

    const containerConfig = stagingEnvironment.app;
    const containerName = `saifac-stage-${projectName}-${feature.name}-${this.runId}`;
    const imageTag = `saifac-stage-${projectName}-${feature.name}-img-${this.runId}`;

    // Build ephemeral staging image
    await this.buildStagingImage({
      sandboxProfileId: sandboxProfileId as SupportedSandboxProfileId,
      codePath,
      projectDir,
      dockerfile: containerConfig.build?.dockerfile,
      imageTag,
    });
    this.registry.registerImage(imageTag);

    consola.log(`[docker] Starting staging container: ${containerName}`);

    const appEnvEntries = Object.entries(stagingEnvironment.appEnvironment ?? {}).map(
      ([k, v]) => `${k}=${v}`,
    );

    const container = await docker.createContainer({
      Image: imageTag,
      name: containerName,
      Cmd: ['/bin/sh', '/saifac/staging-start.sh'],
      HostConfig: {
        NetworkMode: this.networkName,
        Binds: [
          `${codePath}:/workspace`,
          `${startupPath}:/saifac/startup.sh:ro`,
          `${stagePath}:/saifac/stage.sh:ro`,
        ],
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [this.networkName]: { Aliases: ['staging'] },
        },
      },
      Env: [
        ...appEnvEntries,
        `SAIFAC_FEATURE_NAME=${feature.name}`,
        `SAIFAC_SIDECAR_PORT=${containerConfig.sidecarPort}`,
        `SAIFAC_SIDECAR_PATH=${containerConfig.sidecarPath}`,
        `SAIFAC_STARTUP_SCRIPT=/saifac/startup.sh`,
        `SAIFAC_STAGE_SCRIPT=/saifac/stage.sh`,
      ],
      WorkingDir: '/workspace',
    });

    // Inject sidecar binary and staging-start.sh via putArchive (preserves +x bit)
    const sidecarBinary = await getSidecarBinary();
    const stagingStartScript = await loadStagingStartScript();
    const tarBuffer = createTarArchive([
      { filename: 'sidecar', content: sidecarBinary, mode: '0000755' },
      { filename: 'staging-start.sh', content: stagingStartScript, mode: '0000755' },
    ]);
    await container.putArchive(tarBuffer, { path: '/saifac' });

    await container.start();
    consola.log(`[docker] ${containerName} started`);

    await logStagingContainerNetworkAliases({
      container,
      networkName: this.networkName,
      containerName,
    });

    const handle: ContainerHandle = { id: container.id, name: containerName, container };
    this.registry.registerContainers([handle]);

    streamContainerLogs(container, containerName);

    // Wait for sidecar health endpoint
    await waitForContainerReady({ containerName, container, port: containerConfig.sidecarPort });

    const sidecarUrl = `http://staging:${containerConfig.sidecarPort}${containerConfig.sidecarPath}`;
    const targetUrl = containerConfig.baseUrl ?? sidecarUrl;

    return { targetUrl, sidecarUrl };
  }

  // ── 3. runTests ───────────────────────────────────────────────────────────

  async runTests(opts: RunTestsOpts): Promise<TestsResult> {
    const {
      testsDir,
      reportDir,
      reportPath,
      testImage,
      testScriptPath,
      stagingHandle,
      feature,
      projectName,
      runId,
      signal,
    } = opts;

    assertSafeImageTag(testImage);

    const containerName = `saifac-test-${projectName}-${runId}`;
    const containerTestsDir = '/tests';
    const containerOutputFile = '/test-runner-output/results.xml';

    const publicDir = join(testsDir, 'public');
    const hiddenDir = join(testsDir, 'hidden');
    const helpersFile = join(testsDir, 'helpers.ts');
    const infraFile = join(testsDir, 'infra.spec.ts');

    const [hasPublic, hasHidden, hasHelpers, hasInfra] = await Promise.all([
      pathExists(publicDir),
      pathExists(hiddenDir),
      pathExists(helpersFile),
      pathExists(infraFile),
    ]);
    const binds = [
      ...(hasPublic ? [`${publicDir}:${containerTestsDir}/public:ro`] : []),
      ...(hasHidden ? [`${hiddenDir}:${containerTestsDir}/hidden:ro`] : []),
      ...(hasHelpers ? [`${helpersFile}:${containerTestsDir}/helpers.ts:ro`] : []),
      ...(hasInfra ? [`${infraFile}:${containerTestsDir}/infra.spec.ts:ro`] : []),
      `${testScriptPath}:/usr/local/bin/test.sh:ro`,
    ];

    consola.log(`[docker] Starting test runner container: ${containerName}`);
    consola.log(`[docker] Test image: ${testImage}`);
    consola.log(`[docker] Target URL: ${stagingHandle.targetUrl}`);
    consola.log(`[docker] Sidecar URL: ${stagingHandle.sidecarUrl}`);

    await logBridgeNetworkEndpoints({
      networkName: this.networkName,
      context: `before test runner ${containerName}`,
    });

    const container = await docker.createContainer({
      Image: testImage,
      name: containerName,
      HostConfig: {
        NetworkMode: this.networkName,
        Binds: [...binds, `${reportDir}:/test-runner-output:rw`],
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
      },
      Env: [
        `SAIFAC_TARGET_URL=${stagingHandle.targetUrl}`,
        `SAIFAC_SIDECAR_URL=${stagingHandle.sidecarUrl}`,
        `SAIFAC_FEATURE_NAME=${feature.name}`,
        `SAIFAC_TESTS_DIR=${containerTestsDir}`,
        `SAIFAC_OUTPUT_FILE=${containerOutputFile}`,
      ],
      WorkingDir: '/workspace',
    });

    // Bail out before starting if already cancelled — avoids a start + immediate stop cycle.
    if (signal?.aborted) {
      await container.remove({ force: true }).catch(() => {});
      return { status: 'aborted', stdout: '', stderr: '' };
    }

    await container.start();
    consola.log(`[docker] ${containerName} started`);

    const handle: ContainerHandle = { id: container.id, name: containerName, container };
    this.registry.registerContainers([handle]);

    streamContainerLogs(container, containerName);

    consola.log(`[docker] Waiting for test runner to complete...`);

    const waitPromise = (container.wait() as Promise<{ StatusCode: number }>).then((r) => {
      signal?.removeEventListener('abort', onAbort);
      return r;
    });

    let aborted = false;

    // When the signal fires, stop the container. container.wait() will then
    // resolve naturally with exit code 137 — no dangling promises.
    const onAbort = () => {
      aborted = true;
      consola.log(`[docker] Abort signal received — stopping test runner ${containerName}`);
      container.stop().catch((err: unknown) => {
        consola.warn(`[docker] Warning: could not stop ${containerName}: ${String(err)}`);
      });
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const { StatusCode } = await waitPromise;

    const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
    const { stdout, stderr } = demuxDockerLogs(logStream as unknown as Buffer);

    consola.log(`[docker] Test runner exit code: ${StatusCode}${aborted ? ' (aborted)' : ''}`);
    if (stdout) consola.log(`[docker] Test runner stdout:\n${stdout}`);
    if (stderr) consola.error(`[docker] Test runner stderr:\n${stderr}`);

    this.registry.deregisterContainers([handle]);
    try {
      await container.remove({ force: true });
    } catch (err) {
      consola.warn(`[docker] Warning: could not remove ${containerName}: ${String(err)}`);
    }

    if (aborted) {
      return { status: 'aborted', stdout, stderr };
    }

    const runnerError = detectRunnerError({ exitCode: StatusCode, stdout, stderr });
    if (runnerError) {
      consola.error(`[docker] Test runner error detected: ${runnerError}`);
    }

    const testSuites =
      reportPath && (await pathExists(reportPath))
        ? await parseJUnitXmlFromFile(reportPath)
        : undefined;

    return {
      status: StatusCode === 0 ? 'passed' : 'failed',
      stdout,
      stderr,
      runnerError,
      testSuites,
    };
  }

  // ── 4. runAgent ───────────────────────────────────────────────────────────

  async runAgent(opts: RunAgentOpts): Promise<AgentResult> {
    const {
      codePath,
      sandboxBasePath,
      task,
      errorFeedback,
      llmConfig,
      saifDir,
      feature,
      dangerousDebug,
      cedarPolicyPath,
      coderImage,
      gateRetries,
      startupPath,
      agentInstallPath,
      agentPath,
      agentEnv,
      agentLogFormat,
      reviewer,
      signal,
    } = opts;

    const safeAgentEnv = filterAgentEnv(agentEnv);
    const taskPrompt = await buildTaskPrompt({ codePath, task, saifDir, feature, errorFeedback });
    const llmModel = llmConfig.fullModelString;
    const llmApiKey = llmConfig.apiKey;
    const llmProvider = llmConfig.provider;
    const llmBaseUrl = llmConfig.baseURL;

    let cmd: string;
    let args: string[];
    let argsForPrint: string[];
    let spawnCwd: string;
    let spawnEnv: Record<string, string>;

    if (dangerousDebug) {
      cmd = 'bash';
      args = [CODER_START_SCRIPT];
      argsForPrint = [CODER_START_SCRIPT];
      spawnCwd = codePath;
      spawnEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
        ),
        ...safeAgentEnv,
        LLM_MODEL: llmModel,
        LLM_API_KEY: llmApiKey,
        ...(llmProvider ? { LLM_PROVIDER: llmProvider } : {}),
        ...(llmBaseUrl ? { LLM_BASE_URL: llmBaseUrl } : {}),
        SAIFAC_WORKSPACE_BASE: codePath,
        SAIFAC_INITIAL_TASK: taskPrompt,
        SAIFAC_GATE_RETRIES: String(gateRetries),
        SAIFAC_STARTUP_SCRIPT: startupPath,
        SAIFAC_AGENT_INSTALL_SCRIPT: agentInstallPath,
        SAIFAC_GATE_SCRIPT: `${sandboxBasePath}/gate.sh`,
        SAIFAC_AGENT_SCRIPT: agentPath,
        SAIFAC_TASK_PATH: saifacTaskFilePath(codePath),
      };
      consola.log('[agent-runner] Mode: dangerous-debug (host execution, filesystem sandbox only)');
    } else {
      // Leash mode
      const saifacDir = await assembleSaifacDir({
        sandboxBasePath,
        coderStartScript: CODER_START_SCRIPT,
        gatePath: join(sandboxBasePath, 'gate.sh'),
        startupPath,
        agentInstallPath,
        agentPath,
        reviewerScriptPath: reviewer?.scriptPath,
      });

      const codePathHost = await dockerHostBindPath(codePath);
      const saifacDirHost = await dockerHostBindPath(saifacDir);

      const envForward: Record<string, string> = {
        LLM_MODEL: llmModel,
        LLM_API_KEY: llmApiKey,
        ...(llmProvider ? { LLM_PROVIDER: llmProvider } : {}),
        ...(llmBaseUrl ? { LLM_BASE_URL: llmBaseUrl } : {}),
        OPENHANDS_WORK_DIR: '/tmp/openhands-state',
        ...safeAgentEnv,
      };

      for (const key of [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'GEMINI_API_KEY',
        'DASHSCOPE_API_KEY',
      ]) {
        const val = process.env[key];
        if (val) envForward[key] = val;
      }

      const leashArgs: string[] = [
        'leash',
        '--no-interactive',
        '--verbose',
        '--image',
        coderImage,
        '--volume',
        `${codePathHost}:${CONTAINER_WORKSPACE}`,
        '--volume',
        `${saifacDirHost}:/saifac:ro`,
      ];

      if (reviewer) {
        const argusBinaryHost = await dockerHostBindPath(reviewer.argusBinaryPath);
        leashArgs.push('--volume', `${argusBinaryHost}:/usr/local/bin/argus:ro`);
        envForward.SAIFAC_REVIEWER_SCRIPT = '/saifac/reviewer.sh';
        envForward.REVIEWER_LLM_PROVIDER = reviewer.llmConfig.provider;
        envForward.REVIEWER_LLM_MODEL = reviewer.llmConfig.modelId;
        envForward.REVIEWER_LLM_API_KEY = reviewer.llmConfig.apiKey;
        if (reviewer.llmConfig.baseURL) {
          envForward.REVIEWER_LLM_BASE_URL = reviewer.llmConfig.baseURL;
        }
      }

      if (await pathExists(cedarPolicyPath)) {
        const cedarPolicyHost = await dockerHostBindPath(cedarPolicyPath);
        leashArgs.push('--policy', cedarPolicyHost);
        consola.log(`[agent-runner] Cedar policy: ${cedarPolicyHost}`);
      } else {
        throw new Error(`Cedar policy file not found at ${cedarPolicyPath}`);
      }

      for (const [key, val] of Object.entries(envForward)) {
        leashArgs.push('--env', `${key}=${val}`);
      }

      leashArgs.push(
        '--env',
        `SAIFAC_WORKSPACE_BASE=${CONTAINER_WORKSPACE}`,
        '--env',
        `SAIFAC_INITIAL_TASK=${taskPrompt}`,
        '--env',
        `SAIFAC_GATE_RETRIES=${gateRetries}`,
        '--env',
        `SAIFAC_STARTUP_SCRIPT=/saifac/startup.sh`,
        '--env',
        `SAIFAC_AGENT_INSTALL_SCRIPT=/saifac/agent-install.sh`,
        '--env',
        `SAIFAC_AGENT_SCRIPT=/saifac/agent.sh`,
        // Invoke via bash so the script doesn't need +x in the mounted directory.
        // This mirrors how gate.sh and reviewer.sh are invoked inside coder-start.sh.
        'bash',
        '/saifac/coder-start.sh',
      );

      const SENSITIVE_ENV_KEYS = new Set([
        'LLM_API_KEY',
        'REVIEWER_LLM_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'GEMINI_API_KEY',
        'DASHSCOPE_API_KEY',
      ]);
      argsForPrint = leashArgs.map((a) => {
        if (!a.includes('=')) return a;
        const eq = a.indexOf('=');
        const k = a.slice(0, eq);
        if (SENSITIVE_ENV_KEYS.has(k)) return `${k}=****`;
        if (k === 'SAIFAC_INITIAL_TASK') return `${k}=<task (${a.length - eq - 1} chars)>`;
        return a;
      });

      // execPath=`/usr/local/bin/node`
      // leashBin=`/path/to/my-proj/node_modules/@strongdm/leash/bin/leash.js`
      const leashBin = resolveLeashCliPath();
      cmd = process.execPath;
      args = [leashBin, ...leashArgs.slice(1)];
      // Match Leash `callerDir` (getcwd) to canonical workspace path so its `callerDir:callerDir` mount matches ours.
      spawnCwd = codePathHost;

      const workspaceId = leashWorkspaceId(sandboxBasePath);
      spawnEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
        ),
        // WORKAROUND(leash-network): inject a predictable name via Leash's TARGET_CONTAINER,
        // so we know which container to attach to the SAIFAC network after Leash starts it.
        // See other `WORKAROUND(leash-network)` comments in this file.
        ...(this.networkName ? { TARGET_CONTAINER: `leash-target-${workspaceId}` } : {}),
      };

      consola.log(`[agent-runner] Mode: leash (container: ${coderImage})`);
      consola.log(`[agent-runner] Sandbox mount: ${codePathHost} → ${CONTAINER_WORKSPACE}`);
    }

    consola.log(`[agent-runner] Starting agent (model: ${llmModel})`);
    consola.log(
      `[agent-runner] Command: ${cmd} ${argsForPrint!.map((s) => s.slice(0, 100)).join(' ')}`,
    );

    const timeoutMs = 20 * 60 * 1000;

    // WORKAROUND(leash-network): See full explanation in the original agent-runner.ts.
    // Leash doesn't support a --network flag, so we poll `docker inspect` until the target
    // container appears and then call `docker network connect` to put it on our network.
    const networkAttach =
      !dangerousDebug && this.networkName
        ? startLeashNetworkAttach(this.networkName, leashWorkspaceId(sandboxBasePath))
        : null;

    const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
      (resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: spawnCwd,
          env: spawnEnv,
          stdio: ['inherit', 'pipe', 'pipe'],
        });

        let collected = '';
        let stdoutBuf = '';

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          collected += text;

          if (agentLogFormat === 'raw') {
            for (const line of text.split('\n')) {
              if (line.trim()) process.stdout.write(`[agent] ${line}\n`);
            }
          } else {
            stdoutBuf += text;
            const segments = stdoutBuf.split('--JSON Event--');
            stdoutBuf = segments.pop() ?? '';
            for (const segment of segments) {
              printOpenHandsSegment(segment);
            }
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          process.stderr.write(text);
          collected += text;
        });

        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          clearTimeout(timer);
          networkAttach?.cancel();
          reject(new Error('Agent step cancelled via abort signal'));
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        child.on('error', (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          networkAttach?.cancel();
          reject(err);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          networkAttach?.cancel();
          if (agentLogFormat !== 'raw' && stdoutBuf.trim()) printOpenHandsSegment(stdoutBuf);
          resolve({ exitCode: code ?? 1, output: collected });
        });
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error(`[agent-runner] Process error: ${msg}`);
      return { exitCode: 1, output: msg };
    });

    consola.log(`[agent-runner] Finished with exit code ${exitCode}`);
    return { success: exitCode === 0, exitCode, output };
  }

  // ── 5. teardown ───────────────────────────────────────────────────────────

  async teardown(_opts: ProvisionerTeardownOpts): Promise<void> {
    // 1. Stop/remove Docker containers + images tracked in the registry
    await this.registry.cleanup();

    // 2. Tear down compose stack (if one was started)
    if (this.composeFile && this.composeProjectName) {
      consola.log(`[docker] Tearing down compose project "${this.composeProjectName}"`);
      try {
        await runDocker(
          [
            'compose',
            '-p',
            this.composeProjectName,
            '-f',
            this.composeFile,
            'down',
            '-v',
            '--remove-orphans',
          ],
          { stdio: 'inherit' },
        );
        consola.log(`[docker] Compose project "${this.composeProjectName}" down`);
      } catch (err) {
        consola.warn(
          `[docker] Warning: failed to tear down compose project "${this.composeProjectName}": ${String(err)}`,
        );
      }
    }

    // 3. Remove the bridge network (after containers are gone)
    if (this.networkName) {
      await removeDockerNetwork(this.networkName);
      this.networkName = '';
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async buildStagingImage(opts: {
    sandboxProfileId: SupportedSandboxProfileId;
    codePath: string;
    projectDir: string;
    dockerfile?: string | null;
    imageTag: string;
  }): Promise<void> {
    const { sandboxProfileId, codePath, projectDir, dockerfile, imageTag } = opts;
    let dockerfilePath: string;

    if (dockerfile) {
      dockerfilePath = resolve(projectDir, dockerfile);
      if (!(await pathExists(dockerfilePath))) {
        throw new Error(
          `[docker] config environments.staging.app.build.dockerfile "${dockerfile}" not found at ${dockerfilePath}`,
        );
      }
      consola.log(`[docker] Using custom Dockerfile: ${dockerfilePath}`);
    } else {
      dockerfilePath = resolveSandboxCoderDockerfilePath(sandboxProfileId);
      if (!(await pathExists(dockerfilePath))) {
        throw new Error(
          `[docker] Profile "${sandboxProfileId}" requires Dockerfile.coder at ${dockerfilePath} but it is missing.`,
        );
      }
      consola.log(`[docker] Using profile ${sandboxProfileId} Dockerfile.coder`);
    }

    // Write a .dockerignore to keep the build context clean
    await writeUtf8(
      join(codePath, '.dockerignore'),
      ['node_modules', '.git', '*.log', 'dist', 'build', '.cache'].join('\n') + '\n',
    );

    consola.log(`[docker] Building staging container image: ${imageTag}`);
    await runDocker(['build', '-f', dockerfilePath, '-t', imageTag, codePath], {
      stdio: 'inherit',
    });
    consola.log(`[docker] Staging container image built: ${imageTag}`);
  }

  private async listComposeServices(absoluteFile: string): Promise<string[]> {
    try {
      const { stdout } = await runDocker([
        'compose',
        '-p',
        this.composeProjectName,
        '-f',
        absoluteFile,
        'ps',
        '--services',
      ]);
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async attachComposeSvcToNetwork(absoluteFile: string): Promise<void> {
    const serviceNames = await this.listComposeServices(absoluteFile);
    for (const service of serviceNames) {
      try {
        const { stdout } = await runDocker([
          'compose',
          '-p',
          this.composeProjectName,
          '-f',
          absoluteFile,
          'ps',
          '-q',
          service,
        ]);
        const containerName = stdout.trim();
        if (!containerName) continue;

        await runDocker(
          ['network', 'connect', '--alias', service, this.networkName, containerName],
          {
            stdio: 'inherit',
          },
        );
        consola.log(
          `[docker] Connected compose service "${service}" (${containerName}) to network "${this.networkName}"`,
        );
      } catch (err) {
        consola.warn(
          `[docker] Warning: could not attach compose service "${service}" to network "${this.networkName}": ${String(err)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: network management
// ---------------------------------------------------------------------------

async function ensureCreateNetwork(name: string): Promise<void> {
  try {
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
  } catch (err: unknown) {
    const isConflict =
      err instanceof Error &&
      (err.message.includes('409') || err.message.includes('already exists'));
    if (!isConflict) throw err;

    consola.warn(
      `[docker] Network ${name} already exists (leftover from prior run) — removing and recreating.`,
    );
    await removeDockerNetwork(name);
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
  }
}

async function removeDockerNetwork(networkName: string): Promise<void> {
  try {
    const networks = await docker.listNetworks({ filters: { name: [networkName] } });
    for (const net of networks) {
      const n = docker.getNetwork(net.Id);
      await n.remove();
    }
  } catch (err) {
    consola.warn(`[docker] Warning: could not remove network ${networkName}: ${String(err)}`);
  }
}

async function removeDockerImage(imageTag: string): Promise<void> {
  try {
    const image = docker.getImage(imageTag);
    await image.remove({ force: true });
  } catch {
    // Image not found or already removed — not an error
  }
}

// ---------------------------------------------------------------------------
// Utility: container health check
// ---------------------------------------------------------------------------

async function waitForContainerReady(opts: {
  containerName: string;
  container: Docker.Container;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const { containerName, container, port, timeoutMs = 180_000 } = opts;
  const healthCmd = [
    'node',
    '-e',
    `fetch('http://localhost:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
  ];

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  consola.log(`[docker] Waiting for ${containerName} to be ready on port ${port}...`);

  while (Date.now() < deadline) {
    attempt++;
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(
          `[docker] ${containerName} exited (code ${info.State.ExitCode ?? '?'}) before the sidecar became ready. ` +
            `Check the container logs above for startup errors.`,
        );
      }
      const exec = await container.exec({
        Cmd: healthCmd,
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((res) => stream.on('end', res));
      const inspect = await exec.inspect();
      if ((inspect.ExitCode ?? -1) === 0) {
        consola.log(`[docker] ${containerName} is ready (attempt ${attempt})`);
        return;
      }
    } catch (err) {
      consola.log(`[docker] Health check error (attempt ${attempt}): ${String(err)}`);
    }
    await sleep(500);
  }

  consola.warn(`[docker] ${containerName} did not become ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Utility: log streaming & demux
// ---------------------------------------------------------------------------

function streamContainerLogs(container: Docker.Container, label: string): void {
  void container
    .logs({ follow: true, stdout: true, stderr: true, timestamps: false })
    .then((stream: NodeJS.ReadableStream) => {
      const out = new PassThrough();
      const err = new PassThrough();
      docker.modem.demuxStream(stream, out, err);

      let buf = '';
      function onChunk(chunk: Buffer | string) {
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
    .catch(() => {});
}

function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  if (!Buffer.isBuffer(buffer)) return { stdout: String(buffer), stderr: '' };

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
// Utility: image tag safety
// ---------------------------------------------------------------------------

function assertSafeImageTag(tag: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    throw new Error(
      `[docker] Unsafe image tag rejected: "${tag}". ` +
        `Tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @ signs.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility: staging image tag helper (used by modes.ts for cleanup)
// ---------------------------------------------------------------------------

export function getStagingImageTag(
  stagingApp: { build?: { dockerfile?: string } | undefined },
  opts: { projectName: string; featureName: string; runId: string },
): string | null {
  if (stagingApp.build?.dockerfile === null) return null;
  const { projectName, featureName, runId } = opts;
  return `saifac-stage-${projectName}-${featureName}-img-${runId}`;
}

// ---------------------------------------------------------------------------
// Utility: hasFeatureSuccessfullyFailed (used by modes.ts for fail2pass)
// ---------------------------------------------------------------------------

export function hasFeatureSuccessfullyFailed(result: TestsResult): boolean {
  if (!result.testSuites) return result.status === 'failed';
  for (const suite of result.testSuites) {
    for (const assertion of suite.assertionResults) {
      if (assertion.ancestorTitles.includes('sidecar:health')) continue;
      if (assertion.status === 'failed') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Utility: Leash workspace id derivation
// ---------------------------------------------------------------------------

function leashWorkspaceId(sandboxBasePath: string): string {
  const segments = sandboxBasePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = segments.slice(-2).join('-');
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// WORKAROUND(leash-network): post-start polling + network attach
//
// Leash doesn't support a --network flag. We set TARGET_CONTAINER (Leash's own env var
// for overriding the target container name) to a predictable value so we know which
// container to attach to the SAIFAC bridge network after Leash starts it. We then
// poll `docker inspect` until the container appears and call `docker network connect`.
//
// See https://github.com/strongdm/leash/issues/69
// ---------------------------------------------------------------------------

interface NetworkAttachHandle {
  cancel(): void;
}

function startLeashNetworkAttach(networkName: string, workspaceId: string): NetworkAttachHandle {
  const containerName = `leash-target-${workspaceId}`;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (cancelled) return;
    try {
      const { stdout } = await runDocker(['inspect', '-f', '{{.State.Running}}', containerName]);
      const out = stdout.trim();

      if (out === 'true') {
        consola.log(
          `[agent-runner] Attaching container "${containerName}" to network "${networkName}"...`,
        );
        await runDocker(['network', 'connect', networkName, containerName], { stdio: 'inherit' });
        consola.log(`[agent-runner] Container "${containerName}" attached to "${networkName}".`);
        return;
      }
    } catch {
      // Container doesn't exist yet — retry
    }
    if (!cancelled) timer = setTimeout(() => void poll(), 500);
  };

  timer = setTimeout(() => void poll(), 500);

  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Utility: task prompt builder (moved from agent-runner.ts)
// ---------------------------------------------------------------------------

interface BuildTaskPromptOpts {
  codePath: string;
  task: string;
  saifDir: string;
  feature?: Feature;
  errorFeedback?: string;
}

async function buildTaskPrompt(opts: BuildTaskPromptOpts): Promise<string> {
  const { codePath, task, saifDir, feature, errorFeedback } = opts;
  let planContent = '';

  const planCandidates: string[] = [];
  if (feature) planCandidates.push(join(codePath, feature.relativePath, 'plan.md'));
  planCandidates.push(join(codePath, 'plan.md'));

  for (const p of planCandidates) {
    if (await pathExists(p)) {
      planContent = await readUtf8(p);
      break;
    }
  }

  const parts: string[] = [task];
  if (planContent) parts.push('', '## Implementation Plan', '', planContent);
  if (errorFeedback?.trim()) {
    parts.push(
      '',
      '## Previous Attempt Failed — Fix These Errors',
      '',
      '```',
      errorFeedback.trim(),
      '```',
      '',
      `Analyze the errors above and fix the code. Do NOT modify files in the /${saifDir}/ directory.`,
    );
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Sidecar binary loader (moved from staging.ts)
// ---------------------------------------------------------------------------

async function getSidecarBinary(): Promise<Buffer> {
  // Loaded lazily to avoid blocking startup.
  if (sidecarBinaryCache) return sidecarBinaryCache;

  const hostArch = arch();
  const binaryName = hostArch === 'arm64' ? 'sidecar-linux-arm64' : 'sidecar-linux-amd64';
  const binaryPath = join(
    getSaifRoot(),
    'src',
    'orchestrator',
    'sidecars',
    'cli-over-http',
    'out',
    binaryName,
  );

  if (!(await pathExists(binaryPath))) {
    throw new Error(
      `[sidecar] Pre-compiled sidecar binary not found at ${binaryPath}. ` +
        `Run: cd src/orchestrator/sidecars/cli-over-http && ` +
        `GOOS=linux GOARCH=${hostArch === 'arm64' ? 'arm64' : 'amd64'} CGO_ENABLED=0 go build -o out/${binaryName} .`,
    );
  }

  sidecarBinaryCache = await readFileBuffer(binaryPath);
  return sidecarBinaryCache;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
