/**
 * DockerEngine — the single Docker-aware implementation of the Engine interface.
 *
 * Encapsulates Docker Engine usage, selected CLI usage, log demuxing, sidecar injection,
 * and the Leash network attachment workaround.
 *
 * Preferably use the Dockerode — a typed Docker Engine API wrapper. However,
 * there are cases where other options fit better:
 * - `docker compose` is not available through Dockerode
 * - `docker build` would require us to pack the build context into a tar stream
 *    and then consume a progress stream to detect errors. CLI is simpler.
 * - `docker run` - When Leash is enabled, Docker is called indirectly via Leash CLI.
 *   Thus, to keep the overall flow identical, and only swapping the `leash xxx` command
 *   for `docker run`, we invoke `docker run` via CLI.
 *
 * Lifecycle per run:
 *   setup()        → create bridge network + `docker compose up`
 *   startStaging() → docker build + createContainer + putArchive + start + health-wait
 *   runTests()     → createContainer + start + wait + demux logs + read JUnit XML bytes
 *   runAgent()     → spawn Leash CLI + network-attach workaround; idle container when inspectMode set
 *   teardown()       → containers + images + compose down + network (from {@link LiveInfra})
 */

import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import Docker from 'dockerode';

import type { DockerEnvironment } from '../../config/schema.js';
import {
  DEFAULT_LEASH_IMAGE,
  getSaifctlRoot,
  SANDBOX_CEDAR_POLICY_BASENAME,
} from '../../constants.js';
import { consola } from '../../logger.js';
import { SAIFCTL_PAUSE_ABORT_REASON } from '../../runs/types.js';
import {
  resolveSandboxCoderDockerfilePath,
  type SupportedSandboxProfileId,
} from '../../sandbox-profiles/index.js';
import { createTarArchive } from '../../utils/archive.js';
import {
  pathExists,
  readFileBuffer,
  readUtf8,
  spawnAsync,
  spawnWait,
  writeUtf8,
} from '../../utils/io.js';
import { type EngineLogSource, type EngineOnLog } from '../logs.js';
import type {
  CoderInspectSessionHandle,
  ContainerEnv,
  Engine,
  EnginePauseInfraOpts,
  EngineResumeInfraOpts,
  EngineSetupOpts,
  EngineSetupResult,
  EngineTeardownOpts,
  EngineVerifyResumeInfraOpts,
  LiveInfra,
  RunAgentEngineResult,
  RunAgentOpts,
  RunTestsEngineResult,
  RunTestsOpts,
  StartStagingOpts,
  StartStagingResult,
} from '../types.js';
import { detectRunnerError } from '../utils/test-parser.js';
import type { DockerLiveInfra } from './types.js';

/** In-container workspace path that Leash bind-mounts the sandbox into. */
const CONTAINER_WORKSPACE = '/workspace';

// Docker client singleton
const docker = new Docker();

// ---------------------------------------------------------------------------
// runDocker — compose + build only (no shell, avoids injection)
// ---------------------------------------------------------------------------

interface RunDockerOptions {
  /** 'inherit' streams output to parent; 'pipe' captures stdout/stderr */
  stdio?: 'inherit' | 'pipe';
}

