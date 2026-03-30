#!/usr/bin/env tsx
import { defineCommand, runMain } from 'citty';

import { getSaifctlPackageVersion } from '../../constants.js';

const versionCommand = defineCommand({
  meta: {
    name: 'version',
    description: 'Print the saifctl package version',
  },
  run() {
    console.log(getSaifctlPackageVersion());
  },
});

export default versionCommand;

if (process.argv[1]?.endsWith('version.ts') || process.argv[1]?.endsWith('version.js')) {
  await runMain(versionCommand);
}
