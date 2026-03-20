#!/usr/bin/env tsx
/**
 * Init CLI — initialize Saifac config, saifac directory, and codebase indexer.
 *
 * Usage: saifac init [options]
 *   Creates saifac/ and scaffolds saifac/config.ts when no config exists.
 *   Requires at least one LLM API key for indexer operations.
 */

import { defineCommand, runMain } from 'citty';

import { scaffoldSaifConfig } from '../../config/scaffold.js';
import { resolveIndexerProfile } from '../../indexer-profiles/index.js';
import { indexerArg, projectDirArg, saifDirArg } from '../args.js';
import { parseProjectDir, parseSaifDir, resolveProjectName } from '../utils.js';

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize Saifac config + codebase indexer',
  },
  args: {
    project: {
      type: 'string',
      alias: 'p',
      description: 'Project name override (default: package.json "name")',
    },
    'project-dir': projectDirArg,
    'saifac-dir': saifDirArg,
    indexer: indexerArg,
  },
  async run({ args }) {
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const indexerProfile = resolveIndexerProfile(args.indexer);
    const projectName = await resolveProjectName(args, projectDir);

    const scaffolded = await scaffoldSaifConfig(saifDir, projectDir);
    if (scaffolded) {
      console.log(`\nCreated ${saifDir}/config.ts (no config found).`);
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
