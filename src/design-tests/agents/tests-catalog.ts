import { Agent } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';

import { type LlmOverrides, resolveAgentModel } from '../../llm-config.js';
import { type TestProfile } from '../../test-profiles/index.js';
import { type DrainableChunk, drainFullStream } from '../../utils/drain-stream.js';
import { TestCatalogSchema } from '../schema.js';

const CATALOG_INSTRUCTIONS = `You are a senior SDET converting a Markdown test plan into a strict JSON test catalog.

You will receive:
1. The original specification files for a feature
2. A Markdown test plan enumerating all test scenarios
3. The test profile (language + framework) to use for entrypoint file names

Your task is to produce a structured JSON test catalog that faithfully represents every test case in the plan.

Rules:
- Every test case MUST appear in the output JSON
- Each test case MUST have a unique id (e.g. "tc-feature-001", "tc-feature-002")
- tracesTo MUST reference the specific spec/plan section (e.g. "plan.md Stage 1 Success Criterion 2")
- dbAssertions MUST be null when there are no DB side effects to verify
- Assign visibility "public" for core happy paths and explicit spec requirements; "hidden" for isomorphic variations, boundaries, negative paths, and complex mutations

Entrypoint rules (REQUIRED — every test case MUST have an entrypoint):
- The entrypoint is a relative path (from tests/) to the file that will implement this test case
- Follow the naming convention provided in the TEST PROFILE section below
- If visibility is "public", the path MUST start with "public/"
- If visibility is "hidden", the path MUST start with "hidden/"
- Group related test cases into logical files to avoid file proliferation — e.g. all boundary checks in one file, all happy path checks in another
- Use descriptive filenames that reflect the group of tests

When available, use queryCodebaseIndex to resolve file paths, module names, or traceability (e.g. "where is the /exec endpoint defined?", "what CLI commands exist?") so tracesTo and input fields are accurate.`;

/**
 * Creates a TestsCatalog agent, step 1b of the tests design workflow.
 *
 * Receives the Markdown tests.md (from Step 1a) plus the original spec
 * files and expands them into a strict JSON catalog. Uses text output + Zod
 * validation instead of structuredOutput to avoid provider schema nesting limits.
 *
 * Optionally wired to a codebase index tool.
 *
 * When `indexerTool` is provided (from an IndexerProfile), the agent can call
 * `queryCodebaseIndex` to resolve file paths and traceability.
 */
function createTestsCatalogAgent(indexerTool?: Tool, llm: LlmOverrides = {}) {
  return new Agent({
    id: 'tests-catalog',
    name: 'TestsCatalog',
    instructions: CATALOG_INSTRUCTIONS,
    model: resolveAgentModel('tests-catalog', llm),
    tools: indexerTool ? { queryCodebaseIndex: indexerTool } : {},
  });
}

/** Options for running the catalog agent. */
export interface RunCatalogAgentOpts {
  featureName: string;
  featureDir: string;
  featureFiles: Record<string, string>;
  testPlan: string;
  extraPrompt?: string;
  /** Test profile determines file extensions and naming rules. Defaults to vitest. */
  testProfile: TestProfile;
  /** Optional codebase index tool from an IndexerProfile. When provided, agent can query the codebase. */
  indexerTool?: Tool;
  /** Effective LLM config (--model / --base-url). */
  llm?: LlmOverrides;
  onThought?: (delta: string) => void;
  onEvent?: (chunk: DrainableChunk) => void;
  abortSignal?: AbortSignal;
}

/**
 * Runs the catalog agent (Step 1b) and returns the validated TestCatalog.
 */
export async function runCatalogAgent(opts: RunCatalogAgentOpts) {
  const {
    featureName,
    featureDir,
    featureFiles,
    testPlan,
    extraPrompt,
    testProfile,
    indexerTool,
    llm = {},
    onThought,
    onEvent,
    abortSignal,
  } = opts;

  const fileSection = Object.entries(featureFiles)
    .map(([name, content]) => `=== ${name} ===\n${content}`)
    .join('\n\n');

  const refinement = extraPrompt ? `\n\nAdditional instruction: ${extraPrompt}` : '';

  const examplePublic = `public/happy-path${testProfile.specExtension}`;
  const exampleHidden = `hidden/boundary-cases${testProfile.specExtension}`;

  const testProfileSection = `
=== TEST PROFILE ===
Language:  ${testProfile.language}
Framework: ${testProfile.framework}
File extension: ${testProfile.specExtension}
Naming rule: ${testProfile.fileNamingRule}
Example entrypoints: "${examplePublic}", "${exampleHidden}"`;

  const schemaHint = `
Output a single JSON object (no markdown fences). Shape:
{
  "version": "1.0",
  "featureName": "<feature>",
  "featureDir": "<path>",
  "testCases": [
    {
      "id": "tc-001",
      "title": "...",
      "description": "...",
      "tracesTo": ["plan.md ..."],
      "category": "happy_path|boundary|negative|error_handling",
      "visibility": "public|hidden",
      "entrypoint": "${examplePublic}"
    }
  ]
}

IMPORTANT: Every test case MUST have an "entrypoint" field following the naming rule above. Group logically related tests into the same file.`;

  const prompt = `Feature: ${featureName}
Spec directory: ${featureDir}
${testProfileSection}

=== SPECIFICATION FILES ===
${fileSection}

=== MARKDOWN TEST PLAN ===
${testPlan}
${refinement}
${schemaHint}

Produce the complete JSON test catalog. Output ONLY valid JSON, no other text.`;

  const agent = createTestsCatalogAgent(indexerTool, llm);

  const output = await agent.stream([{ role: 'user', content: prompt }], {
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

  // Extract JSON (handle markdown code blocks if the model wraps it)
  let jsonStr = text.trim();
  const blockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  const extracted = blockMatch?.[1];
  if (extracted) jsonStr = extracted.trim();

  const parsed = JSON.parse(jsonStr) as unknown;
  const result = TestCatalogSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Catalog JSON failed schema validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}
