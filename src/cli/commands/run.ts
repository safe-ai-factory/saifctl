#!/usr/bin/env tsx
/**
 * Run CLI — manage and resume stored runs.
 *
 * Usage: saifac run <subcommand> [options]
 *   ls, list      List stored runs
 *   rm, remove    Delete a run
 *   info          Print stored run as JSON
 *   clear         Clear stored runs (optionally filtered)
 *   resume        Resume a stored run from storage
 *   test          Re-test a stored run's patch (no coding agent)
 */

import { defineCommand, runMain } from 'citty';

import { loadSaifacConfig } from '../../config/load.js';
import { type SaifacConfig } from '../../config/schema.js';
import type { ModelOverrides } from '../../llm-config.js';
import { consola, outputCliData, setVerboseLogging } from '../../logger.js';
import { runResume, runTestsFromRun } from '../../orchestrator/modes.js';
import {
  type OrchestratorCliInput,
  parseModelOverridesCliDelta,
} from '../../orchestrator/options.js';
import { toRunInfoJson } from '../../runs/utils/run-info.js';
import { featResumeArgs, projectDirArg, runTestArgs, saifDirArg, storageArg } from '../args.js';
import {
  buildOrchestratorCliInputFromFeatArgs,
  type FeatRunArgs,
  parseRunId,
  readProjectDirFromCli,
  readSaifDirFromCli,
  readStorageStringFromCli,
  resolveCliProjectDir,
  resolveRunStorage,
  resolveSaifDirRelative,
} from '../utils.js';

/** CLI parsing for `saifac run resume` */
async function parseResumeOrchestratorCli(args: FeatRunArgs): Promise<{
  projectDir: string;
  saifDir: string;
  config: SaifacConfig;
  cli: OrchestratorCliInput;
  cliModelDelta: ModelOverrides | undefined;
}> {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
  const config = await loadSaifacConfig(saifDir, projectDir);
  setVerboseLogging(args.verbose === true);
  const cli = await buildOrchestratorCliInputFromFeatArgs(args, { projectDir, saifDir, config });
  const cliModelDelta = parseModelOverridesCliDelta(args);
  return { projectDir, saifDir, config, cli, cliModelDelta };
}

const commonRunArgs = {
  'project-dir': projectDirArg,
  'saifac-dir': saifDirArg,
  storage: storageArg,
};

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List stored runs',
  },
  args: {
    ...commonRunArgs,
    task: {
      type: 'string' as const,
      description: 'Filter by task ID',
    },
    status: {
      type: 'string' as const,
      description: 'Filter by status (failed, completed, etc.)',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
    const config = await loadSaifacConfig(saifDir, projectDir);
    const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!storage) {
      outputCliData('Run storage is disabled (--storage none).');
      return;
    }

    const runs = (
      await storage.listRuns({
        taskId: typeof args.task === 'string' ? args.task : undefined,
        status:
          typeof args.status === 'string' ? (args.status as 'failed' | 'completed') : undefined,
      })
    ).slice();
    runs.sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return a.runId.localeCompare(b.runId);
    });
    if (runs.length === 0) {
      outputCliData('No stored runs found.');
      return;
    }

    // Table headers
    const hRunId = 'RUN_ID';
    const hFeature = 'FEATURE';
    const hStatus = 'STATUS';
    const hStarted = 'STARTED';
    const hUpdated = 'UPDATED';

    const wRunId = Math.max(hRunId.length, ...runs.map((r) => r.runId.length));
    const wFeature = Math.max(hFeature.length, ...runs.map((r) => r.config.featureName.length));
    const wStatus = Math.max(hStatus.length, ...runs.map((r) => r.status.length));
    const startedStr = (r: (typeof runs)[number]) => r.startedAt ?? '';
    const wStarted = Math.max(hStarted.length, ...runs.map((r) => startedStr(r).length));
    const wUpdated = Math.max(hUpdated.length, ...runs.map((r) => r.updatedAt.length));

    /* eslint-disable-next-line max-params */
    const row = (a: string, b: string, c: string, d: string, e: string) =>
      `  ${a.padEnd(wRunId)}  ${b.padEnd(wFeature)}  ${c.padEnd(wStatus)}  ${d.padEnd(wStarted)}  ${e.padEnd(wUpdated)}`;

    outputCliData(`${runs.length} run(s):\n`);
    outputCliData(row(hRunId, hFeature, hStatus, hStarted, hUpdated));
    for (const r of runs) {
      outputCliData(row(r.runId, r.config.featureName, r.status, startedStr(r), r.updatedAt));
    }
  },
});

