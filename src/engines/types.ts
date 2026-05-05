/**
 * Engine interface — lifecycle contract for infrastructure adaptors.
 *
 * An Engine manages the full lifecycle of an isolated SaifCTL run environment:
 *   1. setup()        — create an isolated network + start background services (databases, etc.)
 *   2. startStaging() — build & boot the application under test (Container A) with sidecar
 *   3. runTests()     — run test runner (black-box tests) (Container B) and return results
 *   4. runAgent()     — spawn the AI coding agent container and return when it exits
 *   5. teardown()     — stop and remove all resources listed in {@link LiveInfra}
 *
 * DockerEngine is the concrete implementation for Docker (with optional Compose services).
 * A HelmEngine would implement the same interface using Kubernetes.
 */

import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';
import type { DockerLiveInfra } from './docker/types.js';
import type { LocalLiveInfra } from './local/types.js';
import type { EngineOnLog } from './logs.js';

export type { DockerLiveInfra } from './docker/types.js';
export type { LocalLiveInfra } from './local/types.js';
export type { EngineLogEvent, EngineLogSource, EngineOnLog } from './logs.js';

/** Engine-specific snapshot of provisioned infra for a run; the `engine` discriminator selects the variant. */
export type LiveInfra = DockerLiveInfra | LocalLiveInfra | { engine: EngineName };

/** Identifier of a concrete {@link Engine} implementation. */
export type EngineName = 'docker' | 'local' | 'helm';

// ---------------------------------------------------------------------------
// Shared value objects (implementation-agnostic)
// ---------------------------------------------------------------------------

/**
 * Returned by startStaging(). Carries the abstract addressing information
 * (URLs) the test runner needs to talk to the staging app.
 * Implementation-agnostic.
 */
export interface StagingHandle {
  /** URL where the staging app can be reached (from inside the environment). */
  targetUrl: string;
  /** URL where the injected sidecar HTTP server can be reached. */
  sidecarUrl: string;
}

/** Outcome of a test run (mutually exclusive). */
export type TestRunStatus = 'passed' | 'failed' | 'aborted';

/** Raw test result from an engine. */
export interface TestsResult {
  status: TestRunStatus;
  stderr: string;
  stdout: string;
  /**
   * Set when the test runner itself crashed before producing any test signal
   * (e.g. missing test files, syntax errors, missing imports).
   */
  runnerError?: string;
  /**
   * Raw JUnit XML from the test report file, if read successfully.
   * Orchestrator parses with `parseJUnitXmlString`.
   */
  rawJunitXml: string | null;
}

/** Parsed JUnit `<testsuite>` row — name + aggregate status plus the contained {@link AssertionResult}s. */
export interface AssertionSuiteResult {
  name: string;
  status: string;
  assertionResults: AssertionResult[];
}

/** Parsed JUnit `<testcase>` row: titles, status, and split failure-message vs. failure-type lists for safe forwarding. */
export interface AssertionResult {
  title: string;
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo';
  ancestorTitles: string[];
  /** Raw failure message — NOT forwarded to the vague-specs-check (prompt-injection risk). */
  failureMessages: string[];
  /** Error types from JUnit <failure type="...">. Safe to pass to the vague-specs-check. */
  failureTypes: string[];
}

/** Outcome of a single coding-agent process — exit code, success flag, and the combined stdout/stderr text. */
export interface AgentResult {
  success: boolean;
  exitCode: number;
  /** Combined stdout + stderr from the agent process. */
  output: string;
}

// ---------------------------------------------------------------------------
// Engine method results (infra threading)
// ---------------------------------------------------------------------------

/** Result of {@link Engine.setup} — the initial infra snapshot to thread through later calls. */
export interface EngineSetupResult {
  infra: LiveInfra;
}

/** Result of {@link Engine.startStaging} — the staging URLs plus the updated infra snapshot. */
export interface StartStagingResult {
  stagingHandle: StagingHandle;
  infra: LiveInfra;
}

/** Result of {@link Engine.runTests} — raw test outcome plus the updated infra snapshot. */
export interface RunTestsEngineResult {
  tests: TestsResult;
  infra: LiveInfra;
}

/** Result of {@link Engine.runAgent} — coding-agent outcome plus the updated infra snapshot. */
export interface RunAgentEngineResult {
  agent: AgentResult;
  infra: LiveInfra;
}

