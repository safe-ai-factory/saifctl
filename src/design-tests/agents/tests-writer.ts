import { Agent } from '@mastra/core/agent';

import { type LlmOverrides, resolveAgentModel } from '../../llm-config.js';
import { type TestProfile } from '../../test-profiles/index.js';
import { type DrainableChunk, drainFullStream } from '../../utils/drain-stream.js';
import type { TestCase } from '../schema.js';

const CODER_INSTRUCTIONS = `You are a senior SDET writing black-box integration tests.

You will receive:
1. The test profile (language + framework + helpers file)
2. One or more TestCase definitions to implement as a single spec file

Your task is to produce a single, complete, executable spec file that implements all provided test cases.

General rules:
- Output ONLY valid source code. No markdown fences, no preamble, no explanation.
- Each test case MUST have its own test block. Use the test case id and title in the labels.
- Use execSidecar() for CLI staging containers (command/sidecar interface)
- Use httpRequest() for web server tests (HTTP interface)
- Write REAL assertions based on the description and expected behavior — do not write stubs
- For negative test cases: assert the bad input causes the expected failure
- For boundary test cases: assert on the exact boundary condition described
- Keep test cases independent — no shared mutable state between test blocks`;

/**
 * Creates a TestsWriter agent — Step 2 of the tests design workflow.
 *
 * Receives a batch of TestCase definitions (all sharing the same entrypoint file)
 * plus the helpers file source, and produces a complete, executable spec file in
 * the language/framework described by the TestProfile.
 */
function createTestsWriterAgent(llm: LlmOverrides = {}) {
  return new Agent({
    id: 'tests-writer',
    name: 'TestsWriter',
    instructions: CODER_INSTRUCTIONS,
    model: resolveAgentModel('tests-writer', llm),
  });
}

export interface RunTestsWriterAgentOpts {
  /** The entrypoint path (e.g. "public/happy-path.spec.ts") — for logging only */
  entrypoint: string;
  /** All test cases that belong to this entrypoint file */
  testCases: TestCase[];
  /** Contents of the helpers file for context (language determined by profile) */
  helpersContent: string;
  /** Test profile determines language, framework, import rules, assertion style. Defaults to vitest. */
  testProfile: TestProfile;
  /** Effective LLM config (--model / --base-url). */
  llm?: LlmOverrides;
  /** Called with each text delta from the LLM */
  onThought?: (delta: string) => void;
  onEvent?: (chunk: DrainableChunk) => void;
  abortSignal?: AbortSignal;
}

/**
 * Runs the tests writer agent for a single entrypoint and returns the generated source code.
 */
export async function runTestsWriterAgent(opts: RunTestsWriterAgentOpts): Promise<string> {
  const {
    entrypoint,
    testCases,
    helpersContent,
    testProfile,
    llm = {},
    onThought,
    onEvent,
    abortSignal,
  } = opts;

  const testCasesSection = testCases
    .map(
      (tc) =>
        `ID: ${tc.id}
Title: ${tc.title}
Description: ${tc.description}
Category: ${tc.category}
Visibility: ${tc.visibility}
Traces to: ${tc.tracesTo.join(', ')}`,
    )
    .join('\n\n---\n\n');

  const prompt = `Implement these test cases as a single ${testProfile.framework} spec file (entrypoint: ${entrypoint}).

=== TEST PROFILE ===
Language:  ${testProfile.language}
Framework: ${testProfile.framework}
Import rules: ${testProfile.importRules}
Assertion rules: ${testProfile.assertionRules}

=== ${testProfile.helpersFilename} (use these transport helpers) ===
${helpersContent}

=== TEST CASES TO IMPLEMENT ===
${testCasesSection}

Output ONLY the ${testProfile.language} source code for the spec file. No explanations.`;

  const output = await createTestsWriterAgent(llm).stream([{ role: 'user', content: prompt }], {
    ...(abortSignal ? { abortSignal } : {}),
  });

  let text = '';
  await drainFullStream(output.fullStream as ReadableStream<DrainableChunk>, {
    onThought: (delta) => {
      text += delta;
      onThought?.(delta);
    },
    onEvent,
  });
  if (!text) text = await output.text;

  // Strip markdown fences if the model wraps the output anyway
  const blockMatch = text.trim().match(/^```(?:typescript|ts)?\s*([\s\S]*?)```\s*$/);
  const extracted = blockMatch?.[1];
  return (extracted ?? text).trim() + '\n';
}
