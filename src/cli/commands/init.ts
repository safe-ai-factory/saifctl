#!/usr/bin/env tsx
/**
 * Init CLI — initialize OpenSpec + codebase indexer for the factory.
 *
 * Usage: saif init [options]
 *   Requires at least one LLM API key.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineCommand, runMain } from 'citty';

import { DEFAULT_INDEXER_PROFILE, resolveIndexerProfile } from '../../indexer-profiles/index.js';
import {
  parseOpenspecDir,
  parseProjectDir,
  requireLlmApiKey,
  resolveProjectName,
} from '../utils.js';

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize OpenSpec + codebase indexer',
  },
  args: {
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Run openspec init even if openspec/ exists',
    },
    project: {
      type: 'string',
      alias: 'p',
      description: 'Project name override (default: package.json "name")',
    },
    'openspec-dir': {
      type: 'string',
      description: 'Path to openspec directory (default: openspec)',
    },
    'project-dir': {
      type: 'string',
      description: 'Project directory (default: process.cwd())',
    },
    indexer: {
      type: 'string',
      description: `Indexer profile to use (default: ${DEFAULT_INDEXER_PROFILE.id})`,
    },
  },
  async run({ args }) {
    requireLlmApiKey();

    const force = args.force === true;
    const openspecDir = parseOpenspecDir(args);
    const projectDir = parseProjectDir(args);
    const indexerProfile = resolveIndexerProfile(args.indexer);
    const projectName = resolveProjectName(args, projectDir);

    const exec = (cmd: string) => execSync(cmd, { stdio: 'inherit', cwd: projectDir });

    // Set up openspec directory
    if (force || !existsSync(resolve(projectDir, openspecDir))) {
      exec('npx openspec init');
    } else {
      console.log(`${openspecDir}/ exists, skipping openspec init (use -f to force)`);
    }

    console.log(
      `\nIndexing codebase with ${indexerProfile.displayName} (project: ${projectName})...`,
    );
    await indexerProfile.init({ projectDir, projectName });

    console.log('\nInit complete.');
  },
});

export default initCommand; // export for validation

// Allow running directly: tsx src/cli/commands/init.ts
if (process.argv[1]?.endsWith('init.ts') || process.argv[1]?.endsWith('init.js')) {
  await runMain(initCommand);
}
