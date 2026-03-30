#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';

import { getSaifctlPackageVersion } from '../constants.js';
import cacheCommand from './commands/cache.js';
import doctorCommand from './commands/doctor.js';
import { default as featCommand, featureCommand } from './commands/feat.js';
import initCommand from './commands/init.js';
import runCommand from './commands/run.js';
import versionCommand from './commands/version.js';

const main = defineCommand({
  meta: {
    name: 'saifctl',
    version: getSaifctlPackageVersion(),
    description:
      'SaifCTL: spec-driven AI factory. Use with any agentic CLI. Language-agnostic. Safe by design.',
  },
  subCommands: {
    cache: cacheCommand,
    doctor: doctorCommand,
    feat: featCommand,
    feature: featureCommand,
    init: initCommand,
    run: runCommand,
    version: versionCommand,
  },
});

const cli = () => {
  void runMain(main);
};

cli();
