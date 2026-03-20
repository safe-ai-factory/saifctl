/**
 * Provisioner interface — lifecycle contract for infrastructure adaptors.
 *
 * A Provisioner manages the full lifecycle of an isolated SAIFAC run environment:
 *   1. setup()        — create an isolated network + start background services (databases, etc.)
 *   2. startStaging() — build & boot the application under test (Container A) with sidecar
 *   3. runTests()     — run test runner (black-box tests) (Container B) and return results
 *   4. runAgent()     — spawn the AI coding agent container and return when it exits
 *   5. teardown()     — stop and remove all resources created during this run
 *
 * DockerProvisioner is the concrete implementation for Docker (with optional Compose services).
 * A HelmProvisioner would implement the same interface using Kubernetes.
 */

import type { LlmConfig } from '../llm-config.js';
import type { SupportedSandboxProfileId } from '../sandbox-profiles/types.js';
import type { Feature } from '../specs/discover.js';

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

/** Parsed test result (same shape whether Docker or K8s). */
export interface TestsResult {
  status: TestRunStatus;
  stderr: string;
  stdout: string;
  /**
   * Set when the test runner itself crashed before producing any test signal
   * (e.g. missing test files, syntax errors, missing imports).
   */
  runnerError?: string;
  testSuites?: AssertionSuiteResult[];
}

export interface AssertionSuiteResult {
  name: string;
  status: string;
  assertionResults: AssertionResult[];
}

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

export interface AgentResult {
  success: boolean;
  exitCode: number;
  /** Combined stdout + stderr from the agent process. */
  output: string;
}

// ---------------------------------------------------------------------------
// Method option types
// ---------------------------------------------------------------------------

export interface ProvisionerSetupOpts {
  runId: string;
  projectName: string;
  featureName: string;
  /** Absolute path to the host project root (used to resolve relative compose files, etc.). */
  projectDir: string;
}

/** NormalizedStagingEnvironment shape re-declared inline to avoid circular deps. */
export interface StagingAppConfig {
  sidecarPort: number;
  sidecarPath: string;
  baseUrl?: string;
  build?: { dockerfile?: string };
}

export interface NormalizedStagingEnvironmentRef {
  provisioner: string;
  app: StagingAppConfig;
  appEnvironment: Record<string, string>;
  /** Present when a Docker Compose file is configured for ephemeral services. */
  file?: string;
}

export interface StartStagingOpts {
  sandboxProfileId: SupportedSandboxProfileId;
  /** Absolute path to the sandbox code directory on the host. */
  codePath: string;
  /** Absolute path to the project directory (used to resolve custom Dockerfiles). */
  projectDir: string;
  stagingEnvironment: NormalizedStagingEnvironmentRef;
  feature: Feature;
  projectName: string;
  /**
   * Absolute host path to startup.sh.
   * Mounted read-only at /saifac/startup.sh and run once at container start
   * to install workspace dependencies.
   */
  startupPath: string;
  /**
   * Absolute host path to stage.sh.
   * Mounted read-only at /saifac/stage.sh; starts the app (or keeps container alive).
   */
  stagePath: string;
}

export interface RunTestsOpts {
  /** Absolute path to the feature's tests/ directory on the host. */
  testsDir: string;
  /**
   * Absolute path to a host directory where the test runner writes results.xml
   * (bind-mounted to /test-runner-output inside the container).
   */
  reportDir: string;
  /**
   * Absolute path on the host to the JUnit XML file the test runner writes.
   * Read by the provisioner after the container exits to populate testSuites.
   */
  reportPath: string;
  /** Test runner image tag (e.g. 'saifac-test-node-vitest:latest'). */
  testImage: string;
  /**
   * Absolute host path to test.sh, always bind-mounted at
   * /usr/local/bin/test.sh inside the Test Runner container (read-only).
   */
  testScriptPath: string;
  /** Used to derive SAIFAC_TARGET_URL and SAIFAC_SIDECAR_URL for the test runner. */
  stagingHandle: StagingHandle;
  feature: Feature;
  projectName: string;
  runId: string;
  /**
   * Optional abort signal. When fired, the test runner container is stopped
   * immediately and the result is returned with status='aborted'.
   */
  signal?: AbortSignal;
}