/** Result of starting an inspect session — the live session handle plus the updated infra snapshot. */
export interface StartInspectResult {
  session: CoderInspectSessionHandle;
  infra: LiveInfra;
}

// ---------------------------------------------------------------------------
// Method option types
// ---------------------------------------------------------------------------

/** Inputs for {@link Engine.setup} — run + project identity, host project dir, and (Docker only) the sandbox base path used to derive the coder container name. */
export interface EngineSetupOpts {
  runId: string;
  projectName: string;
  featureName: string;
  /** Absolute path to the host project root (used to resolve relative compose files, etc.). */
  projectDir: string;
  /**
   * Docker Engine uses this to derive the name of the Leash coder container.
   *
   * {@link DockerEngine.setup} (coding or inspect) appends the deterministic
   * coder container name to the returned {@link DockerLiveInfra.containers} list as soon as
   * the bridge network (and optional compose stack) exists,
   * **before** {@link Engine.runAgent} runs.
   *
   * That way {@link CleanupRegistry} `getInfra()` and {@link Engine.teardown} can still
   * `docker rm -f` the coder if `runAgent` throws or the process is signalled after
   * the container exists but before `runAgent` returns an updated infra snapshot.
   *
   * Staging engines omit this. {@link LocalEngine} ignores it.
   */
  sandboxBasePath?: string;
}

/** NormalizedStagingEnvironment shape re-declared inline to avoid circular deps. */
export interface StagingAppConfig {
  sidecarPort: number;
  sidecarPath: string;
  baseUrl?: string;
  build?: { dockerfile?: string };
}

/** Engine-facing view of the resolved staging environment — engine name, app config, env vars, and an optional compose file. */
export interface NormalizedStagingEnvironmentRef {
  engine: string;
  app: StagingAppConfig;
  appEnvironment: Record<string, string>;
  /** Present when a Docker Compose file is configured for ephemeral services. */
  file?: string;
}

/** Inputs for {@link Engine.startStaging}: sandbox/code paths, the staging environment ref, log sink, and the prior infra snapshot. */
export interface StartStagingOpts {
  /** Same logical run id as {@link Engine.setup} (container / image naming). */
  runId: string;
  sandboxProfileId: SupportedSandboxProfileId;
  /** Absolute path to the sandbox code directory on the host. */
  codePath: string;
  /** Absolute path to the project directory (used to resolve custom Dockerfiles). */
  projectDir: string;
  stagingEnvironment: NormalizedStagingEnvironmentRef;
  feature: Feature;
  projectName: string;
  /**
   * Absolute host path to the sandbox `saifctl/` bundle directory.
   * Mounted read-only at `/saifctl` in the staging container (same layout as coder).
   */
  saifctlPath: string;
  /** Infra log lines from the staging container "follow" (-f) stream (stdout/stderr). */
  onLog: EngineOnLog;
  /** Infra state from {@link Engine.setup}; updated with staging container + image. */
  infra: LiveInfra;
}

/**
 * Environment variables for the coder container, split by log sensitivity.
 * Engines merge both into the real process/container; logging may show
 * public `env` key+value and only secret key names for `secretEnv`.
 */
export interface ContainerEnv {
  env: Record<string, string>;
  secretEnv: Record<string, string>;
}

/** Inputs for {@link Engine.runTests}: tests/report dirs, runner image + script, the staging handle to target, abort signal, and log sink. */
export interface RunTestsOpts {
  /** Absolute path to the feature's tests/ directory on the host. */
  testsDir: string;
  /**
   * Absolute path to a host directory where the test runner writes results.xml
   * (bind-mounted to /test-runner-output inside the container).
   */
  reportDir: string;
  /** Test runner image tag (e.g. 'saifctl-test-node-vitest:latest'). */
  testImage: string;
  /**
   * Absolute host path to test.sh, always bind-mounted at
   * /usr/local/bin/test.sh inside the Test Runner container (read-only).
   */
  testScriptPath: string;
  /** Used to derive SAIFCTL_TARGET_URL and SAIFCTL_SIDECAR_URL for the test runner. */
  stagingHandle: StagingHandle;
  feature: Feature;
  projectName: string;
  runId: string;
  /**
   * Optional abort signal. When fired, the test runner container is stopped
   * immediately and the result is returned with status='aborted'.
   */
  signal?: AbortSignal;
  /** Infra log lines from the test-runner container "follow" (-f) stream (stdout/stderr). */
  onLog: EngineOnLog;
  /** From {@link startStaging}; test runner container names appended then removed when the container exits. */
  infra: LiveInfra;
}

