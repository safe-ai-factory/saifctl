#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { defineCommand, runMain } from 'citty';

import cacheCommand from './commands/cache.js';
import featCommand from './commands/feat.js';
import initCommand from './commands/init.js';
import runCommand from './commands/run.js';

const main = defineCommand({
  meta: {
    name: 'saif',
    description:
      'safe-ai-factory: Spec-driven AI factory. Use with any agentic CLI. Language-agnostic. Safe by design.',
  },
  subCommands: {
    cache: cacheCommand,
    feat: featCommand,
    feature: featCommand,
    init: initCommand,
    run: runCommand,
  },
});

export const cli = () => {
  void runMain(main);
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  cli();
}
