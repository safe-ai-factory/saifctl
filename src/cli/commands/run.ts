#!/usr/bin/env tsx
/**
 * Run CLI — manage Runs and start again from artifacts.
 *
 * Usage: saifctl run <subcommand> [options]
 *   ls, list      List Runs
 *   rm, remove    Delete a run
 *   info          Print Run as JSON
 *   get           Print full Run artifact as JSON (for tooling)
 *   clear         Clear Runs (optionally filtered)
 *   fork          Clone a Run to a new ID
 *   start         Start again from a Run (artifact)
 *   test          Re-test a Run's patch (no coding agent)
 *   apply         Create git branch with run's changes and optional push/PR
 *   export        Export run's changes as a single diff
 *   inspect       Open an idle coding container for a Run
 *   rules         Manage user feedback rules on a Run (create, list, get, update, remove)
 *   pause         Pause a run. Resumable. Stops containers but does not delete them. Waits until paused or --timeout
 *   resume        Resume a paused run: reuse cached state if still present; otherwise continue like run start
 *   stop          Stop a running or paused run (full teardown). Waits up to --timeout; use --force if a run looks stuck.
 */

import { defineCommand, runMain } from 'citty';

import { loadSaifctlConfig } from '../../config/load.js';
import { type SaifctlConfig } from '../../config/schema.js';
import type { LlmOverrides } from '../../llm-config.js';
import { consola, outputCliData, setVerboseLogging } from '../../logger.js';
import {
  fromArtifact,
  runApply,
  runExport,
  runInspect,
  runPause,
  runResume,
  runStop,
  runTestsFromRun,
} from '../../orchestrator/modes.js';
import {
  type OrchestratorCliInput,
  parseLlmOverridesCliDelta,
} from '../../orchestrator/options.js';
import { forkStoredRun } from '../../runs/fork.js';
import { RunCannotPauseError, RunCannotStopError, type RunStatus } from '../../runs/types.js';
import { toRunInfoJson } from '../../runs/utils/run-info.js';
import { isRunStatusDeletable } from '../../runs/utils/statuses.js';
import { omit } from '../../utils/omit.js';
import {
  featFromArtifactArgs,
  featRunArgs,
  projectDirArg,
  runTestArgs,
  saifctlDirArg,
  storageArg,
} from '../args.js';
import {
  buildOrchestratorCliInputFromFeatArgs,
  type FeatRunArgs,
  getFeatNameFromArgs,
  parseRunId,
  readEngineCliFromCli,
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  readStorageStringFromCli,
  resolveCliProjectDir,
  resolveRunStorage,
  resolveSaifctlDirRelative,
} from '../utils.js';
import { runRulesCommand } from './run-rules.js';

/** CLI parsing for `saifctl run start` */
async function parseFromArtifactOrchestratorCli(args: FeatRunArgs): Promise<{
  projectDir: string;
  saifctlDir: string;
  config: SaifctlConfig;
  cli: OrchestratorCliInput;
  cliModelDelta: LlmOverrides | undefined;
  engineCli: string | undefined;
}> {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const config = await loadSaifctlConfig(saifctlDir, projectDir);
  setVerboseLogging(args.verbose === true);
  const cli = await buildOrchestratorCliInputFromFeatArgs(args, { projectDir, saifctlDir, config });
  const cliModelDelta = parseLlmOverridesCliDelta(args);
  const engineCli = readEngineCliFromCli(args);
  return { projectDir, saifctlDir, config, cli, cliModelDelta, engineCli };
}

const commonRunArgs = {
  'project-dir': projectDirArg,
  'saifctl-dir': saifctlDirArg,
  storage: storageArg,
};

const DEFAULT_RUN_PAUSE_STOP_TIMEOUT_SEC = 60;

const runPauseStopTimeoutArg = {
  type: 'string' as const,
  valueHint: 'sec',
  default: String(DEFAULT_RUN_PAUSE_STOP_TIMEOUT_SEC),
};

