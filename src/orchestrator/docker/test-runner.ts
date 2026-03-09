/**
 * Docker container management for the Software Factory Orchestrator.
 *
 * Manages the two-container Black Box tests architecture:
 *   Container A — Application under test (with HTTP Sidecar for CLI features)
 *   Container B — Test Runner (runs spec files against Container A over HTTP)
 *   + optional ephemeral containers (postgres, redis, etc.)
 *
 * Containers communicate over a shared Docker network. The Test Runner never
 * mounts the Docker socket; it communicates with Container A exclusively via HTTP.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import type { TestCatalog } from '../../design-tests/schema.js';
import type { SupportedSandboxProfileId } from '../../sandbox-profiles/index.js';
import {
  assertSafeImageTag,
  type CleanupRegistry,
  type ContainerHandle,
  demuxDockerLogs,
  docker,
  removeImageByTag,
  removeNetwork,
  streamContainerLogs,
  teardownContainers,
} from '../../utils/docker.js';
import { createSandboxNetwork } from './network.js';
import {
  getStagingImageTag,
  startAdditionalContainers,
  startStagingContainer,
  type StartStagingContainerOpts,
} from './staging.js';

/** One test file entry from vitest's JSON reporter output. */
export interface VitestSuiteResult {
  name: string;
  status: string;
  assertionResults: VitestAssertionResult[];
}

/** One individual test case from vitest's JSON reporter output. */
export interface VitestAssertionResult {
  title: string;
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'todo';
  /** Describe-block ancestry, outermost first. e.g. ['sidecar:health'] or ['shotgun-test'] */
  ancestorTitles: string[];
  failureMessages: string[];
}

export interface TestsResult {
  passed: boolean;
  stderr: string;
  stdout: string;
  /**
   * Set when the test runner itself crashed before running any tests (e.g. "No test files
   * found", missing dependencies, syntax errors in the spec). This is distinct from tests
   * running and failing — in this case the exit code is non-zero but no meaningful pass/fail
   * signal was produced.
   */
  runnerError?: string;
  /**
   * Parsed vitest JSON reporter output. Present when the JSON report was successfully
   * captured from the test runner container. Used by fail2pass to distinguish infra vs
   * feature test results.
   */
  testSuites?: VitestSuiteResult[];
}

export interface StartTestRunnerContainerOpts {
  /** Absolute path to the tests/ directory on the host. */
  testsDir: string;
  /**
   * Host directory where the test runner writes its results file (bind-mounted to /test-runner-output
   * inside the container). The orchestrator reads the report from this directory after the
   * container exits (see FACTORY_OUTPUT_FILE for the filename inside the container).
   */
  reportDir: string;
  changeName: string;
  /**
   * Project name (from package.json "name" or --project flag).
   * Embedded in the test runner container name so `docker clear` can scope
   * cleanup by project.
   */
  projectName: string;
  catalog: TestCatalog;
  /** Docker network name to join */
  networkName: string;
  /** Unique run id used to name containers */
  runId: string;
  /**
   * Test image tag (default: 'factory-test-<profileId>:latest').
   *
   * Override via --test-image CLI flag. Docker automatically pulls the image
   * from the registry when it is not present locally.
   */
  testImage: string;
  /**
   * Absolute host path to the test.sh to bind-mount at /usr/local/bin/test.sh
   * inside the Test Runner container (read-only). Always set by the Orchestrator —
   * defaults to DEFAULT_TEST_SCRIPT (test-default.sh) when --test-script is not provided.
   *
   * Override via --test-script CLI flag.
   */
  testScriptPath: string;
  /** Called immediately after the container starts. See StartStagingContainerOpts.onStarted. */
  onStarted?: (handle: ContainerHandle) => void;
}

/**
 * Starts Container B — the Test Runner.
 *
 * The Test Runner image's CMD invokes /usr/local/bin/test.sh, which is always bind-mounted
 * by the Orchestrator (from test-default.sh or a custom --test-script). This function:
 *   1. Bind-mounts the test files into /tests (read-only).
 *   2. Bind-mounts test.sh at /usr/local/bin/test.sh (read-only).
 *   3. Bind-mounts the output directory into /test-runner-output (read-write).
 *   4. Passes the required environment variables (see test-default.sh for the full contract).
 *
 * Environment variables passed to the container:
 *   FACTORY_TARGET_URL   — URL of the application under test
 *   FACTORY_SIDECAR_URL  — URL of the HTTP sidecar (CLI exec wrapper)
 *   FACTORY_CHANGE_NAME  — OpenSpec change name
 *   FACTORY_TESTS_DIR    — absolute path to the mounted tests directory inside the container
 *   FACTORY_OUTPUT_FILE  — absolute path where the container must write the JUnit XML report
 */