/**
 * Runs Docker CLI commands that have no good dockerode equivalent: `docker compose`, `docker build`.
 * No shell invocation — avoids injection. Throws on non-zero exit.
 * Returns { stdout, stderr } when stdio is 'pipe'.
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
// DockerEngine
// ---------------------------------------------------------------------------

export class DockerEngine implements Engine {
  readonly name = 'docker' as const;

  private readonly composeFile?: string;

  constructor(private readonly config: DockerEnvironment) {
    this.composeFile = config.file;
  }

  // ── 1. setup ──────────────────────────────────────────────────────────────

  async setup(opts: EngineSetupOpts): Promise<EngineSetupResult> {
    const { projectDir, projectName, featureName, runId } = opts;

    // Target state after setup() is done
    const infra: DockerLiveInfra = {
      engine: 'docker',
      networkName: `saifctl-net-${projectName}-${featureName}-${runId}`,
      composeProjectName: this.composeFile
        ? `saifctl-${runId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
        : '',
      stagingImages: [],
      containers: [],
      projectDir,
      composeFile: this.composeFile,
    };

    // Create an isolated bridge network for this run (used by the coder container and test runner)
    await ensureCreateNetwork(infra.networkName);
    consola.log(`[docker] Bridge network ready: ${infra.networkName}`);

    // Bring up compose services (if configured)
    if (this.composeFile) {
      const absoluteFile = resolve(projectDir, this.composeFile);

      if (!(await pathExists(absoluteFile))) {
        throw new Error(
          `[docker] Compose file not found: "${this.composeFile}" (resolved: ${absoluteFile}). ` +
            `Check environments.coding.file or environments.staging.file in saifctl/config.ts.`,
        );
      }

      consola.log(
        `[docker] Starting compose project "${infra.composeProjectName}" (file: ${absoluteFile})`,
      );
      await runDocker(
        [
          'compose',
          '-p',
          infra.composeProjectName,
          '-f',
          absoluteFile,
          'up',
          '-d',
          '--wait',
          '--no-recreate',
        ],
        { stdio: 'inherit' },
      );

      // Attach every compose service to the SaifCTL bridge network
      await attachComposeSvcToNetwork({
        composeProjectName: infra.composeProjectName,
        absoluteFile,
        networkName: infra.networkName,
      });

      const serviceNames = await listComposeServices({
        composeProjectName: infra.composeProjectName,
        absoluteFile,
      });
      consola.log(
        `[docker] Compose project "${infra.composeProjectName}" up — services: ${serviceNames.join(', ')}`,
      );
    }

    // See {@link EngineSetupOpts.sandboxBasePath}: register the leash / no-leash coder container
    // name on live infra as soon as setup finishes so signal handlers and teardown see it even if
    // runAgent() never returns (spawn failure, SIGINT after container create, etc.).
    // Both the Leash target AND the Leash manager (`<target>-leash`) are pre-registered so that
    // teardown() removes both even when runAgent() is interrupted before it can update infra.
    // For --dangerous-no-leash runs there is no manager container; removeDockerContainerForce is
    // force/best-effort so a spurious removal attempt is harmless.
    let outInfra: DockerLiveInfra = infra;
    if (opts.sandboxBasePath) {
      outInfra = dockerInfraWithContainer(outInfra, leashTargetContainerName(opts.sandboxBasePath));
      outInfra = dockerInfraWithContainer(
        outInfra,
        leashManagerContainerName(opts.sandboxBasePath),
      );
    }

    return { infra: outInfra };
  }

  // ── 2. startStaging ───────────────────────────────────────────────────────

  async startStaging(opts: StartStagingOpts): Promise<StartStagingResult> {
    const {
      runId,
      sandboxProfileId,
      codePath,
      projectDir,
      stagingEnvironment,
      feature,
      projectName,
      saifctlPath,
      onLog,
      infra: infraIn,
    } = opts;

    const infra = assertDockerInfra(infraIn);
    const networkName = infra.networkName;

    const containerConfig = stagingEnvironment.app;
    const containerName = `saifctl-stage-${projectName}-${feature.name}-${runId}`;
    const imageTag = `saifctl-stage-${projectName}-${feature.name}-img-${runId}`;

    // Build ephemeral staging image
    await buildStagingImage({
      sandboxProfileId: sandboxProfileId as SupportedSandboxProfileId,
      codePath,
      projectDir,
      dockerfile: containerConfig.build?.dockerfile,
      imageTag,
    });
    // New infra state after building the staging image
    let nextInfra = dockerInfraWithStagingImage(infra, imageTag);

    consola.log(`[docker] Starting staging container: ${containerName}`);

    const appEnvEntries = Object.entries(stagingEnvironment.appEnvironment ?? {}).map(
      ([k, v]) => `${k}=${v}`,
    );

    // Clear stale container from a prior failed attempt (e.g. missing sidecar binary after
    // createContainer) so the next run does not hit Docker 409 name conflict.
    await removeDockerContainerForce(containerName);

    const container = await docker.createContainer({
      Image: imageTag,
      name: containerName,
      Cmd: ['/bin/sh', '/saifctl/staging-start.sh'],
      HostConfig: {
        NetworkMode: networkName,
        // Writable: putArchive injects sidecar into /saifctl before start.
        Binds: [`${codePath}:/workspace`, `${saifctlPath}:/saifctl`],
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: { Aliases: ['staging'] },
        },
      },
      Env: [
        ...appEnvEntries,
        `SAIFCTL_FEATURE_NAME=${feature.name}`,
        `SAIFCTL_SIDECAR_PORT=${containerConfig.sidecarPort}`,
        `SAIFCTL_SIDECAR_PATH=${containerConfig.sidecarPath}`,
        `SAIFCTL_STARTUP_SCRIPT=/saifctl/startup.sh`,
        `SAIFCTL_STAGE_SCRIPT=/saifctl/stage.sh`,
      ],
      WorkingDir: '/workspace',
    });

    try {
      // Inject sidecar binary only via putArchive (not baked into user images).
      const sidecarBinary = await getSidecarBinary();
      const tarBuffer = createTarArchive([
        { filename: 'sidecar', content: sidecarBinary, mode: '0000755' },
      ]);
      await container.putArchive(tarBuffer, { path: '/saifctl' });

      await container.start();
      consola.log(`[docker] ${containerName} started`);

      await logStagingContainerNetworkAliases({
        container,
        networkName,
        containerName,
      });

      // New infra state after starting the staging container
      nextInfra = dockerInfraWithContainer(nextInfra, containerName);

      streamContainerLogs({
        container,
        source: 'staging',
        containerLabel: containerName,
        forwardLog: onLog,
      });

      // Wait for sidecar health endpoint
      await waitForContainerReady({ containerName, container, port: containerConfig.sidecarPort });

      const sidecarUrl = `http://staging:${containerConfig.sidecarPort}${containerConfig.sidecarPath}`;
      const targetUrl = containerConfig.baseUrl ?? sidecarUrl;

      return {
        stagingHandle: { targetUrl, sidecarUrl },
        infra: nextInfra,
      };
    } catch (err) {
      // Until nextInfra lists this container, teardown has no snapshot — remove orphan ourselves.
      if (!nextInfra.containers.includes(containerName)) {
        await removeDockerContainerForce(containerName);
      }
      throw err;
    }
  }

  // ── 3. runTests ───────────────────────────────────────────────────────────

  async runTests(opts: RunTestsOpts): Promise<RunTestsEngineResult> {
    const {
      testsDir,
      reportDir,
      testImage,
      testScriptPath,
      stagingHandle,
      feature,
      projectName,
      runId,
      signal,
      onLog,
      infra: infraIn,
    } = opts;

    const infra = assertDockerInfra(infraIn);
    const networkName = infra.networkName;

    assertSafeImageTag(testImage);

    const containerName = `saifctl-test-${projectName}-${runId}`;
    const containerTestsDir = '/tests';
    const containerOutputFile = '/test-runner-output/results.xml';
    const reportPath = join(reportDir, 'results.xml');

    // Single read-only bind of the resolved testsDir to /tests inside the
    // container. Works for both layouts produced by `prepareTestRunnerOpts`:
    //   - Single-source short-circuit: `testsDir` is the source dir directly,
    //     containing `public/`, `hidden/`, `helpers.ts`, `infra.spec.ts`.
    //   - Multi-source merged: `testsDir` is the synthesised dir with
    //     per-source label subtrees `<label>/public/...`, `<label>/helpers.ts`.
    // Vitest's recursive `**/*.spec.ts` discovery handles both. Earlier this
    // was four per-file binds rooted at the testsDir top-level, which broke
    // the moment we introduced label-rooted merging (see test-scope.ts).
    const binds = [
      `${testsDir}:${containerTestsDir}:ro`,
      `${testScriptPath}:/usr/local/bin/test.sh:ro`,
    ];

    consola.log(`[docker] Starting test runner container: ${containerName}`);
    consola.log(`[docker] Test image: ${testImage}`);
    consola.log(`[docker] Target URL: ${stagingHandle.targetUrl}`);
    consola.log(`[docker] Sidecar URL: ${stagingHandle.sidecarUrl}`);

    await logBridgeNetworkEndpoints({
      networkName,
      context: `before test runner ${containerName}`,
    });

    // New infra state after creating the test runner container
    let nextInfra = dockerInfraWithContainer(infra, containerName);

    const container = await docker.createContainer({
      Image: testImage,
      name: containerName,
      HostConfig: {
        NetworkMode: networkName,
        Binds: [...binds, `${reportDir}:/test-runner-output:rw`],
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
      },
      Env: [
        `SAIFCTL_TARGET_URL=${stagingHandle.targetUrl}`,
        `SAIFCTL_SIDECAR_URL=${stagingHandle.sidecarUrl}`,
        `SAIFCTL_FEATURE_NAME=${feature.name}`,
        `SAIFCTL_TESTS_DIR=${containerTestsDir}`,
        `SAIFCTL_OUTPUT_FILE=${containerOutputFile}`,
      ],
      WorkingDir: '/workspace',
    });

    // Bail out before starting if already cancelled — avoids a start + immediate stop cycle.
    if (signal?.aborted) {
      // New infra state after stopping the test runner container
      await container.remove({ force: true }).catch(() => {});
      return {
        tests: { status: 'aborted', stdout: '', stderr: '', rawJunitXml: null },
        infra: dockerInfraWithoutContainer(nextInfra, containerName),
      };
    }

    await container.start();
    consola.log(`[docker] ${containerName} started`);

    streamContainerLogs({
      container,
      source: 'test-runner',
      containerLabel: containerName,
      forwardLog: onLog,
    });

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

    try {
      await container.remove({ force: true });
    } catch (err) {
      consola.warn(`[docker] Warning: could not remove ${containerName}: ${String(err)}`);
    }

    // New infra state after stopping the test runner container
    nextInfra = dockerInfraWithoutContainer(nextInfra, containerName);

    if (aborted) {
      return {
        tests: { status: 'aborted', stdout, stderr, rawJunitXml: null },
        infra: nextInfra,
      };
    }

    const runnerError = detectRunnerError({ exitCode: StatusCode, stdout, stderr });
    if (runnerError) {
      consola.error(`[docker] Test runner error detected: ${runnerError}`);
    }

    // Extract raw JUnit XML from the report file.
    let rawJunitXml: string | null = null;
    if (await pathExists(reportPath)) {
      try {
        rawJunitXml = await readUtf8(reportPath);
      } catch {
        rawJunitXml = null;
      }
    }

    return {
      tests: {
        status: StatusCode === 0 ? 'passed' : 'failed',
        stdout,
        stderr,
        runnerError,
        rawJunitXml,
      },
      infra: nextInfra,
    };
  }

  // ── 4. runAgent ───────────────────────────────────────────────────────────

  async runAgent(opts: RunAgentOpts): Promise<RunAgentEngineResult> {
    const {
      codePath,
      sandboxBasePath,
      containerEnv,
      dangerousNoLeash,
      coderImage,
      saifctlPath,
      reviewer,
      signal,
      onAgentStdout,
      onAgentStdoutEnd,
      onLog,
      runId,
      infra: infraIn,
      inspectMode,
    } = opts;

    const infra = assertDockerInfra(infraIn);
    const networkName = infra.networkName;
    // Same name as {@link DockerEngine.setup} when sandboxBasePath was passed; idempotent append.
    const outInfra = dockerInfraWithContainer(infra, leashTargetContainerName(sandboxBasePath));

    const containerName = leashTargetContainerName(sandboxBasePath);

    // Only for `--dangerous-no-leash`: `docker run` stores CMD in the container config, so
    // `docker start -a` can resume. Leash-managed targets have no CMD / LEASH_ENTRY_COMMAND_B64;
    // pause removes them so a fresh Leash invocation is required (see pauseInfra).
    if (dangerousNoLeash) {
      try {
        const inf = await docker.getContainer(containerName).inspect();
        const st = inf.State?.Status;
        if (st === 'exited' || st === 'created') {
          consola.log(
            `[agent-runner] Resuming existing coder container ${containerName} (state: ${st})`,
          );
          const { exitCode, output } = await runDockerStartAttachCoderContainer({
            containerName,
            signal,
            onAgentStdout,
            onAgentStdoutEnd,
            onLog,
            timeoutMs: AGENT_TIMEOUT_MS,
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            consola.error(`[agent-runner] Process error: ${msg}`);
            return { exitCode: 1, output: msg };
          });
          consola.log(`[agent-runner] Finished with exit code ${exitCode}`);
          return {
            agent: { success: exitCode === 0, exitCode, output },
            infra: outInfra,
          };
        }
      } catch {
        /* no container or inspect failed — fall through to fresh run */
      }
    }

    /** Set for `--dangerous-no-leash` so abort/error can `docker rm -f` the named container. */
    let dockerDirectRunContainerToRemove: string | null = null;

    let cmd: string;
    let args: string[];
    let argsForPrint: string[];
    let spawnCwd: string;
    let spawnEnv: Record<string, string>;

    // ── dangerous-no-leash mode: docker run ──────────────────────────────────────
    if (dangerousNoLeash) {
      assertSafeImageTag(coderImage);

      const codePathHost = await dockerHostBindPath(codePath);
      const saifctlDirHost = await dockerHostBindPath(saifctlPath);

      const dockerRunArgs: string[] = [
        'run',
        // inspect: --rm because the container is driven by stop(), not by pause/resume.
        ...(inspectMode ? ['--rm'] : []),
        '-i',
        '--name',
        containerName,
        '-w',
        CONTAINER_WORKSPACE,
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '-v',
        `${codePathHost}:${CONTAINER_WORKSPACE}`,
        '-v',
        `${saifctlDirHost}:/saifctl:ro`,
      ];

      if (networkName) {
        dockerRunArgs.push('--network', networkName);
      }

      if (reviewer) {
        const argusBinaryHost = await dockerHostBindPath(reviewer.argusBinaryPath);
        dockerRunArgs.push('-v', `${argusBinaryHost}:/usr/local/bin/argus:ro`);
      }

      dockerRunArgs.push(...dockerRunCoderEnvArgs(containerEnv));
      if (inspectMode) {
        const entry = inspectMode.entryCommand ?? ['bash', '-c', 'sleep infinity'];
        dockerRunArgs.push(coderImage, ...entry);
      } else {
        dockerRunArgs.push(coderImage, 'bash', '/saifctl/coder-start.sh');
      }

      argsForPrint = redactDockerRunArgsForPrint(dockerRunArgs, containerEnv);

      cmd = 'docker';
      args = dockerRunArgs;
      spawnCwd = codePathHost;
      spawnEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
        ),
      };

      consola.log('[agent-runner] Mode: dangerous-no-leash (docker run; no Leash/Cedar)');
      consola.log(`[agent-runner] Container name: ${containerName}`);
      consola.log(`[agent-runner] Sandbox mount: ${codePathHost} → ${CONTAINER_WORKSPACE}`);

      await removeDockerContainerForce(containerName);
      dockerDirectRunContainerToRemove = containerName;
    } else {
      // ── leash mode: spawn Leash CLI + network-attach workaround ──────────────────
      const codePathHost = await dockerHostBindPath(codePath);
      const saifctlDirHost = await dockerHostBindPath(saifctlPath);

      const leashArgs: string[] = [
        'leash',
        '--no-interactive',
        '--verbose',
        '--image',
        coderImage,
        '--volume',
        `${codePathHost}:${CONTAINER_WORKSPACE}`,
        '--volume',
        `${saifctlDirHost}:/saifctl:ro`,
      ];

      if (reviewer) {
        const argusBinaryHost = await dockerHostBindPath(reviewer.argusBinaryPath);
        leashArgs.push('--volume', `${argusBinaryHost}:/usr/local/bin/argus:ro`);
      }

      const cedarPolicyPath = join(saifctlPath, SANDBOX_CEDAR_POLICY_BASENAME);
      if (await pathExists(cedarPolicyPath)) {
        const cedarPolicyHost = await dockerHostBindPath(cedarPolicyPath);
        leashArgs.push('--policy', cedarPolicyHost);
        consola.log(`[agent-runner] Cedar policy: ${cedarPolicyHost}`);
      } else {
        throw new Error(`Cedar policy file not found at ${cedarPolicyPath}`);
      }

      pushLeashContainerEnv(leashArgs, containerEnv);
      if (inspectMode) {
        const entry = inspectMode.entryCommand ?? ['bash', '-c', 'sleep infinity'];
        leashArgs.push(...entry);
      } else {
        // Invoke via bash so the script doesn't need +x in the mounted directory.
        // This mirrors how gate.sh and reviewer.sh are invoked inside coder-start.sh.
        leashArgs.push('bash', '/saifctl/coder-start.sh');
      }

      argsForPrint = redactLeashArgsForPrint(leashArgs, containerEnv);

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
        // so we know which container to attach to the SaifCTL network after Leash starts it.
        // See other `WORKAROUND(leash-network)` comments in this file.
        ...(networkName ? { TARGET_CONTAINER: `leash-target-${workspaceId}` } : {}),
        // WORKAROUND(leash-http2): use our patched Leash image that supports HTTP/2 via ALPN.
        // Upstream fix: https://github.com/strongdm/leash/pull/71
        // Local patch: https://github.com/safe-ai-factory/saifctl/issues/73
        // See DEFAULT_LEASH_IMAGE in src/constants.ts for full context and removal steps.
        // Honour any LEASH_IMAGE already set in the environment (e.g. for local testing).
        ...(!process.env.LEASH_IMAGE ? { LEASH_IMAGE: DEFAULT_LEASH_IMAGE } : {}),
      };

      consola.log(`[agent-runner] Mode: leash (container: ${coderImage})`);
      consola.log(`[agent-runner] Sandbox mount: ${codePathHost} → ${CONTAINER_WORKSPACE}`);
    }

    consola.debug(`[agent-runner] containerEnv (public): ${JSON.stringify(containerEnv.env)}`);
    consola.debug(
      `[agent-runner] containerEnv.secret keys: ${Object.keys(containerEnv.secretEnv).sort().join(', ')}`,
    );

    consola.log(`[agent-runner] Starting agent (run ID: ${runId})`);
    consola.log(
      `[agent-runner] Command: ${cmd} ${argsForPrint.map((s) => s.slice(0, 100)).join(' ')}`,
    );

    if (!dangerousNoLeash) {
      await removeDockerContainerForce(containerName);
    }

    // WORKAROUND(leash-network): See full explanation in the original agent-runner.ts.
    // Leash doesn't support a --network flag, so we poll `docker inspect` until the target
    // container appears and then call `docker network connect` to put it on our network.
    const networkAttach =
      !dangerousNoLeash && networkName
        ? startLeashNetworkAttach(networkName, leashWorkspaceId(sandboxBasePath))
        : null;

    const removeDirectDockerContainer = (): void => {
      if (!dockerDirectRunContainerToRemove) return;
      const n = dockerDirectRunContainerToRemove;
      void removeDockerContainerForce(n);
    };

    // ── inspect mode: idle container, return a session handle to the caller ──
    // The caller's onReady() blocks (e.g. waiting for SIGINT) then calls session.stop().
    if (inspectMode) {
      if (signal?.aborted) {
        throw new Error('Agent step cancelled via abort signal');
      }

      const child = spawn(cmd, args, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      const endAgentStdout = (): void => onAgentStdoutEnd?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        onAgentStdout(chunk.toString());
      });
      child.once('close', () => {
        endAgentStdout();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        onLog({ source: 'coder', stream: 'stderr', raw: chunk.toString() });
      });

      let detachAbortListener: (() => void) | null = null;
      let abortPromise: Promise<never> | null = null;
      if (signal) {
        let rejectAbort: ((reason: unknown) => void) | undefined;
        const onAbort = () => {
          networkAttach?.cancel();
          removeDirectDockerContainer();
          child.kill('SIGTERM');
          const abortReason = signal?.reason != null ? ` (reason: ${String(signal.reason)})` : '';
          rejectAbort?.(new Error(`Agent step cancelled via abort signal${abortReason}`));
        };
        abortPromise = new Promise<never>((_, reject) => {
          rejectAbort = reject;
          signal.addEventListener('abort', onAbort, { once: true });
        });
        detachAbortListener = () => signal.removeEventListener('abort', onAbort);
      }

      const waitReady = (async () => {
        await waitForContainerRunning(containerName, 180_000);
        if (!dangerousNoLeash && networkName) {
          await waitForContainerOnNetwork({ networkName, containerName, timeoutMs: 90_000 });
        }
      })();

      try {
        await (abortPromise ? Promise.race([waitReady, abortPromise]) : waitReady);
      } catch (err) {
        networkAttach?.cancel();
        if (detachAbortListener !== null) detachAbortListener();
        if (!child.killed) child.kill('SIGTERM');
        removeDirectDockerContainer();
        throw err;
      }

      if (detachAbortListener !== null) detachAbortListener();
      consola.log(
        `[agent-runner] Ready — container ${containerName}, workspace ${CONTAINER_WORKSPACE}`,
      );

      let containerId: string | null = null;
      try {
        const inf = await docker.getContainer(containerName).inspect();
        if (typeof inf.Id === 'string' && inf.Id.trim()) {
          containerId = inf.Id.trim();
        }
      } catch (e) {
        consola.warn(
          `[agent-runner] Could not resolve Docker container Id for "${containerName}" `,
          e,
        );
      }

      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        networkAttach?.cancel();
        const directName = dockerDirectRunContainerToRemove;
        if (directName) {
          await removeDockerContainerForce(directName);
          dockerDirectRunContainerToRemove = null;
        }
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 3_000);
            child.once('close', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        // Leash path does not set dockerDirectRunContainerToRemove; ensure the target is gone
        // so teardown can remove the bridge (same name as no-leash for Dev Container parity).
        await removeDockerContainerForce(containerName);
      };

      const inspectInfra = dockerInfraWithContainer(infra, containerName);
      const session: CoderInspectSessionHandle = {
        containerName,
        containerId,
        workspacePath: CONTAINER_WORKSPACE,
        stop,
      };

      try {
        await inspectMode.onReady(session, { codePath });
      } finally {
        await session.stop();
      }
      return { agent: { success: true, exitCode: 0, output: '' }, infra: inspectInfra };
    }

    // ── normal agent run ─────────────────────────────────────────────────────
    const timeoutMs = AGENT_TIMEOUT_MS;

    const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
      (resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: spawnCwd,
          env: spawnEnv,
          stdio: ['inherit', 'pipe', 'pipe'],
        });

        let collected = '';
        const endAgentStdout = (): void => onAgentStdoutEnd?.();

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          collected += text;
          onAgentStdout(text);
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          onLog({ source: 'coder', stream: 'stderr', raw: text });
          collected += text;
        });

        const timer = setTimeout(() => {
          child.kill();
          removeDirectDockerContainer();
          reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          clearTimeout(timer);
          networkAttach?.cancel();
          const pause = signal?.reason === SAIFCTL_PAUSE_ABORT_REASON;
          if (!pause) {
            removeDirectDockerContainer();
          }
          const abortReason = signal?.reason != null ? ` (reason: ${String(signal.reason)})` : '';
          reject(new Error(`Agent step cancelled via abort signal${abortReason}`));
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
          removeDirectDockerContainer();
          endAgentStdout();
          reject(err);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          networkAttach?.cancel();
          const pauseKeep =
            signal?.aborted === true && signal.reason === SAIFCTL_PAUSE_ABORT_REASON;
          if (dockerDirectRunContainerToRemove && !pauseKeep) {
            void removeDockerContainerForce(dockerDirectRunContainerToRemove);
          }
          endAgentStdout();
          resolve({ exitCode: code ?? 1, output: collected });
        });
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error(`[agent-runner] Process error: ${msg}`);
      return { exitCode: 1, output: msg };
    });

    consola.log(`[agent-runner] Finished with exit code ${exitCode}`);
    return {
      agent: { success: exitCode === 0, exitCode, output },
      infra: outInfra,
    };
  }

  async pauseInfra(opts: EnginePauseInfraOpts): Promise<void> {
    const { sandboxBasePath, infra: infraIn } = opts;
    const infra = assertDockerInfra(infraIn);

    // Pause docker-compose file
    if (infra.composeProjectName && infra.composeFile) {
      const absoluteFile = resolve(infra.projectDir, infra.composeFile);
      try {
        await runDocker(['compose', '-p', infra.composeProjectName, '-f', absoluteFile, 'pause'], {
          stdio: 'inherit',
        });
      } catch (err) {
        consola.warn(`[docker] compose pause failed (non-fatal): ${String(err)}`);
      }
    }

    // Remove Leash target + manager containers so resume always re-runs Leash (docker start
    // cannot revive Leash targets: no CMD, command comes from the Leash parent + /leash volume).
    const targetName = leashTargetContainerName(sandboxBasePath);
    const managerName = leashManagerContainerName(sandboxBasePath);
    await removeDockerContainerForce(managerName);
    await removeDockerContainerForce(targetName);

    consola.log(
      '[docker] Paused coding infra (coder container removed; compose paused if configured; file changes preserved).',
    );
  }

  async resumeInfra(opts: EngineResumeInfraOpts): Promise<void> {
    const { runId, projectDir, sandboxBasePath } = opts;

    // Defensive: stale exited containers after crash or old pause behavior would block Leash `docker run --name`.
    await killSandboxCoderContainerBestEffort(sandboxBasePath);

    if (!this.composeFile) {
      consola.log('[docker] No compose file configured — skipping compose resume.');
      return;
    }

    // Resume docker-compose file
    const composeProjectName = `saifctl-${runId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const absoluteFile = resolve(projectDir, this.composeFile);
    try {
      await runDocker(['compose', '-p', composeProjectName, '-f', absoluteFile, 'unpause'], {
        stdio: 'inherit',
      });
      consola.log(
        `[docker] Compose project "${composeProjectName}" unpaused (file: ${absoluteFile})`,
      );
    } catch (err) {
      consola.warn(`[docker] Warning: compose unpause failed (non-fatal): ${String(err)}`);
    }
  }

  async verifyInfraToResume(opts: EngineVerifyResumeInfraOpts): Promise<boolean> {
    const infra = assertDockerInfra(opts.infra);

    // Verify the bridge network is still present.
    const listed = await docker.listNetworks({ filters: { name: [infra.networkName] } });
    if (!listed.some((n) => n.Name === infra.networkName)) {
      return false;
    }

    // After pause, Leash target + manager containers are removed intentionally; only the bridge
    // network (and compose stack) must persist for run resume.

    // NOTE: No need to check for `DockerLiveInfra.stagingImages`,
    // we create them on the spot and track them only for cleanup.
    return true;
  }

  // ── 5. teardown ───────────────────────────────────────────────────────────

  async teardown(opts: EngineTeardownOpts): Promise<void> {
    const { infra: infraIn, projectDir, runId } = opts;
    if (infraIn === null) {
      consola.warn(
        `[docker] teardown skipped for runId "${runId}" — no live infra snapshot ` +
          `(setup may not have completed). Resources may be left behind.`,
      );
      return;
    }
    const infra = assertDockerInfra(infraIn);

    // Remove containers and staging images
    for (const name of infra.containers) {
      await removeDockerContainerForce(name);
    }

    for (const tag of infra.stagingImages) {
      await removeDockerImage(tag);
    }

    // Tear down compose stack
    const pd = infra.projectDir || projectDir;
    if (infra.composeProjectName && infra.composeFile) {
      const absoluteFile = resolve(pd, infra.composeFile);
      if (await pathExists(absoluteFile)) {
        // First we need to try to unpause the stack
        // Docker Compose has a quirk: 'compose down' silently skips containers
        // that are in a paused state — it cannot stop or remove them while
        // they're paused because pausing freezes the container's process
        // at the kernel level (via cgroups freezer). The 'down' command only stops
        // running containers, not frozen ones.
        try {
          await runDocker(
            ['compose', '-p', infra.composeProjectName, '-f', absoluteFile, 'unpause'],
            {
              stdio: 'pipe',
            },
          );
        } catch {
          // ignore — stack may not exist or nothing paused
        }

        // Now the actual 'compose down'
        consola.log(`[docker] Tearing down compose project "${infra.composeProjectName}"`);
        try {
          await runDocker(
            [
              'compose',
              '-p',
              infra.composeProjectName,
              '-f',
              absoluteFile,
              'down',
              '-v',
              '--remove-orphans',
            ],
            { stdio: 'inherit' },
          );
          consola.log(`[docker] Compose project "${infra.composeProjectName}" down`);
        } catch (err) {
          consola.warn(
            `[docker] Warning: failed to tear down compose project "${infra.composeProjectName}": ${String(err)}`,
          );
        }
      }
    }

    // Delete network as last, after everything else has been removed
    if (infra.networkName) {
      await removeDockerNetwork(infra.networkName);
    }
  }
}