function parseRunPauseStopTimeoutSec(args: { timeout?: string }): number {
  const raw = (args.timeout ?? String(DEFAULT_RUN_PAUSE_STOP_TIMEOUT_SEC)).trim();
  if (!/^\d+$/.test(raw)) {
    consola.error(`Invalid --timeout: expected a non-negative integer (seconds), got "${raw}"`);
    process.exit(1);
  }
  return parseInt(raw, 10);
}

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List Runs',
  },
  args: {
    ...commonRunArgs,
    task: {
      type: 'string' as const,
      description: 'Filter by task ID',
    },
    status: {
      type: 'string' as const,
      description: 'Filter by status (failed, completed, running, paused, etc.)',
    },
    format: {
      type: 'string' as const,
      default: 'table',
      description: 'Output format: table (default) or json',
    },
    pretty: {
      type: 'boolean' as const,
      default: true,
      description:
        'When --format json: pretty-print (default: true). Use --no-pretty for one line.',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);

    const formatRaw = (args.format ?? 'table').trim().toLowerCase();
    if (formatRaw !== 'table' && formatRaw !== 'json') {
      consola.error(`Invalid --format: expected "table" or "json", got "${args.format}"`);
      process.exit(1);
    }

    if (!storage) {
      if (formatRaw === 'json') {
        outputCliData(JSON.stringify(null));
      } else {
        outputCliData('Run storage is disabled (--storage none).');
      }
      return;
    }

    const runs = (
      await storage.listRuns({
        taskId: typeof args.task === 'string' ? args.task : undefined,
        status: typeof args.status === 'string' ? (args.status as RunStatus) : undefined,
      })
    ).slice();
    runs.sort((a, b) => {
      const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
      if (byUpdated !== 0) return byUpdated;
      return a.runId.localeCompare(b.runId);
    });

    if (formatRaw === 'json') {
      const rows = runs.map((r) => ({
        runId: r.runId,
        featureName: r.config.featureName,
        specRef: r.specRef,
        status: r.status,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        ...(r.taskId != null && r.taskId !== '' ? { taskId: r.taskId } : {}),
      }));
      const pretty = args.pretty !== false;
      outputCliData(JSON.stringify(rows, null, pretty ? 2 : undefined));
      return;
    }

    if (runs.length === 0) {
      outputCliData('No Runs found.');
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
    description: 'Delete a Run',
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
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
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

    if (!isRunStatusDeletable(existing.status)) {
      consola.error(
        `Run "${runId}" cannot be removed while status is "${existing.status}". ` +
          `Only failed or completed runs can be deleted; stop or wait for other states first.`,
      );
      process.exit(1);
    }

    await storage.deleteRun(runId);
    consola.log(`Deleted run ${runId}`);
  },
});

const infoCommand = defineCommand({
  meta: {
    name: 'info',
    description: 'Print a Run as JSON (omits diffs; script paths only)',
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
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
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

const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Print full Run object as JSON',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to fetch',
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
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
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

    const pretty = args.pretty !== false;
    outputCliData(JSON.stringify(artifact, null, pretty ? 2 : undefined));
  },
});

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Clear Runs',
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
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
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

const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description:
      'Open an idle coding container for a Run. Changes made in the container are saved.',
  },
  args: {
    ...commonRunArgs,
    ...omit(featFromArtifactArgs, ['dangerous-no-leash']),
    leash: {
      type: 'boolean' as const,
      description:
        'Use Leash/Cedar in the inspect session (same constraints as the coding agent). Default is plain Docker so you can git commit inside the container.',
    },
    runId: {
      type: 'positional' as const,
      description: 'Run ID to inspect',
      required: true,
    },
  },
  async run({ args }) {
    // `leash` is a special option for `run inspect` only
    const runArgs = args as FeatRunArgs & { leash?: boolean };
    const ctx = await parseFromArtifactOrchestratorCli(runArgs);
    const runStorage = resolveRunStorage(
      readStorageStringFromCli(runArgs),
      ctx.projectDir,
      ctx.config,
    );
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot inspect a Run.');
      process.exit(1);
    }
    const runId = parseRunId(args);

    await runInspect({
      ...ctx,
      runId,
      runStorage,
      inspectLeash: !!runArgs.leash,
    });
  },
});