/** Inputs for {@link Engine.runAgent}: sandbox/code paths, container env (public + secret), coder image, optional reviewer/inspect modes, and stream callbacks. */
export interface RunAgentOpts {
  /** Absolute path to the sandbox code directory (host path). */
  codePath: string;
  /**
   * Absolute path to the sandbox base directory (host path).
   * Used to derive the Leash workspace id.
   */
  sandboxBasePath: string;
  /**
   * Pre-built container environment (public + secret). Assembled by the orchestrator.
   * The engine only forwards it into Docker/Leash.
   */
  containerEnv: ContainerEnv;
  /**
   * When true, run the coder container via `docker run` (no Leash CLI). Same mounts/env/name as Leash.
   */
  dangerousNoLeash: boolean;
  /** Docker image for the coder container. */
  coderImage: string;
  /**
   * Absolute host path to the sandbox `saifctl/` bundle (mounted read-only at `/saifctl` in the container).
   * For Leash, the Docker engine uses `<saifctlPath>/policy.cedar` as `--policy` (materialized with the sandbox).
   */
  saifctlPath: string;
  /**
   * Raw stdout chunks from the agent container. Separate from onLog because these logs
   * may have agent-specific log formatting applied to them.
   */
  onAgentStdout: (chunk: string) => void;
  /** When the child stdout stream ends, flush any buffered state. */
  onAgentStdoutEnd?: () => void;
  /**
   * Raw stderr chunks from the agent container + other non-agent logs.
   * These logs are not agent-specific.
   */
  onLog: EngineOnLog;
  /**
   * When set, mount the argus binary for the semantic reviewer. Reviewer LLM env vars live in `containerEnv`.
   */
  reviewer: { argusBinaryPath: string } | null;
  /**
   * Optional abort signal. When fired (e.g. Hatchet step cancellation), the
   * agent child process is killed immediately and teardown() is still called
   * by the caller's finally block.
   */
  signal: AbortSignal | null;
  /** Logical run id (logging; must match {@link Engine.setup} for this attempt). */
  runId: string;
  /** From {@link Engine.setup} (and any prior steps); coder container name appended on fresh run. */
  infra: LiveInfra;
  /**
   * When set, run the container in idle mode instead of the coding agent script.
   *
   * The engine starts the container, waits until it is ready, then calls `onReady` with the
   * session handle and the sandbox code path. `onReady` is expected to block (e.g. await a user
   * signal) and call `session.stop()` before returning. `runAgent` then returns a synthetic
   * success result.
   *
   * Used by `run inspect` (idle `sleep infinity`) and `sandbox --interactive` (runs
   * `sandbox-start.sh` for startup/agent-install, then sleeps until exec'd into).
   */
  inspectMode?: {
    onReady: (session: CoderInspectSessionHandle, ctx: { codePath: string }) => Promise<void>;
    /**
     * Override the container entry command. Defaults to `['bash', '-c', 'sleep infinity']`.
     * For `sandbox --interactive`, set to `['bash', '/saifctl/sandbox-start.sh']` so that
     * startup and agent-install scripts run before the container idles.
     */
    entryCommand?: string[];
  };
}

/** Handle for an idle coding container started by {@link RunAgentOpts.inspectMode}. */
export interface CoderInspectSessionHandle {
  /** Container name (Leash target / dangerous-no-leash docker run --name). */
  containerName: string;
  /** Full Docker container ID when resolved (for tooling that matches by Id). */
  containerId: string | null;
  /** In-container workspace path (bind-mounted from the sandbox code dir). */
  workspacePath: string;
  /** Stop the idle session: terminate the Leash/docker parent process and clean up direct-run containers. */
  stop(): Promise<void>;
}

