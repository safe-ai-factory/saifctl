#!/usr/bin/env tsx
/**
 * Sandbox CLI — run an agent in isolation without gate, reviewer, or staging tests.
 *
 * Usage: saifctl sandbox [options]
 */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { defineCommand, runMain } from 'citty';

import { loadSaifctlConfig } from '../../config/load.js';
import { getSaifctlRoot } from '../../constants.js';
import { consola, setVerboseLogging } from '../../logger.js';
import {
  type OrchestratorCliInput,
  parseLlmOverridesCliDelta,
} from '../../orchestrator/options.js';
import type { SandboxExtractMode } from '../../orchestrator/phases/sandbox-extract.js';
import { runSandbox, runSandboxInteractive } from '../../orchestrator/sandbox-run.js';
import type { Feature } from '../../specs/discover.js';
import { readUtf8 } from '../../utils/io.js';
import { featFromArtifactArgs, nameArg } from '../args.js';
import {
  buildOrchestratorCliInputFromFeatArgs,
  type FeatRunArgs,
  readEngineCliFromCli,
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  readStorageStringFromCli,
  resolveCliProjectDir,
  resolveRunStorage,
  resolveSaifctlDirRelative,
} from '../utils.js';

const sandboxArgs = {
  ...featFromArtifactArgs,
  name: {
    ...nameArg,
    description: 'Sandbox label (kebab-case). Default: random id.',
  },
  interactive: {
    type: 'boolean' as const,
    alias: 'i' as const,
    description: 'Start an interactive sandbox: run startup + agent-install scripts, then idle. ',
  },
  task: {
    type: 'string' as const,
    alias: 't' as const,
    description:
      'Task prompt for the agent. Required unless --task-file, --subtasks, or --interactive is set.',
  },
  'task-file': {
    type: 'string' as const,
    description: 'Path to a file whose contents become the task prompt.',
  },
  subtasks: {
    type: 'string' as const,
    description:
      'Path to subtasks JSON manifest (same as feat run --subtasks). Cannot be combined with --task/--task-file.',
  },
  extract: {
    type: 'boolean' as const,
    description:
      'After the run, apply the agent’s git changes to the host working tree (git apply).',
  },
  'extract-include': {
    type: 'string' as const,
    description:
      'Repo-relative path prefix: only apply hunks under this path (requires --extract).',
  },
  'extract-exclude': {
    type: 'string' as const,
    description:
      'Repo-relative path prefix: exclude from the extracted patch (requires --extract-include).',
  },
};

