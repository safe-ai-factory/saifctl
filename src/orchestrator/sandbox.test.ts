/**
 * Unit tests for sandbox utilities.
 *
 * Focuses on the pure, side-effect-free helpers that can run without Docker
 * or the filesystem. Also includes filesystem-based tests for removeAllHiddenDirs.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveFeature } from '../specs/discover.js';
import { git, gitAdd, gitCommit, gitInit } from '../utils/git.js';
import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { createSandbox, destroySandbox, filterPatchHunks, removeAllHiddenDirs } from './sandbox.js';

const PATCH_TWO_FILES = `\
diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export const greet = () => 'hello';
+export const farewell = () => 'bye';
diff --git a/saifac/features/foo/tests/tests.json b/saifac/features/foo/tests/tests.json
index 111aaaa..222bbbb 100644
--- a/saifac/features/foo/tests/tests.json
+++ b/saifac/features/foo/tests/tests.json
@@ -1 +1 @@
-{}
+{"testCases":[]}
`;

describe('filterPatchHunks', () => {
  it('returns the full patch when no exclude rules are given', () => {
    expect(filterPatchHunks(PATCH_TWO_FILES, [])).toBe(PATCH_TWO_FILES);
  });

  it('strips sections matching a glob exclude rule', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'glob', pattern: 'saifac/**' }]);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('saifac/features/foo/tests/tests.json');
  });

  it('strips sections matching a regex exclude rule', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'regex', pattern: /tests\.json$/ }]);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('tests.json');
  });

  it('keeps all sections when no rules match', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'glob', pattern: 'unrelated/**' }]);
    expect(result).toBe(PATCH_TWO_FILES);
  });

  it('returns an empty string unchanged', () => {
    expect(filterPatchHunks('', [{ type: 'glob', pattern: '**' }])).toBe('');
  });
});

describe('removeAllHiddenDirs', () => {
  it('removes all hidden/ dirs recursively under baseDir', async () => {
    const tmp = await mkdtemp(join(process.cwd(), 'sandbox-test-'));
    try {
      // feat-a/tests/public, feat-a/tests/hidden
      await mkdir(join(tmp, 'feat-a', 'tests', 'public'), { recursive: true });
      await mkdir(join(tmp, 'feat-a', 'tests', 'hidden'), { recursive: true });
      await writeUtf8(join(tmp, 'feat-a', 'tests', 'hidden', 'bar.spec.ts'), '');
      // feat-b/tests/hidden
      await mkdir(join(tmp, 'feat-b', 'tests', 'hidden'), { recursive: true });
      await writeUtf8(join(tmp, 'feat-b', 'tests', 'hidden', 'edge.spec.ts'), '');
      // feat-c/nested/hidden (deep nesting)
      await mkdir(join(tmp, 'feat-c', 'nested', 'hidden'), { recursive: true });
      await writeUtf8(join(tmp, 'feat-c', 'nested', 'hidden', 'deep.ts'), '');

      const removed = await removeAllHiddenDirs(tmp);

      expect(removed).toBe(3);
      expect(await pathExists(join(tmp, 'feat-a', 'tests', 'hidden'))).toBe(false);
      expect(await pathExists(join(tmp, 'feat-b', 'tests', 'hidden'))).toBe(false);
      expect(await pathExists(join(tmp, 'feat-c', 'nested', 'hidden'))).toBe(false);
      expect(await pathExists(join(tmp, 'feat-a', 'tests', 'public'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns 0 when baseDir does not exist', async () => {
    const removed = await removeAllHiddenDirs('/nonexistent/path/xyz');
    expect(removed).toBe(0);
  });

  it('returns 0 when no hidden dirs are present', async () => {
    const tmp = await mkdtemp(join(process.cwd(), 'sandbox-test-'));
    try {
      await mkdir(join(tmp, 'feat', 'tests', 'public'), { recursive: true });
      await writeUtf8(join(tmp, 'feat', 'tests', 'public', 'foo.spec.ts'), '');

      const removed = await removeAllHiddenDirs(tmp);

      expect(removed).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('createSandbox + destroySandbox (integration)', () => {
  const TEST_CATALOG = {
    version: '1.0',
    featureName: 'my-feature',
    featureDir: 'saifac/features/my-feature',
    containers: {
      staging: { sidecarPort: 8080, sidecarPath: '/exec' },
      additional: [],
    },
    testCases: [
      {
        id: 'tc-public-001',
        title: 'Public test',
        description: 'Happy path',
        tracesTo: [],
        category: 'happy_path',
        visibility: 'public',
        entrypoint: 'public/foo.spec.ts',
      },
      {
        id: 'tc-hidden-001',
        title: 'Hidden test',
        description: 'Holdout',
        tracesTo: [],
        category: 'boundary',
        visibility: 'hidden',
        entrypoint: 'hidden/bar.spec.ts',
      },
    ],
  };

  const GATE_SCRIPT = '#!/bin/sh\necho "gate"';
  const STARTUP_SCRIPT = '#!/bin/sh\necho "startup"';
  const AGENT_START_SCRIPT = '#!/bin/sh\necho "agent-start"';
  const AGENT_SCRIPT = '#!/bin/sh\necho "agent"';
  const STAGE_SCRIPT = '#!/bin/sh\necho "stage"';

  it('creates sandbox with hidden dirs removed, clean git, and mounted scripts; destroySandbox cleans up', async () => {
    const projectDir = await mkdtemp(join(process.cwd(), 'createSandbox-project-'));
    const sandboxBaseDir = await mkdtemp(join(process.cwd(), 'createSandbox-sandbox-'));
    try {
      // 1. Build dummy codebase: .git, .gitignore, saifac/features with public + hidden tests
      await writeUtf8(join(projectDir, '.gitignore'), 'node_modules\n');
      await gitInit({ cwd: projectDir });
      await writeUtf8(join(projectDir, 'README.md'), 'dummy');
      await gitAdd({ cwd: projectDir, paths: ['README.md'] });
      await gitCommit({
        cwd: projectDir,
        message: 'Initial',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test',
        },
      });

      const saifDir = 'saifac';
      const featureTests = join(projectDir, saifDir, 'features', 'my-feature', 'tests');
      await mkdir(join(featureTests, 'public'), { recursive: true });
      await mkdir(join(featureTests, 'hidden'), { recursive: true });
      await writeUtf8(join(featureTests, 'tests.json'), JSON.stringify(TEST_CATALOG, null, 2));
      await writeUtf8(
        join(featureTests, 'public', 'foo.spec.ts'),
        "import { expect } from 'vitest';\n",
      );
      await writeUtf8(
        join(featureTests, 'hidden', 'bar.spec.ts'),
        "import { expect } from 'vitest';\n",
      );

      const otherFeatureHidden = join(
        projectDir,
        saifDir,
        'features',
        'other-feature',
        'tests',
        'hidden',
      );
      await mkdir(otherFeatureHidden, { recursive: true });
      await writeUtf8(
        join(otherFeatureHidden, 'edge.spec.ts'),
        "import { expect } from 'vitest';\n",
      );

      const feature = await resolveFeature({
        input: 'my-feature',
        projectDir,
        saifDir: 'saifac',
      });
      const paths = await createSandbox({
        feature,
        projectDir,
        saifDir,
        projectName: 'test-proj',
        sandboxBaseDir,
        runId: 'abc123',
        gateScript: GATE_SCRIPT,
        startupScript: STARTUP_SCRIPT,
        agentStartScript: AGENT_START_SCRIPT,
        agentScript: AGENT_SCRIPT,
        stageScript: STAGE_SCRIPT,
      });

      const codePath = paths.codePath;
      const sandboxBasePath = paths.sandboxBasePath;

      // 3. Assert hidden dirs are removed
      expect(
        await pathExists(join(codePath, saifDir, 'features', 'my-feature', 'tests', 'hidden')),
      ).toBe(false);
      expect(
        await pathExists(join(codePath, saifDir, 'features', 'other-feature', 'tests', 'hidden')),
      ).toBe(false);
      expect(
        await pathExists(join(codePath, saifDir, 'features', 'my-feature', 'tests', 'public')),
      ).toBe(true);

      // 4. Assert tests.json contains only public test cases
      const copiedCatalog = JSON.parse(
        await readUtf8(join(codePath, saifDir, 'features', 'my-feature', 'tests', 'tests.json')),
      );
      expect(copiedCatalog.testCases).toHaveLength(1);
      expect(copiedCatalog.testCases[0].visibility).toBe('public');
      expect(copiedCatalog.testCases[0].id).toBe('tc-public-001');

      // 5. Assert clean git (one commit "Base state")
      const commitCount = (
        await git({ cwd: codePath, args: ['rev-list', '--count', 'HEAD'] })
      ).trim();
      expect(commitCount).toBe('1');
      const lastMsg = (await git({ cwd: codePath, args: ['log', '-1', '--format=%s'] })).trim();
      expect(lastMsg).toBe('Base state');

      // 6. Assert .git from source was NOT copied (fresh init), and code has .git
      expect(await pathExists(join(codePath, '.git'))).toBe(true);

      // 7. Assert mounted scripts exist with correct content and are executable
      const scripts: [string, string][] = [
        [paths.gatePath, GATE_SCRIPT],
        [paths.startupPath, STARTUP_SCRIPT],
        [paths.agentStartPath, AGENT_START_SCRIPT],
        [paths.agentPath, AGENT_SCRIPT],
        [paths.stagePath, STAGE_SCRIPT],
      ];
      for (const [p, content] of scripts) {
        expect(await readUtf8(p)).toBe(content);
        expect(((await stat(p)).mode & 0o111) !== 0).toBe(true);
      }

      // 8. Destroy sandbox
      await destroySandbox(sandboxBasePath);

      // 9. Assert sandbox dir is gone
      expect(await pathExists(sandboxBasePath)).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      if (await pathExists(sandboxBaseDir)) {
        await rm(sandboxBaseDir, { recursive: true, force: true });
      }
    }
  });

  it('works with nested features (auth)/login', async () => {
    const projectDir = await mkdtemp(join(process.cwd(), 'createSandbox-project-'));
    const sandboxBaseDir = await mkdtemp(join(process.cwd(), 'createSandbox-sandbox-'));
    try {
      // 1. Build dummy codebase with nested feature saifac/features/(auth)/login
      await writeUtf8(join(projectDir, '.gitignore'), 'node_modules\n');
      await gitInit({ cwd: projectDir });
      await writeUtf8(join(projectDir, 'README.md'), 'dummy');
      await gitAdd({ cwd: projectDir, paths: ['README.md'] });
      await gitCommit({
        cwd: projectDir,
        message: 'Initial',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test',
        },
      });

      const saifDir = 'saifac';
      const NESTED_CATALOG = {
        ...TEST_CATALOG,
        featureName: '(auth)/login',
        featureDir: 'saifac/features/(auth)/login',
        testCases: [
          {
            id: 'tc-public-001',
            title: 'Public test',
            description: 'Happy path',
            tracesTo: [],
            category: 'happy_path',
            visibility: 'public',
            entrypoint: 'public/login.spec.ts',
          },
          {
            id: 'tc-hidden-001',
            title: 'Hidden test',
            description: 'Holdout',
            tracesTo: [],
            category: 'boundary',
            visibility: 'hidden',
            entrypoint: 'hidden/holdout.spec.ts',
          },
        ],
      };

      const loginTests = join(projectDir, saifDir, 'features', '(auth)', 'login', 'tests');
      await mkdir(join(loginTests, 'public'), { recursive: true });
      await mkdir(join(loginTests, 'hidden'), { recursive: true });
      await writeUtf8(join(loginTests, 'tests.json'), JSON.stringify(NESTED_CATALOG, null, 2));
      await writeUtf8(
        join(loginTests, 'public', 'login.spec.ts'),
        "import { expect } from 'vitest';\n",
      );
      await writeUtf8(
        join(loginTests, 'hidden', 'holdout.spec.ts'),
        "import { expect } from 'vitest';\n",
      );

      // Another nested feature with hidden dir to verify removeAllHiddenDirs cleans all
      const profileHidden = join(
        projectDir,
        saifDir,
        'features',
        '(core)',
        'profile',
        'tests',
        'hidden',
      );
      await mkdir(profileHidden, { recursive: true });
      await writeUtf8(join(profileHidden, 'edge.spec.ts'), "import { expect } from 'vitest';\n");

      const feature = await resolveFeature({
        input: '(auth)/login',
        projectDir,
        saifDir,
      });
      const paths = await createSandbox({
        feature,
        projectDir,
        saifDir,
        projectName: 'test-proj',
        sandboxBaseDir,
        runId: 'def456',
        gateScript: GATE_SCRIPT,
        startupScript: STARTUP_SCRIPT,
        agentStartScript: AGENT_START_SCRIPT,
        agentScript: AGENT_SCRIPT,
        stageScript: STAGE_SCRIPT,
      });

      const codePath = paths.codePath;
      const sandboxBasePath = paths.sandboxBasePath;

      // 2. Assert nested feature path resolved (slug used in dir name)
      expect(feature.name).toBe('auth-login');
      expect(paths.sandboxBasePath).toContain('test-proj-auth-login-def456');

      // 3. Assert hidden dirs removed for nested features
      expect(
        await pathExists(join(codePath, saifDir, 'features', '(auth)', 'login', 'tests', 'hidden')),
      ).toBe(false);
      expect(
        await pathExists(
          join(codePath, saifDir, 'features', '(core)', 'profile', 'tests', 'hidden'),
        ),
      ).toBe(false);
      expect(
        await pathExists(join(codePath, saifDir, 'features', '(auth)', 'login', 'tests', 'public')),
      ).toBe(true);

      // 4. Assert tests.json contains only public test cases
      const copiedCatalog = JSON.parse(
        await readUtf8(
          join(codePath, saifDir, 'features', '(auth)', 'login', 'tests', 'tests.json'),
        ),
      );
      expect(copiedCatalog.testCases).toHaveLength(1);
      expect(copiedCatalog.testCases[0].visibility).toBe('public');
      expect(copiedCatalog.testCases[0].id).toBe('tc-public-001');

      // 5. Assert clean git
      const commitCount = (
        await git({ cwd: codePath, args: ['rev-list', '--count', 'HEAD'] })
      ).trim();
      expect(commitCount).toBe('1');

      // 6. Destroy sandbox
      await destroySandbox(sandboxBasePath);
      expect(await pathExists(sandboxBasePath)).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      if (await pathExists(sandboxBaseDir)) {
        await rm(sandboxBaseDir, { recursive: true, force: true });
      }
    }
  });
});

/**
 * Documents the container/image naming convention used by docker.ts / modes.ts.
 * These tests verify the *format* of names, not the real Docker API calls.
 * They use local builder functions that mirror the format strings in docker.ts so that
 * if the format changes, both places must be updated in sync (intentional coupling).
 *
 * Format (from docker.ts):
 *   container:  saifac-stage-{projectName}-{featureName}-{runId}
 *   image:      saifac-stage-{projectName}-{featureName}-img-{runId}
 *   test runner: saifac-test-{projectName}-{runId}
 *
 * featureName is the canonical slug from getFeatNameOrPrompt (safe for filesystem/Docker).
 *
 * The `docker clear` command:
 *   --all    → matches prefix "saifac-stage-" and "saifac-test-"
 *   default  → matches prefix "saifac-stage-{projectName}-" and "saifac-test-{projectName}-"
 */