// ---------------------------------------------------------------------------
// Coding container/image
// ---------------------------------------------------------------------------

const AGENT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Re-attach to a stopped coder container after `run pause` (`docker start -a -i`).
 */
async function runDockerStartAttachCoderContainer(opts: {
  containerName: string;
  signal: AbortSignal | null;
  onAgentStdout: (chunk: string) => void;
  onAgentStdoutEnd?: () => void;
  onLog: EngineOnLog;
  timeoutMs: number;
}): Promise<{ exitCode: number; output: string }> {
  const { containerName, signal, onAgentStdout, onAgentStdoutEnd, onLog, timeoutMs } = opts;
  return await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    const child = spawn('docker', ['start', '-a', '-i', containerName], {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let collected = '';
    const endAgentStdout = (): void => onAgentStdoutEnd?.();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      collected += text;
      onAgentStdout(text);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      onLog({ source: 'coder', stream: 'stderr', raw: text });
      collected += text;
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      clearTimeout(timer);
      if (signal?.reason !== SAIFCTL_PAUSE_ABORT_REASON) {
        void removeDockerContainerForce(containerName);
      }
      const abortReason = signal?.reason != null ? ` (reason: ${String(signal.reason)})` : '';
      reject(new Error(`Agent step cancelled via abort signal${abortReason}`));
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
      endAgentStdout();
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      endAgentStdout();
      const pauseKeep = signal?.aborted === true && signal.reason === SAIFCTL_PAUSE_ABORT_REASON;
      if (!pauseKeep) {
        void removeDockerContainerForce(containerName);
      }
      resolve({ exitCode: code ?? 1, output: collected });
    });
  });
}

