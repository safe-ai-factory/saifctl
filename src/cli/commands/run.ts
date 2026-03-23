#!/usr/bin/env tsx
/**
 * Run CLI — manage and resume stored runs.
 *
 * Usage: saifac run <subcommand> [options]
 *   ls, list      List stored runs
 *   rm, remove    Delete a run
 */

import { defineCommand, runMain } from 'citty';

import { loadSaifConfig } from '../../config/load.js';
import { consola } from '../../logger.js';
import { projectDirArg, saifDirArg, storageArg } from '../args.js';
import { parseProjectDir, parseRunId, parseRunStorage, parseSaifDir } from '../utils.js';

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
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const storage = parseRunStorage(args, projectDir, config);
    if (!storage) {
      consola.log('Run storage is disabled (--storage none).');
      return;
    }

    const runs = await storage.listRuns({
      taskId: typeof args.task === 'string' ? args.task : undefined,
      status: typeof args.status === 'string' ? (args.status as 'failed' | 'completed') : undefined,
    });
    if (runs.length === 0) {
      consola.log('No stored runs found.');
      return;
    }

    // Table headers
    const hRunId = 'RUN ID';
    const hFeature = 'FEATURE';
    const hStatus = 'STATUS';
    const hUpdated = 'UPDATED';

    const wRunId = Math.max(hRunId.length, ...runs.map((r) => r.runId.length));
    const wFeature = Math.max(hFeature.length, ...runs.map((r) => r.config.featureName.length));
    const wStatus = Math.max(hStatus.length, ...runs.map((r) => r.status.length));
    const wUpdated = Math.max(hUpdated.length, ...runs.map((r) => r.updatedAt.length));

    /* eslint-disable-next-line max-params */
    const row = (a: string, b: string, c: string, d: string) =>
      `  ${a.padEnd(wRunId)}  ${b.padEnd(wFeature)}  ${c.padEnd(wStatus)}  ${d.padEnd(wUpdated)}`;

    consola.log(`${runs.length} run(s):\n`);
    consola.log(row(hRunId, hFeature, hStatus, hUpdated));
    for (const r of runs) {
      consola.log(row(r.runId, r.config.featureName, r.status, r.updatedAt));
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
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const storage = parseRunStorage(args, projectDir, config);
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
  },
});

export default runCommand;

// Allow running as a script: `tsx src/cli/commands/run.ts`
if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  void runMain(runCommand);
}
