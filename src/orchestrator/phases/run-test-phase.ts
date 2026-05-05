/**
 * Phase: run-test-phase
 *
 * Spins up the staging engine, runs the test suite, tears down, and returns
 * the result. Handles inner test-retry logic (flaky test environments).
 */

import { createEngine } from '../../engines/index.js';
import { defaultEngineLog } from '../../engines/logs.js';
import type { LiveInfra, TestsResult } from '../../engines/types.js';
import { consola } from '../../logger.js';
import type { CleanupRegistry } from '../../utils/cleanup.js';
import { type IterativeLoopOpts, prepareTestRunnerOpts } from '../loop.js';
import type { Sandbox } from '../sandbox.js';

export interface RunTestPhaseInput {
  sandbox: Sandbox;
  /** Outer attempt index (1-indexed) */
  attempt: number;
  opts: Pick<
    IterativeLoopOpts,
    | 'sandboxProfileId'
    | 'feature'
    | 'projectDir'
    | 'projectName'
    | 'testImage'
    | 'testScript'
    | 'testProfile'
    | 'testRetries'
    | 'stagingEnvironment'
  >;
  registry: CleanupRegistry | null;
  /** Optional abort signal forwarded to runTests(). */
  signal?: AbortSignal;
}

export interface RunTestPhaseOutput {
  result: TestsResult;
  /** Run ID used for the final test attempt */
  testRunId: string;
}

export async function runTestPhase(input: RunTestPhaseInput): Promise<RunTestPhaseOutput> {
  const { sandbox, attempt, opts, registry, signal } = input;
  const {
    sandboxProfileId,
    feature,
    projectDir,
    projectName,
    testImage,
    testScript,
    testProfile,
    testRetries,
    stagingEnvironment,
  } = opts;

  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
    testProfile,
  });

  let lastResult: TestsResult = { status: 'failed', stderr: '', stdout: '', rawJunitXml: null };
  let testRunId = '';

  for (let testAttempt = 1; testAttempt <= testRetries; testAttempt++) {
    testRunId = `${sandbox.runId}-${attempt}-${testAttempt}`;
    consola.log(
      `\n[orchestrator] Test attempt ${testAttempt}/${testRetries} (outer attempt ${attempt})`,
    );

    const stagingEngine = createEngine(stagingEnvironment);

    // Track latest live infra for this engine: SIGINT cleanup and teardown() need
    // the same snapshot. Each operation like Engine.setup() may mutate the live infra shape.
    let stagingInfraRef: LiveInfra | null = null;

    // Register before setup so an early signal still sees infra once setup()
    // has assigned stagingInfraRef.
    registry?.registerEngine({
      engine: stagingEngine,
      runId: testRunId,
      label: testRunId,
      projectDir,
      getInfra: () => stagingInfraRef,
    });

    lastResult = await (async (): Promise<TestsResult> => {
      try {
        // Provision staging engine network (and optional compose) for this test attempt.
        const { infra: stAfterSetup } = await stagingEngine.setup({
          runId: testRunId,
          projectName,
          featureName: feature.name,
          projectDir,
        });
        stagingInfraRef = stAfterSetup;

        // Bring up the staging profile (sidecar / app) against the sandbox workspace.
        const { stagingHandle, infra: stAfterStaging } = await stagingEngine.startStaging({
          runId: testRunId,
          sandboxProfileId,
          codePath: sandbox.codePath,
          projectDir,
          stagingEnvironment,
          feature,
          projectName,
          saifctlPath: sandbox.saifctlPath,
          onLog: defaultEngineLog,
          infra: stagingInfraRef!,
        });
        stagingInfraRef = stAfterStaging;

        // Execute the feature test suite inside the staging environment.
        const { tests, infra: stAfterTests } = await stagingEngine.runTests({
          ...testRunnerOpts,
          stagingHandle,
          testImage,
          runId: testRunId,
          feature,
          projectName,
          signal,
          onLog: defaultEngineLog,
          infra: stAfterStaging,
        });
        stagingInfraRef = stAfterTests;
        return tests;
      } finally {
        // Deregister first; then teardown when we have an infra snapshot
        // (null ⇒ failed setup ⇒ teardown no-ops / warns).
        registry?.deregisterEngine(stagingEngine);
        await stagingEngine.teardown({
          runId: testRunId,
          infra: stagingInfraRef,
          projectDir,
        });
      }
    })();

    if (lastResult.runnerError) {
      throw new Error(
        `Test runner error on attempt ${attempt}: ${lastResult.runnerError}\n` +
          `Check that runner.spec.ts and tests.json are present and valid.\n` +
          `Stderr:\n${lastResult.stderr}`,
      );
    }

    if (lastResult.status === 'passed' || lastResult.status === 'aborted') break;
  }

  // These vars come from the last loop of the test-retry loop.
  return { result: lastResult, testRunId };
}