// ---------------------------------------------------------------------------
// Staging container/image
// ---------------------------------------------------------------------------

async function buildStagingImage(opts: {
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

// ---------------------------------------------------------------------------
// Leash
// ---------------------------------------------------------------------------

function leashWorkspaceId(sandboxBasePath: string): string {
  const segments = sandboxBasePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const tail = segments.slice(-2).join('-');
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 40);
}

/**
 * Docker container name for the coder target when `TARGET_CONTAINER` is set for Leash
 * (`leash-target-<workspaceId>`). Used for `--dangerous-no-leash` so names match Leash runs.
 *
 * Exported so callers (e.g. sandbox teardown on stale-dir cleanup) can stop the container
 * by name without needing a live infra snapshot.
 */
export function leashTargetContainerName(sandboxBasePath: string): string {
  return `leash-target-${leashWorkspaceId(sandboxBasePath)}`;
}

/**
 * Leash manager container name (`defaultContainerBaseNames` in leash: `{target}-leash`).
 * Shares the target's network namespace (`--network container:<target>`).
 */
export function leashManagerContainerName(sandboxBasePath: string): string {
  return `${leashTargetContainerName(sandboxBasePath)}-leash`;
}

/** Best-effort: remove Leash manager + coder target containers for a sandbox path. */
export async function killSandboxCoderContainerBestEffort(sandboxBasePath: string): Promise<void> {
  const manager = leashManagerContainerName(sandboxBasePath);
  const target = leashTargetContainerName(sandboxBasePath);
  try {
    await docker.getContainer(manager).remove({ force: true });
  } catch {
    /* absent or Docker unavailable */
  }
  try {
    await docker.getContainer(target).remove({ force: true });
  } catch {
    /* absent or Docker unavailable */
  }
}

/**
 * Resolves from the package tree that contains this module (where `@safe-ai-factory/saifctl` is installed).
 * Sandbox cwd is not the project dir, so we do not rely on `process.cwd()` for Leash.
 */
const requireLeash = createRequire(import.meta.url);

/**
 * Leash is invoked via its NPM binary. `@safe-ai-factory/saifctl` pulls in `@strongdm/leash`;
 * callers run from the sandbox dir, so we resolve the binary from this package's `node_modules`.
 *
 * Override with `SAIFCTL_LEASH_BIN` (absolute path to `leash.js`).
 */
export function resolveLeashCliPath(): string {
  const override = process.env.SAIFCTL_LEASH_BIN?.trim();
  if (override) {
    return override;
  }
  try {
    return requireLeash.resolve('@strongdm/leash/bin/leash.js');
  } catch {
    throw new Error(
      'Cannot find @strongdm/leash. Run install in the project that depends on @safe-ai-factory/saifctl, ' +
        `or set SAIFCTL_LEASH_BIN to the absolute path of leash.js.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility: LiveInfra object
// ---------------------------------------------------------------------------

function assertDockerInfra(infra: LiveInfra): DockerLiveInfra {
  if (infra.engine !== 'docker') {
    throw new Error('[docker] Expected Docker live infra for this operation');
  }
  return infra as DockerLiveInfra;
}

function dockerInfraWithContainer(infra: DockerLiveInfra, name: string): DockerLiveInfra {
  if (infra.containers.includes(name)) return infra;
  return { ...infra, containers: [...infra.containers, name] };
}

function dockerInfraWithStagingImage(infra: DockerLiveInfra, tag: string): DockerLiveInfra {
  return { ...infra, stagingImages: [...infra.stagingImages, tag] };
}

function dockerInfraWithoutContainer(infra: DockerLiveInfra, name: string): DockerLiveInfra {
  return { ...infra, containers: infra.containers.filter((c) => c !== name) };
}

// ---------------------------------------------------------------------------
// Utility: Networks
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

async function resolveDockerNetworkByName(networkName: string) {
  const listed = await docker.listNetworks({ filters: { name: [networkName] } });
  const match = listed.find((n) => n.Name === networkName) ?? listed[0];
  if (!match) return null;
  return docker.getNetwork(match.Id);
}

// ---------------------------------------------------------------------------
// Utility: Containers
// ---------------------------------------------------------------------------

/** Best-effort `docker rm -f` equivalent (ignores missing container / races). */
async function removeDockerContainerForce(nameOrId: string): Promise<void> {
  try {
    await docker.getContainer(nameOrId).remove({ force: true });
  } catch {
    /* absent, --rm race, etc. */
  }
}

async function isDockerContainerRunning(nameOrId: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(nameOrId).inspect();
    return Boolean(info.State?.Running);
  } catch {
    return false;
  }
}

async function connectContainerToBridgeNetwork(opts: {
  networkName: string;
  containerIdOrName: string;
  aliases?: string[];
}): Promise<void> {
  const { networkName, containerIdOrName, aliases } = opts;
  const net = await resolveDockerNetworkByName(networkName);
  if (!net) {
    throw new Error(`[docker] Network not found: "${networkName}"`);
  }
  if (aliases?.length) {
    await net.connect({
      Container: containerIdOrName,
      EndpointConfig: { Aliases: aliases },
    });
  } else {
    await net.connect({ Container: containerIdOrName });
  }
}

// ---------------------------------------------------------------------------
// Utility: Images
// ---------------------------------------------------------------------------

function assertSafeImageTag(tag: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    throw new Error(
      `[docker] Unsafe image tag rejected: "${tag}". ` +
        `Tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @ signs.`,
    );
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
// Utility: Docker compose
// ---------------------------------------------------------------------------

/**
 * Lists service names for a compose project (`docker compose ps --services`).
 * Used to discover which containers to attach to the SaifCTL bridge network.
 */
async function listComposeServices(opts: {
  composeProjectName: string;
  absoluteFile: string;
}): Promise<string[]> {
  const { composeProjectName, absoluteFile } = opts;
  try {
    const { stdout } = await runDocker([
      'compose',
      '-p',
      composeProjectName,
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

/**
 * Connects every compose service container to the given bridge network with a stable alias
 * (the service name) so other containers on that network can reach Postgres, Redis, etc. by hostname.
 */
async function attachComposeSvcToNetwork(opts: {
  composeProjectName: string;
  absoluteFile: string;
  networkName: string;
}): Promise<void> {
  const { composeProjectName, absoluteFile, networkName } = opts;
  const serviceNames = await listComposeServices({ composeProjectName, absoluteFile });
  for (const service of serviceNames) {
    try {
      const { stdout } = await runDocker([
        'compose',
        '-p',
        composeProjectName,
        '-f',
        absoluteFile,
        'ps',
        '-q',
        service,
      ]);
      const containerId = stdout.trim();
      if (!containerId) continue;

      await connectContainerToBridgeNetwork({
        networkName,
        containerIdOrName: containerId,
        aliases: [service],
      });
      consola.log(
        `[docker] Connected compose service "${service}" (${containerId}) to network "${networkName}"`,
      );
    } catch (err) {
      consola.warn(
        `[docker] Warning: could not attach compose service "${service}" to network "${networkName}": ${String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// WORKAROUND(leash-network): post-start polling + network attach
//
// Leash doesn't support a --network flag. We set TARGET_CONTAINER (Leash's own env var
// for overriding the target container name) to a predictable value so we know which
// container to attach to the SaifCTL bridge network after Leash starts it. We then
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
      if (await isDockerContainerRunning(containerName)) {
        consola.log(
          `[agent-runner] Attaching container "${containerName}" to network "${networkName}"...`,
        );
        await connectContainerToBridgeNetwork({ networkName, containerIdOrName: containerName });
        consola.log(`[agent-runner] Container "${containerName}" attached to "${networkName}".`);
        return;
      }
    } catch {
      // Container doesn't exist yet or connect failed — retry
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
// Sidecar binary loader
// ---------------------------------------------------------------------------

let sidecarBinaryCache: Buffer | null = null;

// TODO - PUBLISH SIDECAR SO BINARY AVAIL VIA URL. DOWNLOAD AND MOUNT OF BINARY IS DOCKER-SPECIFIC
// TODO - PUBLISH SIDECAR SO BINARY AVAIL VIA URL. DOWNLOAD AND MOUNT OF BINARY IS DOCKER-SPECIFIC
// TODO - PUBLISH SIDECAR SO BINARY AVAIL VIA URL. DOWNLOAD AND MOUNT OF BINARY IS DOCKER-SPECIFIC
async function getSidecarBinary(): Promise<Buffer> {
  // Loaded lazily to avoid blocking startup.
  if (sidecarBinaryCache) return sidecarBinaryCache;

  const hostArch = arch();
  const binaryName = hostArch === 'arm64' ? 'sidecar-linux-arm64' : 'sidecar-linux-amd64';
  const binaryPath = join(
    getSaifctlRoot(),
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

// ---------------------------------------------------------------------------
// Utility: Container polling
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls container inspect (dockerode) until `State.Running` is true.
 * Used right after `docker run` / Leash starts the coder target: the process may return before
 * the container transitions to running, and inspect can briefly fail if the name is not visible yet.
 */
async function waitForContainerRunning(containerName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDockerContainerRunning(containerName)) return;
    await sleep(300);
  }
  throw new Error(
    `[inspect-session] Timeout after ${timeoutMs}ms waiting for container "${containerName}" to run`,
  );
}

/**
 * Waits until Docker reports the given container as connected to the named bridge network.
 * After `docker network connect` (or equivalent), attachment can lag; staging/compose services
 * on that network are only reachable once the endpoint appears on the network’s container list.
 */
async function waitForContainerOnNetwork(opts: {
  networkName: string;
  containerName: string;
  timeoutMs: number;
}): Promise<void> {
  const { networkName, containerName, timeoutMs } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const listed = await docker.listNetworks({ filters: { name: [networkName] } });
      const match = listed.find((n) => n.Name === networkName) ?? listed[0];
      if (!match) {
        await sleep(250);
        continue;
      }
      const data = await docker.getNetwork(match.Id).inspect();
      const containers = data.Containers ?? {};
      const connected = Object.values(containers).some(
        (c) => (c.Name ?? '').replace(/^\//, '') === containerName,
      );
      if (connected) return;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(
    `[inspect-session] Timeout after ${timeoutMs}ms waiting for "${containerName}" on network "${networkName}"`,
  );
}

/**
 * Waits until the container is ready.
 *
 * Checks the container's health endpoint.
 */
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
// Utility: Logging
// ---------------------------------------------------------------------------

/**
 * Split a single Docker API log buffer into stdout vs stderr text.
 *
 * Docker multiplexes both streams into one binary payload: each frame is an 8-byte header
 * (stream type + payload length) followed by UTF-8 bytes. This is used when logs are fetched
 * as a bounded buffer (e.g. after a container exits), not for live `follow: true` streaming
 * where we already demux via `dockerode.modem.demuxStream`.
 */
function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  if (!Buffer.isBuffer(buffer)) return { stdout: String(buffer), stderr: '' };

  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    // Docker frame: 8-byte header (stream id byte + padding, then big-endian payload length).
    if (offset + 8 > buffer.length) break;
    const streamType = buffer[offset]; // 1 = stdout, 2 = stderr (other types ignored)
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break; // truncated buffer — stop cleanly
    const payload = buffer.slice(offset, offset + size).toString('utf8');
    offset += size;
    if (streamType === 1) stdout += payload;
    else if (streamType === 2) stderr += payload;
  }

  return { stdout, stderr };
}

/**
 * Builds a one-line summary of `NetworkSettings.Networks` for logs: whether the SaifCTL bridge
 * is present, DNS aliases, and IP (helps debug “staging not reachable” / wrong network).
 */
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

/**
 * After staging starts, logs how that container is attached to the SaifCTL network (aliases + IP).
 * Confirms DNS names like `staging` resolve as expected for the test runner.
 */
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

/**
 * Logs all endpoints on a bridge network (container name + IPv4) before tests or similar steps.
 * High-signal when debugging ENOTFOUND/ECONNREFUSED between compose services, staging, and runners.
 */
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

function streamContainerLogs(opts: {
  container: Docker.Container;
  source: EngineLogSource;
  containerLabel: string;
  forwardLog: EngineOnLog;
}): void {
  const { container, source, containerLabel, forwardLog } = opts;
  void container
    .logs({ follow: true, stdout: true, stderr: true, timestamps: false })
    .then((stream: NodeJS.ReadableStream) => {
      const out = new PassThrough();
      const err = new PassThrough();
      docker.modem.demuxStream(stream, out, err);

      const makeHandler = (streamKind: 'stdout' | 'stderr') => {
        let buf = '';
        const onData = (chunk: Buffer | string) => {
          buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line) {
              forwardLog({
                source,
                stream: streamKind,
                containerLabel,
                raw: line,
              });
            }
          }
        };
        const onEnd = () => {
          if (buf) {
            forwardLog({
              source,
              stream: streamKind,
              containerLabel,
              raw: buf,
            });
            buf = '';
          }
        };
        return { onData, onEnd };
      };

      const stdoutH = makeHandler('stdout');
      const stderrH = makeHandler('stderr');
      out.on('data', stdoutH.onData);
      out.on('end', stdoutH.onEnd);
      err.on('data', stderrH.onData);
      err.on('end', stderrH.onEnd);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Utility: Environment variables
// ---------------------------------------------------------------------------

/** `-eKEY=VALUE` flags for `docker run`. */
function dockerRunCoderEnvArgs(c: ContainerEnv): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(c.env)) out.push(`-e${k}=${v}`);
  for (const [k, v] of Object.entries(c.secretEnv)) out.push(`-e${k}=${v}`);
  return out;
}

function pushLeashContainerEnv(leashArgs: string[], c: ContainerEnv): void {
  for (const [k, v] of Object.entries(c.env)) {
    leashArgs.push('--env', `${k}=${v}`);
  }
  for (const [k, v] of Object.entries(c.secretEnv)) {
    leashArgs.push('--env', `${k}=${v}`);
  }
}

/** Log / debug copy of `docker run` `-eKEY=VALUE` flags: secrets → `****`, task body → length only. */
function redactDockerRunArgsForPrint(args: string[], c: ContainerEnv): string[] {
  const secretKeys = new Set(Object.keys(c.secretEnv));
  return args.map((a) => {
    if (!a.startsWith('-e')) return a;
    const eq = a.indexOf('=');
    if (eq <= 2) return a;
    const k = a.slice(2, eq);
    if (secretKeys.has(k)) return `-e${k}=****`;
    if (k === 'SAIFCTL_INITIAL_TASK') return `-e${k}=<task (${a.length - eq - 1} chars)>`;
    return a;
  });
}

/** Log-safe view of Leash argv env fragments (`KEY=VALUE` tokens): same redaction rules as {@link redactDockerRunArgsForPrint}. */
function redactLeashArgsForPrint(leashArgs: string[], c: ContainerEnv): string[] {
  const secretKeys = new Set(Object.keys(c.secretEnv));
  return leashArgs.map((a) => {
    if (!a.includes('=')) return a;
    const eq = a.indexOf('=');
    const k = a.slice(0, eq);
    if (secretKeys.has(k)) return `${k}=****`;
    if (k === 'SAIFCTL_INITIAL_TASK') return `${k}=<task (${a.length - eq - 1} chars)>`;
    return a;
  });
}

// ---------------------------------------------------------------------------
// Other utilities
// ---------------------------------------------------------------------------

/**
 * Resolve symlinks on the host path before passing to `docker run -v`.
 * On macOS, `/tmp` often symlinks to `/private/tmp`; mixing non-canonical paths with
 * Colima/Docker Desktop bind mounts can yield empty mounts (e.g. `/saifctl/startup.sh` missing).
 * Leash also uses `getcwd()` as `callerDir`; keep {@link spawn} `cwd` aligned with the same path.
 */
async function dockerHostBindPath(hostPath: string): Promise<string> {
  try {
    return await realpath(hostPath);
  } catch {
    return hostPath;
  }
}
