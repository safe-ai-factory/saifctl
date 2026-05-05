/**
 * Build an isolated, throwaway project directory for an integration scenario.
 *
 * Each call creates a fresh `mkdtemp` dir, initialises a git repo there, drops
 * a minimal `package.json`, and copies the requested fixture feature into
 * `<tmp>/saifctl/features/<feature-name>/`. The orchestrator's
 * `applyOrchestratorBaseline` (src/orchestrator/options.ts:296) requires a
 * real git repo + reachable feature dir; these are the minimum guarantees.
 */
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, gitAdd, gitCommit, gitInit } from '../../../../src/utils/git.js';

const HARNESS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');
const FIXTURES_DIR = join(HARNESS_DIR, 'fixtures');

export interface TmpProject {
  projectDir: string;
  saifctlDir: string;
  featureDir: string;
  featureName: string;
}

export interface CreateTmpProjectOpts {
  /**
   * Fixture id; the loader copies `test/integration/harness/fixtures/<id>/`
   * into `<projectDir>/saifctl/features/<featureName>/`. Today only
   * `'dummy-feature'` exists.
   */
  fixture: 'dummy-feature';
  /** Feature name as it appears under `<projectDir>/saifctl/features/`. Defaults to 'dummy'. */
  featureName?: string;
}

export async function createTmpProject(opts: CreateTmpProjectOpts): Promise<TmpProject> {
  const featureName = opts.featureName ?? 'dummy';
  const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-integ-'));

  await writeFile(
    join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'saifctl-integ-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
  );

  // Initial commit so `git diff HEAD` (used by createSandbox to capture host base
  // patch) has a base revision.
  await gitInit({ cwd: projectDir });
  await git({ cwd: projectDir, args: ['config', 'user.email', 'integ@saifctl.test'] });
  await git({ cwd: projectDir, args: ['config', 'user.name', 'saifctl-integ'] });

  const saifctlDir = 'saifctl';
  const featureDir = join(projectDir, saifctlDir, 'features', featureName);
  await mkdir(featureDir, { recursive: true });
  await cp(join(FIXTURES_DIR, opts.fixture), featureDir, { recursive: true });

  await gitAdd({ cwd: projectDir, paths: ['.'], stdio: 'pipe' });
  await gitCommit({ cwd: projectDir, message: 'integ fixture: initial commit', stdio: 'pipe' });
  // Pin the default branch to `main` regardless of the host's `init.defaultBranch`
  // so harness assertions (`commitsAheadOf(main, producedBranch)`) are stable
  // across dev machines and CI runners.
  await git({ cwd: projectDir, args: ['branch', '-M', 'main'] });

  return { projectDir, saifctlDir, featureDir, featureName };
}