describe('container/image naming convention (documentation)', () => {
  const buildContainerName = (projectName: string, featureName: string, runId: string) =>
    `saifac-stage-${projectName}-${featureName}-${runId}`;

  const buildImageTag = (projectName: string, featureName: string, runId: string) =>
    `saifac-stage-${projectName}-${featureName}-img-${runId}`;

  it('container name starts with saifac-stage-', () => {
    expect(buildContainerName('my-project', 'greet-cmd', 'abc1234')).toMatch(/^saifac-stage-/);
  });

  it('image tag starts with saifac-stage-', () => {
    expect(buildImageTag('my-project', 'greet-cmd', 'abc1234')).toMatch(/^saifac-stage-/);
  });

  it('container name is scoped by project name', () => {
    const name = buildContainerName('crawlee-one', 'greet-cmd', 'abc1234');
    expect(name.startsWith('saifac-stage-crawlee-one-')).toBe(true);
  });

  it('image tag is scoped by project name', () => {
    const tag = buildImageTag('crawlee-one', 'greet-cmd', 'abc1234');
    expect(tag.startsWith('saifac-stage-crawlee-one-')).toBe(true);
  });

  it('container name includes the feature name (canonical slug)', () => {
    const name = buildContainerName('my-project', 'greet-cmd', 'abc1234');
    expect(name).toContain('greet-cmd');
  });

  it('nested features use slug in container names (auth-login from (auth)/login)', () => {
    const name = buildContainerName('my-project', 'auth-login', 'abc1234');
    expect(name).not.toMatch(/[()/]/);
    expect(name).toBe('saifac-stage-my-project-auth-login-abc1234');
  });

  it('image tag includes -img- segment to distinguish from containers', () => {
    const tag = buildImageTag('my-project', 'greet-cmd', 'abc1234');
    expect(tag).toContain('-img-');
  });

  it('different projects produce non-overlapping prefixes', () => {
    const proj1 = buildContainerName('project-a', 'feat', 'id1');
    const proj2 = buildContainerName('project-ab', 'feat', 'id1');
    // project-a- should NOT match project-ab-
    expect(proj1).not.toBeUndefined(); // keep proj1 used
    expect(proj2.startsWith(`saifac-stage-project-a-`)).toBe(false);
  });

  it('test runner container name is scoped by project name', () => {
    const buildTestRunnerName = (projectName: string, runId: string) =>
      `saifac-test-${projectName}-${runId}`;

    const name = buildTestRunnerName('crawlee-one', 'abc1234');
    expect(name.startsWith('saifac-test-crawlee-one-')).toBe(true);
    // test runner containers are scoped: docker clear (no --all) uses saifac-test-{proj}-
    expect(name).not.toContain('saifac-test-other-project');
  });
});