const rmCommand = defineCommand({
  meta: {
    name: 'rm',
    description: 'Delete a stored run',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to delete',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
    const config = await loadSaifacConfig(saifDir, projectDir);
    const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!storage) {
      consola.error('Run storage is disabled (--storage none).');
      process.exit(1);
    }
    const runId = parseRunId(args);

    const existing = await storage.getRun(runId);
    if (!existing) {
      consola.error(`Run not found: ${runId}`);
      process.exit(1);
    }
    await storage.deleteRun(runId);
    consola.log(`Deleted run ${runId}`);
  },
});

const infoCommand = defineCommand({
  meta: {
    name: 'info',
    description: 'Print a stored run as JSON (omits diffs; script paths only)',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to show',
      required: true,
    },
    pretty: {
      type: 'boolean' as const,
      default: true,
      description: 'Pretty-print JSON (default: true). Use --no-pretty for one line.',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
    const config = await loadSaifacConfig(saifDir, projectDir);
    const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!storage) {
      consola.error('Run storage is disabled (--storage none).');
      process.exit(1);
    }
    const runId = parseRunId(args);

    const artifact = await storage.getRun(runId);
    if (!artifact) {
      consola.error(`Run not found: ${runId}`);
      process.exit(1);
    }

    const view = toRunInfoJson(artifact);
    const pretty = args.pretty !== false;
    outputCliData(JSON.stringify(view, null, pretty ? 2 : undefined));
  },
});

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Clear stored runs',
  },
  args: {
    ...commonRunArgs,
    failed: {
      type: 'boolean' as const,
      description: 'Clear only failed runs',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
    const config = await loadSaifacConfig(saifDir, projectDir);
    const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!storage) {
      outputCliData('Run storage is disabled (--storage none).');
      return;
    }
    const filter = args.failed ? { status: 'failed' as const } : undefined;
    const runs = await storage.listRuns(filter);
    for (const r of runs) {
      await storage.deleteRun(r.runId);
      outputCliData(`  removed ${r.runId}`);
    }
    outputCliData(`\nCleared ${runs.length} run(s).`);
  },
});

const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description: 'Resume a stored run from storage (failed or interrupted)',
  },
  args: {
    ...commonRunArgs,
    ...featResumeArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to resume',
      required: true,
    },
  },
  async run({ args }) {
    const runArgs = args as FeatRunArgs;
    const ctx = await parseResumeOrchestratorCli(runArgs);
    const runStorage = resolveRunStorage(
      readStorageStringFromCli(runArgs),
      ctx.projectDir,
      ctx.config,
    );
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot resume.');
      process.exit(1);
    }
    const runId = parseRunId(args);

    const result = await runResume({
      ...ctx,
      runId,
      runStorage,
    });

    consola.log(`\n${result.message}`);
    if (result.runId) {
      consola.log(`\nResume again with:`);
      consola.log(`  saifac run resume ${result.runId}`);
    }
    if (!result.success) process.exit(1);
  },
});

const testCommand = defineCommand({
  meta: {
    name: 'test',
    description: "Re-test a stored run's patch (no coding agent). Optionally push/PR on success.",
  },
  args: {
    ...runTestArgs,
    runId: {
      type: 'positional' as const,
      description: "Run ID to test (from 'run list')",
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifDir = resolveSaifDirRelative(readSaifDirFromCli(args));
    const config = await loadSaifacConfig(saifDir, projectDir);

    const runArgs = args as FeatRunArgs;
    setVerboseLogging(runArgs.verbose === true);

    const runStorage = resolveRunStorage(readStorageStringFromCli(runArgs), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot test a stored run.');
      process.exit(1);
    }

    const runId = parseRunId(args);
    const cli = await buildOrchestratorCliInputFromFeatArgs(runArgs, {
      projectDir,
      saifDir,
      config,
    });
    const cliModelDelta = parseModelOverridesCliDelta(runArgs);

    consola.log(`\nRe-testing stored run: ${runId}`);

    const result = await runTestsFromRun({
      runId,
      runStorage,
      projectDir,
      saifDir,
      config,
      cli,
      cliModelDelta,
    });

    consola.log(`\n${result.message}`);
    if (!result.success) process.exit(1);
  },
});

const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Manage and resume stored runs',
  },
  subCommands: {
    ls: lsCommand,
    list: lsCommand,
    rm: rmCommand,
    remove: rmCommand,
    info: infoCommand,
    clear: clearCommand,
    resume: resumeCommand,
    test: testCommand,
  },
});

export default runCommand;

// Allow running as a script: `tsx src/cli/commands/run.ts`
if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  void runMain(runCommand);
}