export async function startTestRunnerContainer(
  opts: StartTestRunnerContainerOpts,
): Promise<ContainerHandle> {
  const {
    testsDir: hostTestsDir,
    reportDir,
    changeName,
    projectName,
    onStarted,
    catalog,
    networkName,
    runId,
    testImage,
    testScriptPath,
  } = opts;
  const containerName = `factory-test-${projectName}-${runId}`;

  const stagingContainerConfig = catalog.containers.staging;

  // The staging container has "staging" added as a network alias (see startStagingContainer),
  // so the test runner can resolve it by that short hostname within the shared bridge network.
  const stagingAlias = 'staging';

  // Sidecar URL is always defined — the sidecar runs in every staging container.
  const sidecarUrl = `http://${stagingAlias}:${stagingContainerConfig.sidecarPort}${stagingContainerConfig.sidecarPath}`;

  // Target URL points to the web application. For pure CLI projects (no baseUrl)
  // it falls back to the sidecar URL so tests can use FACTORY_TARGET_URL uniformly.
  // baseUrl should use "staging" as the hostname (e.g. "http://staging:3000").
  const targetUrl = stagingContainerConfig.baseUrl ?? sidecarUrl;

  const containerTestsDir = '/tests';
  const containerOutputFile = '/test-runner-output/results.xml';

  assertSafeImageTag(testImage);

  // Mount test files and helpers
  // - infra.spec.ts - internal health check, ensures this setup works
  // - public/ and hidden/ - user's test files
  // - helpers.ts - shared helpers
  const publicDir = join(hostTestsDir, 'public');
  const hiddenDir = join(hostTestsDir, 'hidden');
  const helpersFile = join(hostTestsDir, 'helpers.ts');
  const infraFile = join(hostTestsDir, 'infra.spec.ts');

  const binds = [
    ...(existsSync(publicDir) ? [`${publicDir}:${containerTestsDir}/public:ro`] : []),
    ...(existsSync(hiddenDir) ? [`${hiddenDir}:${containerTestsDir}/hidden:ro`] : []),
    ...(existsSync(helpersFile) ? [`${helpersFile}:${containerTestsDir}/helpers.ts:ro`] : []),
    ...(existsSync(infraFile) ? [`${infraFile}:${containerTestsDir}/infra.spec.ts:ro`] : []),
    // Always mount test.sh — either the default (test-default.sh) or a custom override.
    `${testScriptPath}:/usr/local/bin/test.sh:ro`,
  ];

  console.log(`[docker] Starting test runner container: ${containerName}`);
  console.log(`[docker] Test image: ${testImage}`);
  console.log(`[docker] Test runner sidecar URL: ${sidecarUrl}`);
  console.log(`[docker] Test runner target URL:  ${targetUrl}`);
  console.log(`[docker] Test runner script: ${testScriptPath}`);

  const container = await docker.createContainer({
    Image: testImage,
    name: containerName,
    // CMD runs /usr/local/bin/test.sh (bind-mounted by the Orchestrator).
    // The test runner only reads :ro mounts and writes the results file to
    // /test-runner-output (rw bind to sandbox root on host).
    HostConfig: {
      NetworkMode: networkName,
      Binds: [...binds, `${reportDir}:/test-runner-output:rw`],
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
    },
    Env: [
      `FACTORY_TARGET_URL=${targetUrl}`,
      `FACTORY_SIDECAR_URL=${sidecarUrl}`,
      `FACTORY_CHANGE_NAME=${changeName}`,
      `FACTORY_TESTS_DIR=${containerTestsDir}`,
      `FACTORY_OUTPUT_FILE=${containerOutputFile}`,
    ],
    WorkingDir: '/workspace',
  });

  await container.start();
  console.log(`[docker] ${containerName} started`);
  streamContainerLogs(container, containerName);

  const handle: ContainerHandle = { id: container.id, name: containerName, container };
  onStarted?.(handle);

  return handle;
}

interface StartContainersResult {
  stagingContainerHandle: ContainerHandle;
  testRunnerHandle: ContainerHandle;
  all: ContainerHandle[];
}

