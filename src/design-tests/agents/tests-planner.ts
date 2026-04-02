import { Agent } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';

import { type LlmOverrides, resolveAgentModel } from '../../llm-config.js';

const PLANNER_INSTRUCTIONS = `You are a senior SDET (Software Development Engineer in Test) specializing in black-box testing.

Your task is to read the provided feature specification files and produce an exhaustive Markdown test plan listing every scenario that needs to be tested.

When available, use queryCodebaseIndex to explore the codebase — e.g. "where are skills defined?", "where are HTTP handlers?", "how does the CLI parse args?" — to ground your test plan in actual code structure.

Apply these design techniques:
- **Equivalence partitioning** — Representative inputs from each equivalence class
- **Boundary value analysis** — Min/max, off-by-one, empty string, zero, null
- **State transitions** — Create → verify → update → delete flows
- **Failure modes** — 4xx, 5xx, validation errors, unauthorized access, malformed payloads

For each test case you identify, write a short bullet with:
- What is being tested
- The input / stimulus (command, HTTP request, etc.)
- The expected outcome (exit code, response status, body, stdout/stderr)
- Which spec section / acceptance criterion it traces to
- Whether it should be **public** (visible to coder) or **hidden** (holdout for mutual verification):
  - Public: core happy paths, setup/teardown, explicit spec requirements
  - Hidden: isomorphic variations, boundaries, negative/security paths, complex state mutations

Organize the list by category: happy_path, boundary, negative, error_handling.

Output ONLY the Markdown plan — no commentary, no preamble.`;

/**
 * Creates a TestsPlanner agent, Step 1a of the tests design workflow.
 *
 * Reads all files from the feature's spec directory and produces a plain
 * Markdown tests.md that exhaustively enumerates every scenario to test.
 * This acts as a "Chain of Thought" scratchpad before the structured JSON
 * catalog is generated in Step 1b.
 *
 * Optionally wired to a codebase index tool.
 *
 * When `indexerTool` is provided (from an IndexerProfile), the agent can call the
 * `queryCodebaseIndex` tool to explore the actual codebase structure while planning tests.
 */
export function createTestsPlannerAgent(indexerTool?: Tool, llm: LlmOverrides = {}) {
  return new Agent({
    id: 'tests-planner',
    name: 'TestsPlanner',
    instructions: PLANNER_INSTRUCTIONS,
    model: resolveAgentModel('tests-planner', llm),
    tools: indexerTool ? { queryCodebaseIndex: indexerTool } : {},
  });
}

/**
 * Builds the prompt for the planner agent.
 *
 * @param specFiles - Map of filename → file content for all files in the spec dir
 * @param extraPrompt - Optional additional instruction to refine the plan
 */
export function buildPlannerPrompt(
  specFiles: Record<string, string>,
  extraPrompt?: string,
): string {
  const fileSection = Object.entries(specFiles)
    .map(([name, content]) => `=== ${name} ===\n${content}`)
    .join('\n\n');

  const refinement = extraPrompt ? `\n\nAdditional instruction: ${extraPrompt}` : '';

  return `Here are all the specification files for this feature:\n\n${fileSection}${refinement}\n\nProduce the exhaustive Markdown test plan now.`;
}