export interface RunAgentOpts {
  /** Absolute path to the sandbox code directory (host path). */
  codePath: string;
  /**
   * Absolute path to the sandbox base directory (host path).
   * Used to derive the Leash workspace id and locate gate.sh.
   */
  sandboxBasePath: string;
  /** Full task description (plan + error feedback). */
  task: string;
  /** Error feedback from the previous test run (may be empty). */
  errorFeedback?: string;
  /** Resolved LLM config injected as LLM_* env vars into the coder container. */
  llmConfig: LlmConfig;
  saifDir: string;
  feature?: Feature;
  /** When true, run the agent on the host instead of inside a Leash container. */
  dangerousDebug: boolean;
  /** Absolute path to the Cedar policy file. Ignored when dangerousDebug=true. */
  cedarPolicyPath: string;
  /** Docker image for the coder container. Ignored when dangerousDebug=true. */
  coderImage: string;
  /** Maximum gate iterations per agent run. Forwarded as SAIFAC_GATE_RETRIES. */
  gateRetries: number;
  /** Absolute host path to startup.sh. Mounted at /saifac/startup.sh. */
  startupPath: string;
  /** Absolute host path to agent-start.sh. Mounted at /saifac/agent-start.sh. */
  agentStartPath: string;
  /** Absolute host path to agent.sh. Mounted at /saifac/agent.sh. */
  agentPath: string;
  /**
   * User-supplied extra env vars. Reserved SAIFAC_* and LLM_* keys are silently
   * filtered out by the runner before forwarding.
   */
  agentEnv: Record<string, string>;
  agentLogFormat: 'openhands' | 'raw';
  /**
   * Settings for the semantic reviewer (argus-ai). null = reviewer disabled.
   */
  reviewer: {
    llmConfig: LlmConfig;
    scriptPath: string;
    argusBinaryPath: string;
  } | null;
  /**
   * Optional abort signal. When fired (e.g. Hatchet step cancellation), the
   * agent child process is killed immediately and teardown() is still called
   * by the caller's finally block.
   */
  signal?: AbortSignal;
}

export interface ProvisionerTeardownOpts {
  runId: string;
}

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Provisioner {
  /**
   * 1. Initialize the isolated environment and start background services.
   *
   * Docker: Creates a bridge network (`saifac-net-…`) and runs
   *   `docker compose -p saifac-<runId> -f <file> up -d --wait`.
   * Attaches compose services to the network via `docker network connect`.
   *
   * Must be called once before any other method.
   */
  setup(opts: ProvisionerSetupOpts): Promise<void>;

  /**
   * 2. Build and start the staging application (Container A).
   *
   * Docker: Runs `docker build` to create an ephemeral image, creates and
   * starts the container with the sidecar injected via `putArchive`, and
   * waits until the sidecar HTTP endpoint is healthy.
   *
   * Returns a StagingHandle with the abstract URLs of the running app.
   */
  startStaging(opts: StartStagingOpts): Promise<StagingHandle>;

  /**
   * 3. Run the black-box test suite (Container B) to completion.
   *
   * Docker: Creates and starts the Test Runner container, waits for it to
   * exit, demuxes the log stream, parses the JUnit XML report, and returns
   * the structured TestsResult.
   */
  runTests(opts: RunTestsOpts): Promise<TestsResult>;

  /**
   * 4. Run the AI coding agent and wait for it to finish.
   *
   * Docker/Leash: Spawns `npx leash …` as a child process, starts a
   * background polling loop to attach the Leash target container to the
   * SAIFAC network (workaround for missing --network flag in Leash CLI),
   * and resolves when the process exits.
   *
   * dangerous-debug: Runs `bash coder-start.sh` directly on the host.
   */
  runAgent(opts: RunAgentOpts): Promise<AgentResult>;

  /**
   * 5. Tear down all resources created during this run.
   *
   * Docker: Stops/removes containers, removes ephemeral staging images,
   * runs `docker compose down -v`, and removes the bridge network.
   * Safe to call even when setup() was never called or partially failed.
   */
  teardown(opts: ProvisionerTeardownOpts): Promise<void>;
}
