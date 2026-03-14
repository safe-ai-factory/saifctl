/**
 * Discovery agent — gathers context before design-specs using tools.
 *
 * Use this to:
 * - Gather intel from outside of this project's codebase (e.g. API schemas, system diagrams)
 * - Do custom research beyond what Shotgun can do (e.g. Jira tickets, external docs)
 *
 * Base preamble is hardcoded; user prompt (from --discovery-prompt or --discovery-prompt-file)
 * is appended as additional instructions.
 */

import { Agent } from '@mastra/core/agent';
import type { Tool } from '@mastra/core/tools';

import { type ModelOverrides, resolveAgentModel } from '../llm-config.js';

const DISCOVERY_PREAMBLE = `You are the Context Discovery Agent working on a feature proposal.

Your objective is to read the user's feature proposal and use your available tools to gather necessary architectural, API, and system context before the feature is designed.

Output your findings as a structured markdown document. Focus on facts, constraints, and schemas that will prevent the downstream designer from hallucinating.`;

/**
 * Builds the full system prompt: preamble + optional user instructions.
 */
export function buildDiscoverySystemPrompt(userPrompt?: string): string {
  if (!userPrompt?.trim()) return DISCOVERY_PREAMBLE;
  return `${DISCOVERY_PREAMBLE}

### User Instructions & Rules:

${userPrompt.trim()}`;
}

/**
 * Creates the Discovery agent with the given tools.
 * @param userPrompt - Optional user instructions (from `--discovery-prompt` or `--discovery-prompt-file`)
 */
export function createDiscoveryAgent(
  tools: Record<string, Tool>,
  modelConfig: ModelOverrides = {},
  userPrompt?: string,
): Agent {
  return new Agent({
    id: 'discovery',
    name: 'DiscoveryAgent',
    instructions: buildDiscoverySystemPrompt(userPrompt),
    model: resolveAgentModel('discovery', modelConfig),
    tools,
  });
}
