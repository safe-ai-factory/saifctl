/**
 * Tests design workflow — orchestrates the two-step design pipeline:
 *
 * Step 1a: Planner agent reads spec files → produces tests.md (Markdown CoT)
 * Step 1b: Catalog agent reads tests.md + spec files → produces tests.json
 *
 * Outputs are written to saif/features/<featureName>/tests/
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tool } from '@mastra/core/tools';

import type { IndexerProfile } from '../indexer-profiles/index.js';
import { type ModelOverrides } from '../llm-config.js';
import type { Feature } from '../specs/discover.js';
import { type TestProfile } from '../test-profiles/index.js';
import { type DrainableChunk, drainFullStream } from '../utils/drain-stream.js';
import { runCatalogAgent } from './agents/tests-catalog.js';
import { buildPlannerPrompt, createTestsPlannerAgent } from './agents/tests-planner.js';
import type { TestCatalog } from './schema.js';

export interface RunTestsDesignOpts {
  /** Resolved feature (name, absolutePath, relativePath). */
  feature: Feature;
  /** Absolute path to the project directory */
  projectDir: string;
  /** Optional extra instruction for refinement (e.g. --prompt "Add holdout tests for DB") */
  extraPrompt?: string;
  /**
   * Indexer profile to use for codebase querying.
   * When provided, agents receive a `queryCodebaseIndex` tool backed by this profile.
   * When omitted, agents run without codebase search capability.
   */
  indexerProfile?: IndexerProfile;
  /**
   * Project name — passed to indexerProfile.getMastraTool() so the tool can locate
   * the correct index. Must match the name used during `saif init`.
   */
  projectName: string;
  /** Test profile determines entrypoint naming rules for catalog generation. Defaults to vitest. */
  testProfile: TestProfile;
  /** CLI-level model overrides (--model). */
  overrides?: ModelOverrides;
  /** Called with each text delta from the LLM (for live display) */
  onThought?: (delta: string) => void;
  /** Called with every fullStream chunk */
  onEvent?: (chunk: DrainableChunk) => void;
  abortSignal?: AbortSignal;
}

export interface RunTestsDesignResult {
  testPlanPath: string;
  catalogPath: string;
  testCaseCount: number;
}

/**
 * Reads all spec files from the feature directory (recursively, text files only).
 * Returns a map of relative path → file content.
 */
function readFeatureFiles(featureDir: string): Record<string, string> {
  const files: Record<string, string> = {};

  function walk(dir: string, prefix: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && /\.(md|json|txt|yaml|yml)$/.test(entry.name)) {
        try {
          files[relPath] = readFileSync(fullPath, 'utf8');
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(featureDir, '');
  return files;
}

const QUERY_CODEBASE_INDEX_TOOL_ID = 'queryCodebaseIndex';

/**
 * Guard: asserts that a tool returned by getMastraTool has `id` and `execute`, and id === queryCodebaseIndex.
 * Throws on invalid shape or wrong id.
 */
function guardIndexerTool(raw: unknown, indexerProfile: IndexerProfile): asserts raw is Tool {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `Indexer profile "${indexerProfile.displayName}" returned an invalid tool: must be an object.`,
    );
  }
  const tool = raw as { id?: unknown; execute?: unknown };
  if (typeof tool.id !== 'string') {
    throw new Error(
      `Indexer profile "${indexerProfile.displayName}" returned an invalid tool: must have string \`id\`.`,
    );
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(
      `Indexer profile "${indexerProfile.displayName}" returned an invalid tool: must have function \`execute\`.`,
    );
  }
  if (tool.id !== QUERY_CODEBASE_INDEX_TOOL_ID) {
    throw new Error(
      `Indexer profile "${indexerProfile.displayName}" returned tool with id "${tool.id}" ` +
        `instead of "${QUERY_CODEBASE_INDEX_TOOL_ID}".`,
    );
  }
}

/**
 * Runs the full two-step tests design pipeline for a feature.
 *
 * Produces:
 *   saif/features/<featureName>/tests/tests.md
 *   saif/features/<featureName>/tests/tests.json
 */
export async function runDesignTests(opts: RunTestsDesignOpts): Promise<RunTestsDesignResult> {
  const {
    feature,
    projectDir,
    extraPrompt,
    indexerProfile,
    projectName,
    testProfile,
    overrides = {},
    onThought,
    onEvent,
    abortSignal,
  } = opts;

  // See e.g. src/indexer-profiles/shotgun/profile.ts
  const rawIndexerTool = await indexerProfile?.getMastraTool({ projectDir, projectName });
  let indexerTool: Tool | undefined;
  if (indexerProfile && rawIndexerTool) {
    guardIndexerTool(rawIndexerTool, indexerProfile);
    indexerTool = rawIndexerTool;
  } else {
    indexerTool = undefined;
  }

  const testsDir = join(feature.absolutePath, 'tests');

  console.log(`[design-tests:plan] Reading spec files from ${feature.absolutePath}`);
  const featureFiles = readFeatureFiles(feature.absolutePath);

  if (Object.keys(featureFiles).length === 0) {
    throw new Error(
      `No spec files found in ${feature.absolutePath}. ` +
        `Run 'pnpm shotgun' first or ensure the feature directory exists.`,
    );
  }

  console.log(`[design-tests:plan] Found ${Object.keys(featureFiles).length} spec files`);
  if (indexerTool) {
    console.log(
      `[design-tests:plan] Codebase index: ${indexerProfile!.displayName} (project: ${projectName})`,
    );
  }
  console.log(`[design-tests:plan] Step 1a: Generating test plan...`);

  // Step 1a: Planner agent → Markdown test plan
  const plannerPrompt = buildPlannerPrompt(featureFiles, extraPrompt);
  const plannerAgent = createTestsPlannerAgent(indexerTool, overrides);

  // Run the planner agent
  // prettier-ignore
  const plannerStream = await plannerAgent.stream(
    [{ role: 'user', content: plannerPrompt }],
    { ...(abortSignal ? { abortSignal } : {}) },
  );

  // Collect text from the stream
  let testPlan = '';
  await drainFullStream(plannerStream.fullStream as ReadableStream<DrainableChunk>, {
    onThought: (delta) => {
      testPlan += delta;
      onThought?.(delta);
    },
    onEvent,
  });

  // Also await the text stream to ensure full completion
  if (!testPlan) {
    testPlan = await plannerStream.text;
  }

  if (!testPlan.trim()) {
    throw new Error('Planner agent returned empty test plan');
  }

  // Write tests.md
  mkdirSync(testsDir, { recursive: true });
  const testPlanPath = join(testsDir, 'tests.md');
  writeFileSync(testPlanPath, testPlan, 'utf8');
  console.log(`[design-tests:plan] Step 1a complete → ${testPlanPath}`);

  console.log(`[design-tests:plan] Step 1b: Generating tests.json...`);

  let catalog: TestCatalog;
  try {
    // Step 1b: Catalog agent → structured JSON catalog
    catalog = await runCatalogAgent({
      featureName: feature.name,
      featureDir: feature.relativePath,
      featureFiles,
      testPlan,
      extraPrompt,
      indexerTool,
      testProfile,
      overrides,
      onThought,
      onEvent,
      abortSignal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Step 1b (catalog agent) failed: ${msg}. ` +
        `Check API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) and model config.`,
      { cause: err },
    );
  }

  const catalogPath = join(testsDir, 'tests.json');
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`[design-tests:plan] Step 1b complete → ${catalogPath}`);

  return {
    testPlanPath,
    catalogPath,
    testCaseCount: catalog.testCases.length,
  };
}