const sandboxCommand = defineCommand({
  meta: {
    name: 'sandbox',
    description:
      'Run an agent in a sandbox — no features, tests, or staging; optionally extract to working tree',
  },
  args: sandboxArgs,
  async run({ args }) {
    const interactive = args.interactive === true;
    const taskInline = typeof args.task === 'string' ? args.task.trim() : '';
    const taskFile = typeof args['task-file'] === 'string' ? args['task-file'].trim() : '';
    const subtasksArg = typeof args.subtasks === 'string' ? args.subtasks.trim() : '';

    const hasTask = Boolean(taskInline || taskFile);

    // --interactive is mutually exclusive with task/subtask flags.
    if (interactive && (hasTask || subtasksArg)) {
      consola.error(
        'Error: --interactive cannot be combined with --task, --task-file, or --subtasks',
      );
      process.exit(1);
    }

    if (!interactive) {
      if (!hasTask && !subtasksArg) {
        consola.error('Error: provide --task/-t, --task-file, --subtasks, or --interactive');
        process.exit(1);
      }
      if (subtasksArg && hasTask) {
        consola.error('Error: do not combine --subtasks with --task or --task-file');
        process.exit(1);
      }
      if (taskInline && taskFile) {
        consola.error('Error: use either --task or --task-file, not both');
        process.exit(1);
      }
    }

    const extract = args.extract === true;
    const extractInclude =
      typeof args['extract-include'] === 'string' ? args['extract-include'].trim() : '';
    const extractExclude =
      typeof args['extract-exclude'] === 'string' ? args['extract-exclude'].trim() : '';

    if (extractExclude && !extractInclude) {
      consola.error('Error: --extract-exclude requires --extract-include');
      process.exit(1);
    }
    if (extractInclude && !extract) {
      consola.error('Error: --extract-include requires --extract');
      process.exit(1);
    }

    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));

    let taskText: string | undefined;
    if (taskFile) {
      const taskPath = isAbsolute(taskFile) ? taskFile : resolve(projectDir, taskFile);
      taskText = await readUtf8(taskPath);
    } else if (taskInline) {
      taskText = taskInline;
    }

    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    setVerboseLogging(args.verbose === true);

    const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
    const baseName = nameRaw || `scratch-${randomBytes(4).toString('hex')}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(baseName)) {
      consola.error(
        'Error: --name must be kebab-case (lowercase letters, digits, single hyphens between segments).',
      );
      process.exit(1);
    }

    const sandboxTmpDir = join(tmpdir(), `saifctl-sandbox-${baseName}`);
    await mkdir(sandboxTmpDir, { recursive: true });

    const feature: Feature = {
      name: baseName,
      absolutePath: sandboxTmpDir,
      relativePath: `(sandbox)/${baseName}`,
    };

    const saifctlRoot = getSaifctlRoot();
    const sandboxCedarPath = join(saifctlRoot, 'src', 'orchestrator', 'policies', 'sandbox.cedar');
    const sandboxGatePath = join(saifctlRoot, 'src', 'orchestrator', 'scripts', 'sandbox-gate.sh');

    const cedarCli =
      typeof args.cedar === 'string' && args.cedar.trim() ? args.cedar.trim() : undefined;

    const featArgs = { ...args, name: baseName, subtasks: subtasksArg || undefined } as FeatRunArgs;
    const cliBase = await buildOrchestratorCliInputFromFeatArgs(featArgs, {
      projectDir,
      saifctlDir,
      config,
    });

    const storageRaw = readStorageStringFromCli(args);
    const runStorageOverride =
      storageRaw !== undefined ? resolveRunStorage(storageRaw, projectDir, config) : undefined;

    // User may still use custom gate script via --gate-script, but default to noop.
    const defaultSandboxGateScript = await readUtf8(sandboxGatePath);
    const gateScript = cliBase.gateScript ?? defaultSandboxGateScript;
    const gateScriptFile = cliBase.gateScriptFile ?? sandboxGatePath;

    const cli: OrchestratorCliInput = {
      ...cliBase,
      gateScript,
      gateScriptFile,
      cedarPolicyPath: cedarCli ?? sandboxCedarPath,
      reviewerEnabled: false,
      maxRuns: 1,
      allowSaifctlInPatch: true,
      ...(runStorageOverride !== undefined ? { runStorage: runStorageOverride } : {}),
    };

    const cliModelDelta = parseLlmOverridesCliDelta(args);
    const engineCli = readEngineCliFromCli(args);

    consola.log(`\n[sandbox] Run label: ${baseName}`);

    // --interactive: startup + agent-install, then idle until Ctrl+C.
    if (interactive) {
      const sandboxExtract: SandboxExtractMode = extract
        ? extractInclude
          ? 'host-apply-filtered'
          : 'host-apply'
        : 'none';
      const result = await runSandboxInteractive({
        projectDir,
        saifctlDir,
        config,
        feature,
        cli,
        cliModelDelta,
        engineCli,
        extract: sandboxExtract,
        extractInclude: extractInclude || undefined,
        extractExclude: extractExclude || undefined,
      });
      consola.log(`\n${result.message}`);
      if (result.status === 'failed') process.exit(1);
      return;
    }

    let sandboxExtract: SandboxExtractMode = 'none';
    if (extract) {
      sandboxExtract = extractInclude ? 'host-apply-filtered' : 'host-apply';
    }

    const result = await runSandbox({
      projectDir,
      saifctlDir,
      config,
      feature,
      cli,
      cliModelDelta,
      engineCli,
      task: taskText ?? undefined,
      extract: sandboxExtract,
      extractInclude: extractInclude || undefined,
      extractExclude: extractExclude || undefined,
    });

    consola.log(`\n${result.message}`);
    if (result.runId && result.status !== 'success') {
      consola.log(`\nInspect with: saifctl run info ${result.runId}`);
    }
    if (result.status === 'failed') process.exit(1);
  },
});

export default sandboxCommand;

if (process.argv[1]?.endsWith('sandbox.ts') || process.argv[1]?.endsWith('sandbox.js')) {
  await runMain(sandboxCommand);
}
