/**
 * Validates that Mastra agents, tools, and workflows are properly defined and
 * registered:
 *
 * 1. Each file in src/mastra/agents/ exports at least one static Agent instance.
 * 2. Each file in src/mastra/tools/ exports at least one static Tool instance.
 * 3. Each file in src/mastra/workflows/ exports at least one static Workflow instance.
 * 4. All discovered agents, tools, and workflows are registered on the central
 *    Mastra instance (mastra/index.ts).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Agent } from '@mastra/core/agent';

import { getSaifRoot } from '../../constants.js';
import { mastra } from '../../mastra/index.js';

const MASTRA_DIR = join(getSaifRoot(), 'src', 'mastra');
const AGENTS_DIR = join(MASTRA_DIR, 'agents');
const TOOLS_DIR = join(MASTRA_DIR, 'tools');
const WORKFLOWS_DIR = join(MASTRA_DIR, 'workflows');

/** Detects Mastra Tool instances (from createTool). */
function isTool(v: unknown): v is { id: string; execute: unknown } {
  return (
    v != null &&
    typeof v === 'object' &&
    'id' in (v as object) &&
    'execute' in (v as object) &&
    typeof (v as { execute: unknown }).execute === 'function'
  );
}

/** Detects Mastra Workflow instances (from createWorkflow). */
function isWorkflow(v: unknown): v is { id: string; createRun: unknown } {
  return (
    v != null &&
    typeof v === 'object' &&
    'id' in (v as object) &&
    'createRun' in (v as object) &&
    typeof (v as { createRun: unknown }).createRun === 'function'
  );
}

async function discoverExports<T>(
  dir: string,
  predicate: (v: unknown) => v is T,
): Promise<{ file: string; exports: T[] }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => e.name)
    .sort();

  const results: { file: string; exports: T[] }[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    const exports = (Object.values(mod) as unknown[]).filter(predicate);
    results.push({ file, exports });
  }
  return results;
}

function assertAllPresent<T>(opts: {
  discovered: T[];
  registered: T[] | Record<string, T>;
  kind: string;
  failures: string[];
}): void {
  const { discovered, registered, kind, failures } = opts;
  const regList = Array.isArray(registered) ? registered : Object.values(registered);
  for (const item of discovered) {
    if (!regList.includes(item)) {
      failures.push(
        `${kind}: instance (id: ${(item as { id?: string }).id ?? '?'}) is not registered on the Mastra instance`,
      );
    }
  }
}

export default async function requireMastraAgents(): Promise<void> {
  const failures: string[] = [];

  // 1. Agents
  const agentResults = await discoverExports(AGENTS_DIR, (v): v is Agent => v instanceof Agent);
  for (const { file, exports } of agentResults) {
    if (exports.length === 0) {
      failures.push(
        `agents/${file}: must export at least one static Agent instance (e.g. workerAgent, reviewerAgent)`,
      );
    }
  }
  const allAgents = agentResults.flatMap((r) => r.exports);

  // 2. Tools
  let allTools: { id: string; execute: unknown }[] = [];
  try {
    const toolResults = await discoverExports(TOOLS_DIR, isTool);
    for (const { file, exports } of toolResults) {
      if (exports.length === 0) {
        failures.push(
          `tools/${file}: must export at least one static Tool instance (e.g. readCodebaseTool)`,
        );
      }
    }
    allTools = toolResults.flatMap((r) => r.exports);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT')) {
      throw err;
    }
    // TOOLS_DIR may not exist
  }

  // 3. Workflows
  let allWorkflows: { id: string; createRun: unknown }[] = [];
  try {
    const workflowResults = await discoverExports(WORKFLOWS_DIR, isWorkflow);
    for (const { file, exports } of workflowResults) {
      if (exports.length === 0) {
        failures.push(`workflows/${file}: must export at least one static Workflow instance`);
      }
    }
    allWorkflows = workflowResults.flatMap((r) => r.exports);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT')) {
      throw err;
    }
  }

  // 4. Registration check: all discovered must be on the Mastra instance
  const registeredAgents = mastra.listAgents();
  const registeredTools = mastra.listTools();
  const registeredWorkflows = mastra.listWorkflows();

  assertAllPresent({
    discovered: allAgents,
    registered: registeredAgents,
    kind: 'Agent',
    failures,
  });
  if (registeredTools) {
    assertAllPresent({
      discovered: allTools,
      registered: registeredTools as Record<string, { id: string; execute: unknown }>,
      kind: 'Tool',
      failures,
    });
  } else if (allTools.length > 0) {
    failures.push('Tool: Mastra instance has no tools registered');
  }
  assertAllPresent({
    discovered: allWorkflows,
    registered: registeredWorkflows,
    kind: 'Workflow',
    failures,
  });

  if (failures.length > 0) {
    throw new Error('Mastra validation failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  }

  console.log(
    `All Mastra components validated: ${agentResults.length} agent file(s), ` +
      `${allTools.length} tool(s), ${allWorkflows.length} workflow(s) — all registered.`,
  );
}