const forkCommand = defineCommand({
  meta: {
    name: 'fork',
    description: 'Clone a Run to a new run ID.',
  },
  args: {
    ...commonRunArgs,
    ...featRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Source run ID to fork',
      required: true,
    },
  },
  async run({ args }) {
    const runArgs = args as FeatRunArgs;
    const ctx = await parseFromArtifactOrchestratorCli(runArgs);
    const runStorage = resolveRunStorage(
      readStorageStringFromCli(runArgs),
      ctx.projectDir,
      ctx.config,
    );
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot fork a Run.');
      process.exit(1);
    }
    const sourceRunId = parseRunId(args);

    const sourceArtifact = await runStorage.getRun(sourceRunId);
    if (!sourceArtifact) {
      consola.error(`Run not found: ${sourceRunId}`);
      process.exit(1);
    }

    const nameFromCli = getFeatNameFromArgs(runArgs);
    if (nameFromCli && nameFromCli !== sourceArtifact.config.featureName) {
      consola.error(
        `Source run is for feature "${sourceArtifact.config.featureName}"; omit --name or use -n ${sourceArtifact.config.featureName}.`,
      );
      process.exit(1);
    }

    const { newRunId } = await forkStoredRun({
      ...ctx,
      runId: sourceRunId,
      runStorage,
    });

    consola.log(`\nForked run ${sourceRunId} → ${newRunId}`);
    consola.log(`\nStart the agent with:`);
    consola.log(`  saifctl run start ${newRunId}`);
  },
});

const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Stop a running or paused run (full teardown). Waits up to --timeout for the run to finish shutting down.',
  },
  args: {
    ...commonRunArgs,
    timeout: {
      ...runPauseStopTimeoutArg,
      description: 'Seconds. Max duration to wait for the run to finish stopping. Default: 60.',
    },
    force: {
      type: 'boolean' as const,
      alias: 'f' as const,
      default: false,
      description:
        'Stop without waiting: shut down Docker and remove the saved workspace when possible.',
    },
    runId: {
      type: 'positional' as const,
      description: 'Run ID to stop',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const runStorage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot stop a Run.');
      process.exit(1);
    }
    const runId = parseRunId(args);
    const waitTimeoutMs = parseRunPauseStopTimeoutSec(args) * 1000;
    const force = args.force === true;
    try {
      await runStop({ runId, projectDir, runStorage, waitTimeoutMs, force });
    } catch (err) {
      if (err instanceof RunCannotStopError) {
        consola.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  },
});

const pauseCommand = defineCommand({
  meta: {
    name: 'pause',
    description:
      'Pause a run. Resumable. Stops containers but does not delete them. Waits until paused or --timeout',
  },
  args: {
    ...commonRunArgs,
    timeout: {
      ...runPauseStopTimeoutArg,
      description: 'Seconds. Max duration to wait for the run to finish pausing. Default: 60.',
    },
    runId: {
      type: 'positional' as const,
      description: 'Run ID to pause',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const runStorage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot pause a Run.');
      process.exit(1);
    }
    const runId = parseRunId(args);
    const waitTimeoutMs = parseRunPauseStopTimeoutSec(args) * 1000;
    try {
      await runPause({ runId, runStorage, waitTimeoutMs });
    } catch (err) {
      if (err instanceof RunCannotPauseError) {
        consola.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  },
});

const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description:
      'Resume a paused run: reuse cached state if still present; otherwise continue like run start',
  },
  args: {
    ...commonRunArgs,
    ...featFromArtifactArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to resume',
      required: true,
    },
  },
  async run({ args }) {
    const runArgs = args as FeatRunArgs;
    const ctx = await parseFromArtifactOrchestratorCli(runArgs);
    const runStorage = resolveRunStorage(
      readStorageStringFromCli(runArgs),
      ctx.projectDir,
      ctx.config,
    );
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot resume a Run.');
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
      consola.log(`  saifctl run resume ${result.runId}`);
    }
    if (result.status === 'failed') process.exit(1);
  },
});

