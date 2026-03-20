/**
 * Phase: run-test-phase
 *
 * Spins up the staging provisioner, runs the test suite, tears down, and returns
 * the result. Handles inner test-retry logic (flaky test environments).
 */

import { join } from 'node:path';

import { createProvisioner } from '../../provisioners/index.js';
import type { TestsResult } from '../../provisioners/types.js';
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
    testRetries,
    stagingEnvironment,
  } = opts;

  const testRunnerOpts = await prepareTestRunnerOpts({
    feature,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  let lastResult: TestsResult = { status: 'failed', stderr: '', stdout: '' };
  let testRunId = '';

  for (let testAttempt = 1; testAttempt <= testRetries; testAttempt++) {
    testRunId = `${sandbox.runId}-${attempt}-${testAttempt}`;
    console.log(
      `\n[orchestrator] Test attempt ${testAttempt}/${testRetries} (outer attempt ${attempt})`,
    );

    const stagingProvisioner = createProvisioner(stagingEnvironment);
    registry?.registerProvisioner(stagingProvisioner, testRunId);

    lastResult = await (async (): Promise<TestsResult> => {
      try {
        const stagingHandle = await stagingProvisioner.startStaging({
          sandboxProfileId,
          codePath: sandbox.codePath,
          projectDir,
          stagingEnvironment,
          feature,
          projectName,
          startupPath: sandbox.startupPath,
          stagePath: sandbox.stagePath,
        });

        return await stagingProvisioner.runTests({
          ...testRunnerOpts,
          stagingHandle,
          testImage,
          runId: testRunId,
          feature,
          projectName,
          reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
          signal,
        });
      } finally {
        registry?.deregisterProvisioner(stagingProvisioner);
        await stagingProvisioner.teardown({ runId: testRunId });
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

  return { result: lastResult, testRunId };
}