/**
 * Starts additional (ephemeral) containers and the staging container concurrently,
 * then starts the test runner (which needs the agent's container name) immediately after.
 * Registers every handle with the CleanupRegistry as soon as it is available so
 * that a SIGINT arriving mid-startup still tears down whatever was already created.
 * Returns handles for all three groups.
 */
interface StartContainersOpts {
  stagingContainer: StartStagingContainerOpts;
  testRunner: Omit<StartTestRunnerContainerOpts, 'testImage'>;
  registry: CleanupRegistry;
  testImage: string;
}

async function startContainers({
  stagingContainer: stagingContainerOpts,
  testRunner: testRunnerOpts,
  registry,
  testImage,
}: StartContainersOpts): Promise<StartContainersResult> {
  const [additionalContainers, stagingContainerHandle] = await Promise.all([
    startAdditionalContainers({
      additionalContainers: stagingContainerOpts.catalog.containers.additional,
      networkName: stagingContainerOpts.networkName,
      runId: stagingContainerOpts.runId,
    }),
    startStagingContainer({
      ...stagingContainerOpts,
      // Register immediately after start, before the health-wait, so SIGINT
      // during the (potentially long) docker build + sidecar-ready wait still
      // tears down the container.
      onStarted: (h: ContainerHandle) => registry.registerContainers([h]),
    }),
  ]);

  // Additional containers have no health-wait so registerContainers after the fact is fine.
  registry.registerContainers(additionalContainers);

  const testRunnerHandle = await startTestRunnerContainer({
    ...testRunnerOpts,
    testImage,
    onStarted: (h: ContainerHandle) => registry.registerContainers([h]),
  });

  return {
    stagingContainerHandle,
    testRunnerHandle,
    all: [...additionalContainers, stagingContainerHandle, testRunnerHandle],
  };
}

export interface RunTeststWithContainersOpts {
  sandboxProfileId: SupportedSandboxProfileId;
  codePath: string;
  projectDir: string;
  changeName: string;
  projectName: string;
  catalog: TestCatalog;
  testRunnerOpts: Pick<StartTestRunnerContainerOpts, 'testsDir' | 'reportDir' | 'testScriptPath'>;
  registry: CleanupRegistry;
  testImage: string;
  runId: string;
  /** Absolute path to the startup script on the host (sandboxBasePath/startup.sh). */
  startupPath: string;
  /** Absolute path to the staging script on the host (sandboxBasePath/stage.sh). */
  stagePath: string;
  reportPath: string;
}

/**
 * Creates a sandbox network, pre-registers the staging image, starts all
 * containers, runs the test runner, then tears everything down — regardless of
 * outcome. This is the repeated inner try/finally pattern shared by
 * fail2pass, test (per-retry), and the iterative loop.
 */
export async function runTeststWithContainers({
  sandboxProfileId,
  codePath,
  projectDir,
  changeName,
  projectName,
  catalog,
  testRunnerOpts,
  registry,
  testImage,
  runId,
  startupPath,
  stagePath,
  reportPath,
}: RunTeststWithContainersOpts): Promise<TestsResult> {
  const containers: ContainerHandle[] = [];
  let networkName = '';

  try {
    const net = await createSandboxNetwork({ projectName, changeName, runId });
    networkName = net.networkName;
    registry.registerNetwork(networkName);

    // Pre-register before the build starts so SIGINT during docker build still cleans up.
    const stagingImageTag = getStagingImageTag(catalog, { projectName, changeName, runId });
    if (stagingImageTag) registry.registerImage(stagingImageTag);

    const { testRunnerHandle, all } = await startContainers({
      stagingContainer: {
        sandboxProfileId,
        codePath,
        projectDir,
        changeName,
        projectName,
        catalog,
        networkName,
        runId,
        startupPath,
        stagePath,
      },
      testRunner: { ...testRunnerOpts, changeName, projectName, catalog, networkName, runId },
      registry,
      testImage,
    });
    containers.push(...all);

    return await runTests(testRunnerHandle, { reportPath });
  } finally {
    await teardownContainers(containers);
    registry.deregisterContainers(containers);
    await removeNetwork(networkName);
    registry.deregisterNetwork(networkName);
    const stagingImageTag = getStagingImageTag(catalog, { projectName, changeName, runId });
    if (stagingImageTag) {
      await removeImageByTag({ imageTag: stagingImageTag, missingOk: true });
      registry.deregisterImage(stagingImageTag);
    }
  }
}