const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start again from a Run (failed or interrupted)',
  },
  args: {
    ...commonRunArgs,
    ...featFromArtifactArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to start from',
      required: true,
    },
  },
  async run({ args }) {
    const runArgs = args as FeatRunArgs;
    const ctx = await parseFromArtifactOrchestratorCli(runArgs);
    const runStorage = resolveRunStorage(
      readStorageStringFromCli(runArgs),
      ctx.projectDir,
      ctx.config,
    );
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot start from a Run.');
      process.exit(1);
    }
    const runId = parseRunId(args);

    const result = await fromArtifact({
      ...ctx,
      runId,
      runStorage,
    });

    consola.log(`\n${result.message}`);
    if (result.runId) {
      consola.log(`\nStart again with:`);
      consola.log(`  saifctl run start ${result.runId}`);
    }
    if (result.status !== 'success' && result.status !== 'stopped') process.exit(1);
  },
});

const testCommand = defineCommand({
  meta: {
    name: 'test',
    description: "Re-test a Run's patch (no coding agent). Optionally push/PR on success.",
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
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);

    const runArgs = args as FeatRunArgs;
    setVerboseLogging(runArgs.verbose === true);

    const runStorage = resolveRunStorage(readStorageStringFromCli(runArgs), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot test a Run.');
      process.exit(1);
    }

    const runId = parseRunId(args);
    const cli = await buildOrchestratorCliInputFromFeatArgs(runArgs, {
      projectDir,
      saifctlDir,
      config,
    });
    const cliModelDelta = parseLlmOverridesCliDelta(runArgs);
    const engineCli = readEngineCliFromCli(runArgs);

    consola.log(`\nRe-testing Run: ${runId}`);

    const result = await runTestsFromRun({
      runId,
      runStorage,
      projectDir,
      saifctlDir,
      config,
      cli,
      cliModelDelta,
      engineCli,
    });

    consola.log(`\n${result.message}`);
    if (result.status !== 'success') process.exit(1);
  },
});

const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description: "Create git branch with run's changes and optional push/PR.",
  },
  args: {
    ...commonRunArgs,
    ...runTestArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to apply (from saifctl run ls)',
      required: true,
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);

    const runArgs = args as FeatRunArgs;
    setVerboseLogging(runArgs.verbose === true);

    const runStorage = resolveRunStorage(readStorageStringFromCli(runArgs), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot apply a Run.');
      process.exit(1);
    }

    const runId = parseRunId(args);
    const cli = await buildOrchestratorCliInputFromFeatArgs(runArgs, {
      projectDir,
      saifctlDir,
      config,
    });
    const cliModelDelta = parseLlmOverridesCliDelta(runArgs);
    const engineCli = readEngineCliFromCli(runArgs);

    consola.log(`\nApplying Run to host: ${runId}`);

    const result = await runApply({
      runId,
      runStorage,
      projectDir,
      saifctlDir,
      config,
      cli,
      cliModelDelta,
      engineCli,
    });

    consola.log(`\n${result.message}`);
    if (result.status !== 'success') process.exit(1);
  },
});

const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: "Export run's changes as a single diff.",
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID to export (from saifctl run ls)',
      required: true,
    },
    output: {
      type: 'string' as const,
      alias: 'o' as const,
      description: 'Output path (default: ./saifctl-<feature>-<runId>-<diffHash>.patch)',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);

    const runStorage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
    if (!runStorage) {
      consola.error('Run storage is disabled (--storage none). Cannot export a Run.');
      process.exit(1);
    }

    const runId = parseRunId(args);
    const outputRaw = args.output;
    const output = typeof outputRaw === 'string' && outputRaw.trim() ? outputRaw : undefined;

    consola.log(`\nExport run's changes as a single diff — ${runId}`);

    const result = await runExport({
      runId,
      runStorage,
      projectDir,
      output,
    });

    consola.log(`\n${result.message}`);
    if (result.status !== 'success') process.exit(1);
  },
});

const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Manage Runs and start again from artifacts',
  },
  subCommands: {
    ls: lsCommand,
    list: lsCommand,
    rm: rmCommand,
    remove: rmCommand,
    info: infoCommand,
    get: getCommand,
    clear: clearCommand,
    fork: forkCommand,
    pause: pauseCommand,
    stop: stopCommand,
    resume: resumeCommand,
    start: startCommand,
    inspect: inspectCommand,
    test: testCommand,
    apply: applyCommand,
    export: exportCommand,
    rules: runRulesCommand,
  },
});

export default runCommand;

// Allow running as a script: `tsx src/cli/commands/run.ts`
if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  void runMain(runCommand);
}