/** Inputs for {@link Engine.teardown}: the run id, the (possibly null) infra snapshot to destroy, and the host project root. */
export interface EngineTeardownOpts {
  runId: string;
  /**
   * `null` means "setup() threw before returning infra". Implementations must not guess —
   * {@link DockerEngine.teardown} logs and no-ops; {@link LocalEngine.teardown} no-ops.
   */
  infra: LiveInfra | null;
  /** Host project root (Docker compose resolution; {@link LocalEngine} ignores). */
  projectDir: string;
}

/** Options for {@link Engine.pauseInfra} / {@link Engine.resumeInfra}. */
export interface EnginePauseInfraOpts {
  /** Sandbox root on the host (used to derive the coder container name). */
  sandboxBasePath: string;
  /** Docker coding infra from the current attempt (compose project + network context). */
  infra: LiveInfra;
}

/** Options for {@link Engine.resumeInfra}. */
export interface EngineResumeInfraOpts {
  sandboxBasePath: string;
  runId: string;
  projectName: string;
  featureName: string;
  projectDir: string;
}

/** Inputs for {@link Engine.verifyInfraToResume}: the resume context plus the persisted infra snapshot to validate. */
export interface EngineVerifyResumeInfraOpts extends EngineResumeInfraOpts {
  infra: LiveInfra;
}

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

/** Infrastructure adaptor contract (Docker today, Kubernetes later). */
export interface Engine {
  /** Engine name (e.g. 'docker', 'local'). */
  name: EngineName;
  /**
   * 1. Initialize the isolated environment and start background services.
   *
   * Docker: Creates a bridge network (`saifctl-net-…`) and runs
   *   `docker compose -p saifctl-<runId> -f <file> up -d --wait`.
   * Attaches compose services to the network via `docker network connect`.
   *
   * Must be called once before any other method.
   */
  setup(opts: EngineSetupOpts): Promise<EngineSetupResult>;

  /**
   * 2. Build and start the staging application (Container A).
   *
   * Docker: Runs `docker build` to create an ephemeral image, creates and
   * starts the container with the sidecar injected via `putArchive`, and
   * waits until the sidecar HTTP endpoint is healthy.
   *
   * Returns a StagingHandle with the abstract URLs of the running app.
   */
  startStaging(opts: StartStagingOpts): Promise<StartStagingResult>;

  /**
   * 3. Run the black-box test suite (Container B) to completion.
   *
   * Docker: Creates and starts the Test Runner container, waits for it to
   * exit, demuxes the log stream, reads raw JUnit XML from the report file, and returns
   * {@link TestsResult} (orchestrator parses XML).
   */
  runTests(opts: RunTestsOpts): Promise<RunTestsEngineResult>;

  /**
   * 4. Run the AI coding agent and wait for it to finish.
   *
   * Docker/Leash: Spawns Leash CLI (`node …/leash.js`) as a child process,
   * starts a background polling loop to attach the Leash target container to the
   * SaifCTL network (workaround for missing --network flag in Leash CLI),
   * and resolves when the process exits.
   */
  runAgent(opts: RunAgentOpts): Promise<RunAgentEngineResult>;

  /**
   * 5. Tear down all resources created during this run.
   *
   * Docker: Stops/removes containers, removes ephemeral staging images,
   * runs `docker compose down -v`, and removes the bridge network.
   * Safe to call even when setup() was never called or partially failed.
   */
  teardown(opts: EngineTeardownOpts): Promise<void>;

  /**
   * Pause sidecar infra for this run: freeze Compose services (if any) and stop the coder
   * container without removing it or the bridge network. Used by `run pause`.
   *
   * {@link LocalEngine} throws — host coding has no Docker coder container.
   */
  pauseInfra(opts: EnginePauseInfraOpts): Promise<void>;

  /**
   * Unpause Compose services (if any). The coder container is started by the next
   * `runAgent` (Docker: detects stopped container by name and `docker start`s it).
   *
   * {@link LocalEngine} no-ops.
   */
  resumeInfra(opts: EngineResumeInfraOpts): Promise<void>;

  /**
   * Check whether the paused infrastructure for a run is still present and intact.
   * Used by `run resume` before attempting to restore the sandbox.
   *
   * Docker: verifies the bridge network still exists. Leash/coder containers are removed on pause
   * and recreated on resume; they are not required to exist here.
   * Local: always returns `true` (no external infra to verify).
   */
  verifyInfraToResume(opts: EngineVerifyResumeInfraOpts): Promise<boolean>;
}