export interface RunTestsOpts {
  /**
   * Host path to the test runner's results file (written by the container into /test-runner-output,
   * which is bind-mounted to the sandbox root on the host). When provided we read the report
   * from disk to populate testSuites; when absent testSuites is left undefined.
   */
  reportPath?: string;
}

/**
 * Waits for the test runner container to finish and returns the tests result.
 *
 * The test runner's CMD runs the mounted test.sh, which executes the test suite and writes a results file to
 * /test-runner-output (bind-mounted to the sandbox root). We read that file from reportPath
 * to populate testSuites for per-suite analysis (e.g. fail2pass ignoring infra failures).
 */
export async function runTests(
  testRunnerHandle: ContainerHandle,
  opts: RunTestsOpts = {},
): Promise<TestsResult> {
  const { reportPath } = opts;

  console.log(`[docker] Waiting for test runner to complete...`);
  const { StatusCode } = (await testRunnerHandle.container.wait()) as { StatusCode: number };

  const logStream = await testRunnerHandle.container.logs({
    stdout: true,
    stderr: true,
    follow: false,
  });

  // dockerode returns a Buffer with multiplexed stream headers; demux manually
  const { stdout, stderr } = demuxDockerLogs(logStream as unknown as Buffer);

  console.log(`[docker] Test runner exit code: ${StatusCode}`);
  if (stdout) console.log(`[docker] Test runner stdout:\n${stdout}`);
  if (stderr) console.error(`[docker] Test runner stderr:\n${stderr}`);

  const runnerError = detectRunnerError({ exitCode: StatusCode, stdout, stderr });
  if (runnerError) {
    console.error(`[docker] Test runner error detected: ${runnerError}`);
  }

  const testSuites =
    reportPath && existsSync(reportPath) ? parseJUnitXmlFromFile(reportPath) : undefined;

  return {
    passed: StatusCode === 0,
    stdout,
    stderr,
    runnerError,
    testSuites,
  };
}

/** A single <failure> or <error> element from JUnit XML. */
interface JUnitProblem {
  message?: string;
  '#text'?: string;
}

/** A single <testcase> element from JUnit XML. */
interface JUnitTestCase {
  name?: string;
  classname?: string;
  skipped?: unknown;
  failure?: JUnitProblem[];
  error?: JUnitProblem[];
}

/** A single <testsuite> element from JUnit XML. */
interface JUnitTestSuite {
  name?: string;
  failures?: string | number;
  errors?: string | number;
  testcase?: JUnitTestCase[];
}

/** The <testsuites> wrapper element when parsed as an object (not as an array). */
interface JUnitTestSuitesObject {
  testsuite?: JUnitTestSuite[];
}

/** The parsed root of a JUnit XML document (fast-xml-parser output). */
interface JUnitParsedRoot {
  testsuites?: JUnitTestSuitesObject[] | JUnitTestSuitesObject;
  testsuite?: JUnitTestSuite[];
}

/**
 * Parses a JUnit XML report written by the Test Runner container (`results.xml`) into our VitestSuiteResult[] type.
 *
 * JUnit XML is the universal test output format: every major test runner (Vitest, Jest, pytest,
 * go test, cargo-junit, etc.) can emit it, which means the Orchestrator is decoupled from
 * the specific test runner used inside the Test Runner container.
 *
 * The XML structure varies slightly across runners:
 *   - Root may be <testsuites> (wrapping multiple <testsuite>) or bare <testsuite>.
 *   - Failure details live in <failure> or <error> child elements.
 *   - Skipped tests use a <skipped/> child element.
 *
 * We force all repeated tags to be arrays via fast-xml-parser's `isArray` callback so
 * the mapping logic is uniform regardless of whether there is one or many suites/cases.
 */
