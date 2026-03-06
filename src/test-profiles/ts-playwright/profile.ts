import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateTypescript } from '../../utils/typescript.js';
import type { OnDoneOpts, TestProfile, ValidateFilesOpts } from '../types.js';

async function tsPlaywrightValidateFiles(opts: ValidateFilesOpts): Promise<void> {
  const { testsDir, generatedFiles, projectDir, errMessage } = opts;
  if (generatedFiles.length === 0) return;
  console.log(`\nValidating generated spec files...`);
  await validateTypescript({
    files: generatedFiles.map((f) => join(testsDir, f)),
    cwd: projectDir,
    errMessage,
  });
}

function tsPlaywrightOnDone(opts: OnDoneOpts): void {
  const configPath = join(opts.testsDir, 'playwright.config.ts');
  const configContent = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  reporter: [['junit', { outputFile: process.env.FACTORY_OUTPUT_FILE || 'results.xml' }]],
  use: {
    baseURL: process.env.FACTORY_TARGET_URL || 'http://staging:3000',
  },
});
`;
  writeFileSync(configPath, configContent, 'utf8');
  console.log(`[blackbox:scaffold] Written \${configPath}`);
}

export const tsPlaywrightProfile: TestProfile = {
  id: 'ts-playwright',
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
