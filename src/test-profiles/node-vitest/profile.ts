import { join } from 'node:path';

import { consola } from '../../logger.js';
import { validateTypescript } from '../../utils/typescript.js';
import type { TestProfile } from '../types.js';

async function vitestValidateFiles(opts: {
  testsDir: string;
  generatedFiles: string[];
  projectDir: string;
  errMessage: string;
}): Promise<void> {
  const { testsDir, generatedFiles, projectDir, errMessage } = opts;
  if (generatedFiles.length === 0) return;
  consola.log(`\nValidating generated spec files...`);
  await validateTypescript({
    files: generatedFiles.map((f) => join(testsDir, f)),
    cwd: projectDir,
    errMessage,
  });
}

/** Test profile for Node.js (TypeScript) using the Vitest test runner. */
export const nodeVitestProfile: TestProfile = {
  id: 'node-vitest',
  language: 'TypeScript',
  framework: 'Vitest',
  specExtension: '.spec.ts',
  fileNamingRule:
    'Files MUST use the ".spec.ts" suffix (e.g. "public/happy-path.spec.ts"). They can live anywhere under tests/.',
  helpersFilename: 'helpers.ts',
  infraFilename: 'infra.spec.ts',
  exampleFilename: 'example.spec.ts',
  importRules:
    'Add `/* eslint-disable */` and `// @ts-nocheck` at the top. Import `{ describe, expect, it }` from "vitest". Import helpers from "../helpers.js".',
  assertionRules:
    'Use `expect(x).toBe(y)`, `expect(x).toContain(y)`, `expect(x).toEqual(y)`. Async tests use `async/await`.',
  validateFiles: vitestValidateFiles,
};