function parseJUnitXmlFromFile(reportPath: string): VitestSuiteResult[] | undefined {
  try {
    const xmlStr = readFileSync(reportPath, 'utf8');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      isArray: (_, jpath) =>
        [
          'testsuites',
          'testsuites.testsuite',
          'testsuite',
          'testsuites.testsuite.testcase',
          'testsuite.testcase',
          'testsuites.testsuite.testcase.failure',
          'testsuite.testcase.failure',
          'testsuites.testsuite.testcase.error',
          'testsuite.testcase.error',
        ].includes(jpath),
    });

    const parsed = parser.parse(xmlStr) as JUnitParsedRoot;

    // Normalise to an array of suite objects regardless of root element.
    // fast-xml-parser returns <testsuites> as an array (via isArray) or as a plain object,
    // and some runners omit <testsuites> entirely and use a bare <testsuite> root.
    let rawSuites: JUnitTestSuite[] = [];
    if (Array.isArray(parsed.testsuites)) {
      rawSuites = parsed.testsuites[0]?.testsuite ?? [];
    } else if (parsed.testsuites?.testsuite) {
      rawSuites = (parsed.testsuites as JUnitTestSuitesObject).testsuite ?? [];
    } else if (parsed.testsuite) {
      rawSuites = parsed.testsuite;
    }

    return rawSuites.map((ts) => {
      const suiteName = ts.name ?? 'unknown';

      const assertionResults: VitestAssertionResult[] = (ts.testcase ?? []).map((tc) => {
        const title = tc.name ?? 'unknown test';

        const ancestorTitles: string[] = [suiteName];
        // Some runners (e.g. Vitest) encode the describe-block path in classname.
        // Include it in ancestors only when it adds information beyond the suite name.
        if (tc.classname && tc.classname !== suiteName) {
          ancestorTitles.push(tc.classname);
        }

        const problems: JUnitProblem[] = [...(tc.failure ?? []), ...(tc.error ?? [])];

        let status: VitestAssertionResult['status'] = 'passed';
        let failureMessages: string[] = [];

        if (problems.length > 0) {
          status = 'failed';
          failureMessages = problems.map((f) => {
            const msg = f.message ? `${f.message}\n` : '';
            const text = f['#text'] ?? '';
            return (msg + text).trim() || 'Unknown failure';
          });
        } else if (tc.skipped !== undefined) {
          status = 'pending';
        }

        return {
          title,
          fullName: `${ancestorTitles.join(' ')} ${title}`,
          status,
          ancestorTitles,
          failureMessages,
        };
      });

      const failuresCount = parseInt(String(ts.failures ?? '0'), 10);
      const errorsCount = parseInt(String(ts.errors ?? '0'), 10);
      const suiteFailed =
        failuresCount > 0 || errorsCount > 0 || assertionResults.some((a) => a.status === 'failed');

      return { name: suiteName, status: suiteFailed ? 'failed' : 'passed', assertionResults };
    });
  } catch (err) {
    console.warn(`[docker] Failed to parse JUnit XML report from ${reportPath}: ${String(err)}`);
    return undefined;
  }
}

/**
 * Checks whether at least one feature test (i.e. not in the 'sidecar:health' suite)
 * failed in the tests result.
 *
 * Used by fail2pass to confirm the tests actually test something unimplemented,
 * without being confused by infra health-check tests which always pass.
 */
export function hasFeatureTestFailures(result: TestsResult): boolean {
  if (!result.testSuites) {
    // No structured data — fall back to exit code
    return !result.passed;
  }

  for (const suite of result.testSuites) {
    for (const assertion of suite.assertionResults) {
      // Skip infra health-check suite
      if (assertion.ancestorTitles.includes('sidecar:health')) continue;
      if (assertion.status === 'failed') return true;
    }
  }
  return false;
}

/**
 * Detects whether the test runner itself crashed (as opposed to tests running and failing).
 * Returns a human-readable error string when a runner-level problem is detected, or undefined
 * if the exit code reflects a normal test pass/fail.
 */
function detectRunnerError({
  exitCode,
  stdout,
  stderr,
}: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string | undefined {
  if (exitCode === 0) return undefined;

  const combined = `${stdout}\n${stderr}`;

  const RUNNER_ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /No test files found/i, label: 'No test files found' },
    { pattern: /Cannot find module/i, label: 'Missing module (import error)' },
    { pattern: /SyntaxError:/i, label: 'Syntax error in test/spec file' },
    { pattern: /error TS\d+:/i, label: 'TypeScript compilation error in spec' },
    { pattern: /Error: Cannot find package/i, label: 'Missing npm package' },
    { pattern: /ENOENT.*tests\.json/i, label: 'tests.json not found' },
    { pattern: /vitest.*not found/i, label: 'Vitest binary not found' },
  ];

  for (const { pattern, label } of RUNNER_ERROR_PATTERNS) {
    if (pattern.test(combined)) return label;
  }

  // If every test failed with ECONNREFUSED the staging container never started —
  // that is an infrastructure problem, not a meaningful test failure.
  if (/ECONNREFUSED/i.test(combined) && !/ \d+ passed/i.test(combined)) {
    return 'Staging container unreachable (ECONNREFUSED) — sidecar/server never started';
  }

  return undefined;
}
