/**
 * Shotgun indexer profile.
 *
 * Uses `shotgun-sh` to build and query an AST-aware codebase graph.
 *
 * Environment variables:
 *   SHOTGUN_PYTHON    — Path to the Python binary that has shotgun-sh installed
 *                       (default: "python"). Example: SHOTGUN_PYTHON=$(uv run which python)
 *   CONTEXT7_API_KEY  — (optional) API key for Context7 documentation lookup in Shotgun
 *
 * Indexing is done during `saifctl init`:
 *   <python> -m shotgun.main config init
 *   <python> -m shotgun.main config set-context7 --api-key <key>  (if CONTEXT7_API_KEY is set)
 *   <python> -m shotgun.main codebase index . --name <projectName>
 *
 * Querying uses `<python> -m shotgun.main codebase query <graphId> "<question>"`.
 * The graphId is resolved at query-time from `codebase list` by matching the
 * project name — this is an implementation detail hidden from callers.
 */

import { createTool, type Tool } from '@mastra/core/tools';
import { z } from 'zod';

import { consola } from '../../logger.js';
import type { IndexerGetToolOpts, IndexerInitOpts, IndexerProfile } from '../types.js';
import { queryShotgunIndex, runShotgunCapture, runShotgunCli } from './shotgun.js';

interface ShotgunGraph {
  graph_id: string;
  name: string;
  status: string;
}

/** Indexer profile that builds and queries an AST-aware codebase graph via the `shotgun-sh` CLI. */
export const shotgunIndexerProfile: IndexerProfile = {
  id: 'shotgun',
  displayName: 'Shotgun',

  async init({ projectDir, projectName }: IndexerInitOpts): Promise<void> {
    const context7Key = process.env.CONTEXT7_API_KEY?.trim();

    await runShotgunCli(['config', 'init'], { projectDir, printCmd: true });

    // Optionally set Context7 integration with Shotgun
    if (context7Key) {
      await runShotgunCli(['config', 'set-context7', '--api-key', context7Key], {
        projectDir,
        printCmd: true,
      });
    } else {
      consola.log('CONTEXT7_API_KEY not set — skipping Context7 configuration (optional).');
    }

    // Index the codebase
    await runShotgunCli(['codebase', 'index', '.', '--name', projectName], {
      projectDir,
      printCmd: true,
    });
  },

  getMastraTool({ projectDir, projectName }: IndexerGetToolOpts): Tool {
    return createTool({
      id: 'queryCodebaseIndex',
      description:
        'Query the codebase index with a natural language question. Returns AST-aware results ' +
        '(modules, classes, functions, files, folders). Use to find where things are defined, ' +
        'how components relate, etc. ' +
        'Requires the codebase to be indexed first via `saifctl init`.',
      inputSchema: z.object({
        question: z
          .string()
          .describe(
            'Natural language question about the codebase, e.g. "where are skills defined?" or "how does auth work?"',
          ),
      }),
      execute: async ({ question }: { question: string }) => {
        const graphId = await resolveGraphId(projectName, projectDir);
        if (!graphId) {
          throw new Error(
            `Could not find a READY Shotgun index for project "${projectName}". ` +
              'Run `saifctl init` to index the codebase first.',
          );
        }
        const result = await queryShotgunIndex({ graphId, question, projectDir });
        return result.raw;
      },
    }) as unknown as Tool;
  },
};

/**
 * Returns the graph ID of the first READY codebase whose `name` field exactly
 * matches `projectName`. Falls back to the first READY entry if no exact match.
 */
async function resolveGraphId(projectName: string, projectDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await runShotgunCapture(['codebase', 'list', '--format', 'json'], {
      projectDir,
      printCmd: true,
    });
  } catch {
    return null;
  }

  let graphs: ShotgunGraph[];
  try {
    const parsed = JSON.parse(raw) as { graphs?: ShotgunGraph[] };
    graphs = parsed.graphs ?? [];
  } catch {
    return null;
  }

  const ready = graphs.filter((g) => g.status === 'READY');
  const exact = ready.find((g) => g.name === projectName);
  return exact?.graph_id ?? ready[0]?.graph_id ?? null;
}
