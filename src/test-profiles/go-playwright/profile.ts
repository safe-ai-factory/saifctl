import { join } from 'node:path';

import { consola } from '../../logger.js';
import { spawnWait } from '../../utils/io.js';
import type { TestProfile, ValidateFilesOpts } from '../types.js';

/**
 * Best-effort static analysis for generated Go/Playwright test files using `go vet`.
 * Identical to the go-gotest hook — go vet works on any Go package regardless of
 * whether it imports playwright-go. Skips silently if `go` is not on PATH.
 */
async function goPlaywrightValidateFiles(opts: ValidateFilesOpts): Promise<void> {
  const { testsDir, generatedFiles } = opts;
  if (generatedFiles.length === 0) return;
  if (!generatedFiles.some((f) => f.endsWith('_test.go'))) return;

  consola.log(`\nValidating generated spec files (go vet)...`);

  const subdirs = [
    ...new Set(
      generatedFiles
        .filter((f) => f.endsWith('_test.go'))
        .map((f) => join(testsDir, f.split('/')[0] ?? '.')),
    ),
  ];

  try {
    for (const dir of subdirs) {
      const result = await spawnWait({
        command: 'go',
        args: ['vet', './...'],
        cwd: dir,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) {
        const output = result.stdout + result.stderr;
        consola.error(`  ${opts.errMessage}`);
        for (const line of output.split('\n').filter(Boolean).slice(0, 20)) {
          consola.error(`    ${line}`);
        }
        process.exit(1);
      }
    }
    consola.log(`  Go validation passed.`);
  } catch {
    consola.warn(`  Go validation skipped (go not available).`);
  }
}

export const goPlaywrightProfile: TestProfile = {
  id: 'go-playwright',
  language: 'Go',
  framework: 'playwright-go',
  specExtension: '_test.go',
  fileNamingRule:
    'Files MUST use the "_test.go" suffix (e.g. "public/happy_path_test.go"). Every file MUST declare `package public_test` (for public/) or `package hidden_test` (for hidden/).',
  helpersFilename: 'helpers.go',
  infraFilename: 'infra_test.go',
  exampleFilename: 'example_test.go',
  importRules:
    'Include `package public_test` (or `hidden_test`) at the top. Import `"testing"` and `github.com/playwright-community/playwright-go`.',
  assertionRules:
    'Use `t.Fatalf`, `t.Errorf`, or a helper like `github.com/stretchr/testify/assert`. Test function names MUST start with `Test`.',
  validateFiles: goPlaywrightValidateFiles,
};
