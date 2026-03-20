#!/usr/bin/env tsx
/**
 * Cache CLI — manage factory sandbox entries in /tmp/factory-sandbox/.
 *
 * Usage: pnpm cache <subcommand> [options]
 *   list    List sandbox dirs for this project (--all: all projects)
 *   clear   Remove sandbox entries for this project (--all: everything)
 */

import { readdirSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';

import { defineCommand, runMain } from 'citty';

import { DEFAULT_SANDBOX_BASE_DIR } from '../../orchestrator/sandbox.js';
import { pathExists } from '../../utils/io.js';
import { projectDirArg, sandboxBaseDirArg } from '../args.js';
import { parseProjectDir, parseSandboxBaseDir, resolveProjectName } from '../utils.js';

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List sandbox dirs in the sandbox base dir for this project',
  },
  args: {
    all: { type: 'boolean', description: 'List entries for all projects' },
    project: { type: 'string', alias: 'p', description: 'Project name override' },
    'project-dir': projectDirArg,
    'sandbox-base-dir': sandboxBaseDirArg,
  },
  async run({ args }) {
    const sandboxBase = parseSandboxBaseDir(args);
    const listAll = args.all === true;

    if (!(await pathExists(sandboxBase))) {
      console.log(`${sandboxBase} does not exist — no entries found.`);
      return;
    }

    const entries = readdirSync(sandboxBase);

    if (listAll) {
      if (entries.length === 0) {
        console.log(`No entries found in ${sandboxBase}.`);
        return;
      }
      console.log(`${sandboxBase} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}):`);
      for (const entry of entries) {
        console.log(`${sandboxBase}/${entry}`);
      }
      return;
    }

    const projectDir = parseProjectDir(args);
    const projName = await resolveProjectName(args, projectDir);
    const prefix = `${projName}-`;
    const matching = entries.filter((e) => e.startsWith(prefix));

    if (matching.length === 0) {
      console.log(`No entries matching "${prefix}*" found in ${sandboxBase}.`);
      return;
    }

    console.log(
      `${sandboxBase} — ${matching.length} entr${matching.length === 1 ? 'y' : 'ies'} for project "${projName}":`,
    );
    for (const entry of matching) {
      console.log(`${sandboxBase}/${entry}`);
    }
  },
});

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Remove sandbox entries for this project (--all: everything)',
  },
  args: {
    all: { type: 'boolean', description: 'Remove entries for all projects' },
    project: { type: 'string', alias: 'p', description: 'Project name override' },
    'project-dir': {
      type: 'string',
      description: 'Project directory (default: process.cwd())',
    },
    'sandbox-base-dir': {
      type: 'string',
      description: `Sandbox base directory (default: ${DEFAULT_SANDBOX_BASE_DIR})`,
    },
  },
  async run({ args }) {
    const sandboxBase = parseSandboxBaseDir(args);
    const clearAll = args.all === true;

    if (!(await pathExists(sandboxBase))) {
      console.log(`${sandboxBase} does not exist — nothing to clear.`);
      return;
    }

    const entries = readdirSync(sandboxBase);

    const removeEntries = async (toRemove: string[]) => {
      await Promise.all(
        toRemove.map(async (entry) => {
          // E.g. `/tmp/factory-sandbox/crawlee-one-feat-abc1234`
          await rmAsync(`${sandboxBase}/${entry}`, { recursive: true, force: true });
          console.log(`  removed ${entry}`);
        }),
      );
    };

    if (clearAll) {
      await removeEntries(entries);
      console.log(
        `\nCleared ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${sandboxBase}.`,
      );
      return;
    }

    const projectDir = parseProjectDir(args);
    const projName = await resolveProjectName(args, projectDir);
    const prefix = `${projName}-`;
    const matching = entries.filter((e) => e.startsWith(prefix));

    if (matching.length === 0) {
      console.log(`No entries matching "${prefix}*" found in ${sandboxBase}.`);
      return;
    }

    await removeEntries(matching);
    console.log(
      `\nCleared ${matching.length} entr${matching.length === 1 ? 'y' : 'ies'} for project "${projName}" from ${sandboxBase}.`,
    );
  },
});

const cacheCommand = defineCommand({
  meta: {
    name: 'cache',
    description: 'Manage factory sandbox entries',
  },
  subCommands: {
    list: listCommand,
    clear: clearCommand,
  },
});

export default cacheCommand; // export for validation

// Allow running directly: tsx src/cli/commands/cache.ts
if (process.argv[1]?.endsWith('cache.ts') || process.argv[1]?.endsWith('cache.js')) {
  await runMain(cacheCommand);
}
