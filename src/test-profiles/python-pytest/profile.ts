import { spawnSync } from 'node:child_process';

import type { TestProfile, ValidateFilesOpts } from '../types.js';

/**
 * Best-effort syntax check for generated pytest files using ruff.
 * Skips silently if ruff is not on PATH.
 */
function pytestValidateFiles(opts: ValidateFilesOpts): void {
  const { testsDir, generatedFiles } = opts;
  if (generatedFiles.length === 0) return;
  const pyFiles = generatedFiles.filter((f) => f.endsWith('.py'));
  if (pyFiles.length === 0) return;

  console.log(`\nValidating generated spec files (ruff)...`);
  try {
    const result = spawnSync('ruff', ['check', '--select', 'E,F', ...pyFiles], {
      cwd: testsDir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) throw result.error; // binary not found → ENOENT
    if (result.status === 0) {
      console.log(`  Python validation passed.`);
    } else {
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      console.error(`  ${opts.errMessage}`);
      for (const line of output.split('\n').filter(Boolean).slice(0, 20)) {
        console.error(`    ${line}`);
      }
      process.exit(1);
    }
  } catch {
    console.warn(`  Python validation skipped (ruff not available).`);
  }
}

export const pytestProfile: TestProfile = {
  id: 'python-pytest',
  language: 'Python',
  framework: 'pytest',
  specExtension: '.py',
  fileNamingRule:
    'Files MUST be prefixed with "test_" (e.g. "public/test_happy_path.py"). pytest discovers any file matching test_*.py recursively.',
  helpersFilename: 'helpers.py',
  infraFilename: 'test_infra.py',
  importRules:
    'Import `pytest` and `requests` at the top of every spec file. Import helpers with `from ..helpers import exec_sidecar, base_url, http_request` (or use a relative import appropriate to the package structure).',
  assertionRules:
    'Use plain `assert` statements (e.g. `assert result["exitCode"] == 0`). Use `pytest.raises` for expected exceptions.',
  validateFiles: pytestValidateFiles,
};
