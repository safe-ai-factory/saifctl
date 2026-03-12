import * as path from 'node:path';

import { glob } from 'glob';
import Mocha from 'mocha';

/**
 * Test runner entry point used by the VS Code test extension host.
 * VS Code launches an Extension Development Host and invokes this `run()` function
 * to discover and execute the extension's tests.
 */
export function run(): Promise<void> {
  // Configure Mocha
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10000,
  });

  // Root directory for compiled test files (parent of suite/)
  const testsRoot = path.resolve(__dirname, '..');

  // Find all compiled .test.js files and add them to the run
  return glob('**/*.test.js', { cwd: testsRoot }).then((files) => {
    for (const f of files) {
      mocha.addFile(path.resolve(testsRoot, f));
    }

    // Run Mocha and surface pass/fail as a Promise (reject = non-zero exit for CI)
    return new Promise<void>((resolve, reject) => {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed.`));
        } else {
          resolve();
        }
      });
    });
  });
}
