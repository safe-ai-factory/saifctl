import { consola } from '../../logger.js';
import { spawnWait } from '../../utils/io.js';
import type { TestProfile, ValidateFilesOpts } from '../types.js';

/**
 * Best-effort syntax check for generated pytest-playwright files using ruff.
 * Identical to the python-pytest hook — ruff works on any Python file regardless
 * of whether it imports playwright. Skips silently if ruff is not on PATH.
 */
async function pythonPlaywrightValidateFiles(opts: ValidateFilesOpts): Promise<void> {
  const { testsDir, generatedFiles } = opts;
  if (generatedFiles.length === 0) return;
  const pyFiles = generatedFiles.filter((f) => f.endsWith('.py'));
  if (pyFiles.length === 0) return;

  consola.log(`\nValidating generated spec files (ruff)...`);
  try {
    const result = await spawnWait({
      command: 'ruff',
      args: ['check', '--select', 'E,F', ...pyFiles],
      cwd: testsDir,
      timeoutMs: 30_000,
    });
    if (result.code === 0) {
      consola.log(`  Python validation passed.`);
    } else {
      const output = result.stdout + result.stderr;
      consola.error(`  ${opts.errMessage}`);
      for (const line of output.split('\n').filter(Boolean).slice(0, 20)) {
        consola.error(`    ${line}`);
      }
      process.exit(1);
    }
  } catch {
    consola.warn(`  Python validation skipped (ruff not available).`);
  }
}

export const pythonPlaywrightProfile: TestProfile = {
  id: 'python-playwright',
  language: 'Python',
  framework: 'pytest-playwright',
  specExtension: '.py',
  fileNamingRule:
    'Files MUST be prefixed with "test_" (e.g. "public/test_happy_path.py"). pytest discovers any file matching test_*.py recursively.',
  helpersFilename: 'helpers.py',
  infraFilename: 'test_infra.py',
  exampleFilename: 'test_example.py',
  importRules:
    'Import `pytest` and `expect` from `playwright.sync_api` at the top of every spec file. Import helpers with `from ..helpers import exec_sidecar, base_url, http_request`.',
  assertionRules:
    'Use `expect(page).to_have_url(...)` or plain `assert` statements. Use `pytest.raises` for expected exceptions.',
  validateFiles: pythonPlaywrightValidateFiles,
};
