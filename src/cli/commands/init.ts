#!/usr/bin/env tsx
/**
 * Init CLI — initialize OpenSpec + Shotgun for the factory.
 *
 * Usage: saif init [options]
 *   Requires CONTEXT7_API_KEY and at least one LLM API key.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineCommand, runMain } from 'citty';

import { getRepoRoot } from '../../constants.js';
import { requireContext7ApiKey, requireLlmApiKey, resolveProjectName } from '../utils.js';

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize OpenSpec + Shotgun (requires CONTEXT7_API_KEY)',
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
  },
  async run({ args }) {
    requireContext7ApiKey();
    requireLlmApiKey();
    const context7Key = process.env.CONTEXT7_API_KEY!;
    const force = args.force === true;
    const openspecDir =
      typeof args['openspec-dir'] === 'string' && args['openspec-dir'].trim()
        ? args['openspec-dir'].trim()
        : 'openspec';
    const repoRoot = getRepoRoot();

    const exec = (cmd: string) => execSync(cmd, { stdio: 'inherit', cwd: process.cwd() });

    if (force || !existsSync(resolve(repoRoot, openspecDir))) {
      exec('pnpm openspec init');
    } else {
      console.log(`${openspecDir}/ exists, skipping pnpm openspec init (use -f to force)`);
    }
    exec('uv run shotgun-sh config init');
    exec(`uv run shotgun-sh config set-context7 --api-key ${context7Key}`);
    const projName = resolveProjectName(args, repoRoot);
    exec(`uv run shotgun-sh codebase index . --name ${projName}`);
    console.log('\nInit complete.');
  },
});

export default initCommand; // export for validation

// Allow running directly: tsx src/cli/commands/init.ts
if (process.argv[1]?.endsWith('init.ts') || process.argv[1]?.endsWith('init.js')) {
  await runMain(initCommand);
}
