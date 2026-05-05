/**
 * Load discovery tools from MCP servers and/or local JS/TS files.
 *
 * MCP: Connects to named servers via HTTP(S) URLs (Streamable HTTP transport), lists tools,
 *      wraps as Mastra tools.
 * Ad-hoc: Loads JS/TS files via jiti; each file's default export must be an object of tools.
 */

import { resolve } from 'node:path';

import { createTool, type Tool } from '@mastra/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createJiti } from 'jiti';
import { z } from 'zod';

import type { DiscoveryOptions } from '../cli/utils.js';
import { getSaifctlRoot } from '../constants.js';
import { consola } from '../logger.js';
import { pathExists } from '../utils/io.js';

const jitiInstance = createJiti(resolve(getSaifctlRoot(), 'src', 'design-discovery', 'tools.ts'), {
  interopDefault: true,
});

/**
 * Parses an MCP config value: HTTP or HTTPS URL (Streamable HTTP transport).
 */
function parseMcpUrl(value: string): URL {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url;
    }
  } catch {
    // fall through to error
  }
  throw new Error(`MCP config must be an HTTP or HTTPS URL (e.g. http://... or https://...).`);
}

interface WrapMcpToolOptions {
  mcpName: string;
  tool: { name: string; description?: string | null; inputSchema?: unknown };
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Wraps an MCP server tool as a Mastra-compatible Tool.
 */
function wrapMcpTool({ mcpName, tool, callTool }: WrapMcpToolOptions): Tool {
  const toolId = `${mcpName}_${tool.name}`;
  // When we call this tool, it calls `client.callTool({ name, arguments })`
  // and returns the raw result.
  return createTool({
    id: toolId,
    description: tool.description ?? `MCP tool ${tool.name} from ${mcpName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async (args) => {
      const result = await callTool({
        name: tool.name,
        arguments: args as Record<string, unknown>,
      });
      return result;
    },
  }) as unknown as Tool;
}

/**
 * Loads tools from an MCP server (HTTP/HTTPS) and returns them as a record of Mastra tools.
 */
async function loadMcpTools(mcpName: string, urlOrValue: string): Promise<Record<string, Tool>> {
  const url = parseMcpUrl(urlOrValue);
  const transport = new StreamableHTTPClientTransport(url);

  const client = new Client({ name: 'saifctl-discovery', version: '1.0.0' }, { capabilities: {} });

  await client.connect(transport);

  const { tools } = await client.listTools();
  const result: Record<string, Tool> = {};
  for (const t of tools) {
    const mastraTool = wrapMcpTool({
      mcpName,
      tool: t,
      callTool: (params) => client.callTool(params),
    });
    result[`${mcpName}_${t.name}`] = mastraTool;
  }

  await transport.close();
  return result;
}

/**
 * Loads tools from a JS/TS file using jiti.
 * Expected export: default { toolName: createTool(...), ... }
 */
async function loadFileTools(filePath: string, projectDir: string): Promise<Record<string, Tool>> {
  const absolutePath = resolve(projectDir, filePath);
  if (!(await pathExists(absolutePath))) {
    consola.error(`Error: discovery tool file not found: ${absolutePath}`);
    process.exit(1);
  }

  const mod = await jitiInstance.import(absolutePath, { default: true });
  const toolsObj = mod ?? {};
  if (typeof toolsObj !== 'object' || toolsObj === null) {
    consola.error(
      `Error: discovery tool file "${filePath}" must export a default object of Mastra tools.`,
    );
    process.exit(1);
  }

  const result: Record<string, Tool> = {};
  for (const [key, val] of Object.entries(toolsObj)) {
    if (val && typeof (val as { execute?: unknown }).execute === 'function') {
      result[key] = val as Tool;
    }
  }
  return result;
}

/**
 * Loads all discovery tools from MCP servers and file paths.
 */
export async function loadDiscoveryTools(
  opts: DiscoveryOptions,
  projectDir: string,
): Promise<Record<string, Tool>> {
  const allTools: Record<string, Tool> = {};

  for (const [name, value] of Object.entries(opts.mcps)) {
    const mcpTools = await loadMcpTools(name, value);
    Object.assign(allTools, mcpTools);
  }

  if (opts.tool) {
    const fileTools = await loadFileTools(opts.tool, projectDir);
    Object.assign(allTools, fileTools);
  }

  return allTools;
}
