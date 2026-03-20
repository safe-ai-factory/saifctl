/**
 * Shared test result parsing — used by any provisioner (Docker, Helm, etc.).
 *
 * Parses JUnit XML reports and detects test runner errors from stdout/stderr.
 */

import { XMLParser } from 'fast-xml-parser';

import { readUtf8 } from '../../utils/io.js';
import type { AssertionResult, AssertionSuiteResult } from '../types.js';

// ---------------------------------------------------------------------------
// JUnit XML shape (internal)
// ---------------------------------------------------------------------------

interface JUnitProblem {
  type?: string;
  message?: string;
  '#text'?: string;
}

interface JUnitTestCase {
  name?: string;
  classname?: string;
  skipped?: unknown;
  failure?: JUnitProblem[];
  error?: JUnitProblem[];
}

interface JUnitTestSuite {
  name?: string;
  failures?: string | number;
  errors?: string | number;
  testcase?: JUnitTestCase[];
}

interface JUnitTestSuitesObject {
  testsuite?: JUnitTestSuite[];
}

interface JUnitParsedRoot {
  testsuites?: JUnitTestSuitesObject[] | JUnitTestSuitesObject;
  testsuite?: JUnitTestSuite[];
}

// ---------------------------------------------------------------------------
// JUnit XML parser
// ---------------------------------------------------------------------------

/**
 * Parses a JUnit XML report file into AssertionSuiteResult[].
 * Returns undefined if the file cannot be read or parsed.
 */
export async function parseJUnitXmlFromFile(
  reportPath: string,
): Promise<AssertionSuiteResult[] | undefined> {
  try {
    const xmlStr = await readUtf8(reportPath);
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
      const assertionResults: AssertionResult[] = (ts.testcase ?? []).map((tc) => {
        const title = tc.name ?? 'unknown test';
        const ancestorTitles: string[] = [suiteName];
        if (tc.classname && tc.classname !== suiteName) ancestorTitles.push(tc.classname);

        const problems: JUnitProblem[] = [...(tc.failure ?? []), ...(tc.error ?? [])];
        let status: AssertionResult['status'] = 'passed';
        let failureMessages: string[] = [];
        let failureTypes: string[] = [];

        if (problems.length > 0) {
          status = 'failed';
          failureMessages = problems.map(
            (f) =>
              ((f.message ? `${f.message}\n` : '') + (f['#text'] ?? '')).trim() ||
              'Unknown failure',
          );
          failureTypes = problems.map((f) => {
            const p = f as JUnitProblem & { '@_type'?: string };
            return (f.type ?? p['@_type'] ?? 'Unknown').trim() || 'Unknown';
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
          failureTypes,
        };
      });

      const failuresCount = parseInt(String(ts.failures ?? '0'), 10);
      const errorsCount = parseInt(String(ts.errors ?? '0'), 10);
      const suiteFailed =
        failuresCount > 0 || errorsCount > 0 || assertionResults.some((a) => a.status === 'failed');

      return { name: suiteName, status: suiteFailed ? 'failed' : 'passed', assertionResults };
    });
  } catch (err) {
    console.warn(
      `[test-parser] Failed to parse JUnit XML report from ${reportPath}: ${String(err)}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test runner error detector
// ---------------------------------------------------------------------------

/**
 * Detects known test runner failures (e.g. missing files, import errors) from
 * exit code and stdout/stderr. Used to populate TestsResult.runnerError when
 * the runner never produced a valid JUnit report.
 */
export function detectRunnerError(opts: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string | undefined {
  const { exitCode, stdout, stderr } = opts;
  if (exitCode === 0) return undefined;

  const combined = `${stdout}\n${stderr}`;
  const PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /No test files found/i, label: 'No test files found' },
    { pattern: /Cannot find module/i, label: 'Missing module (import error)' },
    { pattern: /SyntaxError:/i, label: 'Syntax error in test/spec file' },
    { pattern: /error TS\d+:/i, label: 'TypeScript compilation error in spec' },
    { pattern: /Error: Cannot find package/i, label: 'Missing npm package' },
    { pattern: /ENOENT.*tests\.json/i, label: 'tests.json not found' },
    { pattern: /vitest.*not found/i, label: 'Vitest binary not found' },
  ];

  for (const { pattern, label } of PATTERNS) {
    if (pattern.test(combined)) return label;
  }
  if (/ECONNREFUSED/i.test(combined) && !/ \d+ passed/i.test(combined)) {
    return 'Staging container unreachable (ECONNREFUSED) — sidecar/server never started';
  }

  return undefined;
}
