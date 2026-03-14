/**
 * Runs the design-discovery phase: gathers context using tools, writes discovery.md.
 *
 * Only runs when discoveryMcps or discoveryTools are configured.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DiscoveryOptions } from '../cli/utils.js';
import type { ModelOverrides } from '../llm-config.js';
import type { Feature } from '../specs/discover.js';
import { type DrainableChunk, drainFullStream } from '../utils/drain-stream.js';
import { createDiscoveryAgent } from './agent.js';
import { loadDiscoveryTools } from './tools.js';

export interface RunDiscoveryOpts {
  feature: Feature;
  projectDir: string;
  discovery: DiscoveryOptions;
  overrides?: ModelOverrides;
  onThought?: (delta: string) => void;
  onEvent?: (chunk: DrainableChunk) => void;
  abortSignal?: AbortSignal;
}

const DISCOVERY_FILENAME = 'discovery.md';

/**
 * Resolves the discovery prompt: inline string or file content.
 */
function resolveDiscoveryPrompt(opts: DiscoveryOptions): string | undefined {
  if (opts.prompt?.trim()) return opts.prompt.trim();
  if (opts.promptFile && existsSync(opts.promptFile)) {
    return readFileSync(opts.promptFile, 'utf8').trim();
  }
  return undefined;
}

/**
 * Runs the discovery agent and writes discovery.md.
 */
export async function runDiscovery(opts: RunDiscoveryOpts): Promise<string> {
  const { feature, projectDir, discovery, overrides = {}, onThought, onEvent, abortSignal } = opts;

  const proposalPath = join(feature.absolutePath, 'proposal.md');
  const proposalContent = existsSync(proposalPath)
    ? readFileSync(proposalPath, 'utf8')
    : 'No proposal.md found.';

  const userPrompt = resolveDiscoveryPrompt(discovery);

  const tools = await loadDiscoveryTools(discovery, projectDir);
  if (Object.keys(tools).length === 0) {
    throw new Error('Discovery has no tools. Configure discoveryMcps or discoveryTools (or both).');
  }

  const agent = createDiscoveryAgent(tools, overrides, userPrompt);

  const userMessage = `Here is the feature proposal:

${proposalContent}

Gather all necessary context using your tools, then output a structured markdown document (discovery.md) with your findings.`;

  const stream = await agent.stream([{ role: 'user', content: userMessage }], {
    ...(abortSignal ? { abortSignal } : {}),
  });

  let output = '';
  await drainFullStream(stream.fullStream as ReadableStream<DrainableChunk>, {
    onThought: (delta) => {
      output += delta;
      onThought?.(delta);
    },
    onEvent,
  });

  if (!output) {
    output = await stream.text;
  }

  const discoveryPath = join(feature.absolutePath, DISCOVERY_FILENAME);
  writeFileSync(discoveryPath, output.trim() || '(No content generated.)', 'utf8');

  return discoveryPath;
}
