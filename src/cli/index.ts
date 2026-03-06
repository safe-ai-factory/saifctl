#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';

import agentsCommand from './commands/agents.js';
import cacheCommand from './commands/cache.js';
import initCommand from './commands/init.js';

const main = defineCommand({
  meta: {
    name: 'saif',
    description:
      'safe-ai-factory: Spec-driven AI factory. Use with any agentic CLI. Language-agnostic. Safe by design.',
  },
  subCommands: {
    agents: agentsCommand,
    cache: cacheCommand,
    init: initCommand,
  },
});

export const cli = () => {
  void runMain(main);
};
