/**
 * Runs the design-discovery phase: gathers context using tools, writes discovery.md.
 *
 * Only runs when discoveryMcps or discoveryTools are configured.
 */

import { join } from 'node:path';

import type { DiscoveryOptions } from '../cli/utils.js';
import type { LlmOverrides } from '../llm-config.js';
import type { Feature } from '../specs/discover.js';
import { type DrainableChunk, drainFullStream } from '../utils/drain-stream.js';
import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { createDiscoveryAgent } from './agent.js';
import { loadDiscoveryTools } from './tools.js';

export interface RunDiscoveryOpts {
  feature: Feature;
  projectDir: string;
  discovery: DiscoveryOptions;
  llm?: LlmOverrides;
  onThought?: (delta: string) => void;
  onEvent?: (chunk: DrainableChunk) => void;
  abortSignal?: AbortSignal;
}

const DISCOVERY_FILENAME = 'discovery.md';

/**
 * Resolves the discovery prompt: inline string or file content.
 */
async function resolveDiscoveryPrompt(opts: DiscoveryOptions): Promise<string | undefined> {
  if (opts.prompt?.trim()) return opts.prompt.trim();
  if (opts.promptFile && (await pathExists(opts.promptFile))) {
    return (await readUtf8(opts.promptFile)).trim();
  }
  return undefined;
}

/**
 * Runs the discovery agent and writes discovery.md.
 */
export async function runDiscovery(opts: RunDiscoveryOpts): Promise<string> {
  const { feature, projectDir, discovery, llm = {}, onThought, onEvent, abortSignal } = opts;

  const proposalPath = join(feature.absolutePath, 'proposal.md');
  const proposalContent = (await pathExists(proposalPath))
    ? await readUtf8(proposalPath)
    : 'No proposal.md found.';

  const userPrompt = await resolveDiscoveryPrompt(discovery);

  const tools = await loadDiscoveryTools(discovery, projectDir);
  if (Object.keys(tools).length === 0) {
    throw new Error('Discovery has no tools. Configure discoveryMcps or discoveryTools (or both).');
  }

  const agent = createDiscoveryAgent({ tools, llm, userPrompt });

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
  await writeUtf8(discoveryPath, output.trim() || '(No content generated.)');

  return discoveryPath;
}
