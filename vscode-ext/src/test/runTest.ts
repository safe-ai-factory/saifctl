import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

import { logger } from '../logger.js';

/**
 * Entry point for VS Code extension tests. Runs outside VS Code in Node.
 * Uses @vscode/test-electron to launch a test instance of VS Code, load this extension,
 * and then run the Mocha suite (suite/index.js) inside that instance.
 */
async function main(): Promise<void> {
  try {
    // Path to the extension root (so VS Code loads our extension)
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    // Path to the compiled test runner that runs inside the Extension Development Host
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js');

    // Open a specific workspace when the test window launches (for deterministic tests)
    const launchArgs = [path.resolve(extensionDevelopmentPath, 'saifctl-test-workspace')];

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
  } catch {
    logger.error('Failed to run tests');
    process.exit(1);
  }
}

void main();
