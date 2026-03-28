import { join } from 'node:path';

import { consola } from '../../logger.js';
import { writeUtf8 } from '../../utils/io.js';
import { validateTypescript } from '../../utils/typescript.js';
import type { OnDoneOpts, TestProfile, ValidateFilesOpts } from '../types.js';

async function tsPlaywrightValidateFiles(opts: ValidateFilesOpts): Promise<void> {
  const { testsDir, generatedFiles, projectDir, errMessage } = opts;
  if (generatedFiles.length === 0) return;
  consola.log(`\nValidating generated spec files...`);
  await validateTypescript({
    files: generatedFiles.map((f) => join(testsDir, f)),
    cwd: projectDir,
    errMessage,
  });
}

async function tsPlaywrightOnDone(opts: OnDoneOpts): Promise<void> {
  const configPath = join(opts.testsDir, 'playwright.config.ts');
  const configContent = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  reporter: [['junit', { outputFile: process.env.SAIFCTL_OUTPUT_FILE || 'results.xml' }]],
  use: {
    baseURL: process.env.SAIFCTL_TARGET_URL || 'http://staging:3000',
  },
});
`;
  await writeUtf8(configPath, configContent);
  consola.log(`[design-tests:node-playwright] Written ${configPath}`);
}

export const nodePlaywrightProfile: TestProfile = {
  id: 'node-playwright',
  language: 'TypeScript',
  framework: 'Playwright',
  specExtension: '.spec.ts',
  fileNamingRule:
    'Files MUST use the ".spec.ts" suffix (e.g. "public/happy-path.spec.ts"). They can live anywhere under tests/.',
  helpersFilename: 'helpers.ts',
  infraFilename: 'infra.spec.ts',
  importRules:
    'Import { test, expect } from "@playwright/test". Import helpers from "../helpers.js".',
  assertionRules:
    'Use Playwright assertions like expect(page).toHaveURL(), expect(response.ok()).toBeTruthy(). Async tests use async/await.',
  validateFiles: tsPlaywrightValidateFiles,
  onDone: tsPlaywrightOnDone,
};
