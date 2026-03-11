/**
 * Unit tests for sandbox utilities.
 *
 * Focuses on the pure, side-effect-free helpers that can run without Docker
 * or the filesystem. Also includes filesystem-based tests for removeAllHiddenDirs.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveFeature } from '../specs/discover.js';
import { createSandbox, destroySandbox, filterPatchHunks, removeAllHiddenDirs } from './sandbox.js';

const PATCH_TWO_FILES = `\
diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export const greet = () => 'hello';
+export const farewell = () => 'bye';
diff --git a/saif/features/foo/tests/tests.json b/saif/features/foo/tests/tests.json
index 111aaaa..222bbbb 100644
--- a/saif/features/foo/tests/tests.json
+++ b/saif/features/foo/tests/tests.json
@@ -1 +1 @@
-{}
+{"testCases":[]}
`;

describe('filterPatchHunks', () => {
  it('returns the full patch when no exclude rules are given', () => {
    expect(filterPatchHunks(PATCH_TWO_FILES, [])).toBe(PATCH_TWO_FILES);
  });

  it('strips sections matching a glob exclude rule', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'glob', pattern: 'saif/**' }]);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('saif/features/foo/tests/tests.json');
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
  it('removes all hidden/ dirs recursively under baseDir', () => {
    const tmp = mkdtempSync(join(process.cwd(), 'sandbox-test-'));
    try {
      // feat-a/tests/public, feat-a/tests/hidden
      mkdirSync(join(tmp, 'feat-a', 'tests', 'public'), { recursive: true });
      mkdirSync(join(tmp, 'feat-a', 'tests', 'hidden'), { recursive: true });
      writeFileSync(join(tmp, 'feat-a', 'tests', 'hidden', 'bar.spec.ts'), '');
      // feat-b/tests/hidden
      mkdirSync(join(tmp, 'feat-b', 'tests', 'hidden'), { recursive: true });
      writeFileSync(join(tmp, 'feat-b', 'tests', 'hidden', 'edge.spec.ts'), '');
      // feat-c/nested/hidden (deep nesting)
      mkdirSync(join(tmp, 'feat-c', 'nested', 'hidden'), { recursive: true });
      writeFileSync(join(tmp, 'feat-c', 'nested', 'hidden', 'deep.ts'), '');

      const removed = removeAllHiddenDirs(tmp);

      expect(removed).toBe(3);
      expect(existsSync(join(tmp, 'feat-a', 'tests', 'hidden'))).toBe(false);
      expect(existsSync(join(tmp, 'feat-b', 'tests', 'hidden'))).toBe(false);
      expect(existsSync(join(tmp, 'feat-c', 'nested', 'hidden'))).toBe(false);
      expect(existsSync(join(tmp, 'feat-a', 'tests', 'public'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('returns 0 when baseDir does not exist', () => {
    const removed = removeAllHiddenDirs('/nonexistent/path/xyz');
    expect(removed).toBe(0);
  });

  it('returns 0 when no hidden dirs are present', () => {
    const tmp = mkdtempSync(join(process.cwd(), 'sandbox-test-'));
    try {
      mkdirSync(join(tmp, 'feat', 'tests', 'public'), { recursive: true });
      writeFileSync(join(tmp, 'feat', 'tests', 'public', 'foo.spec.ts'), '');

      const removed = removeAllHiddenDirs(tmp);

      expect(removed).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe('createSandbox + destroySandbox (integration)', () => {
  const TEST_CATALOG = {
    version: '1.0',
    featureName: 'my-feature',
    featureDir: 'saif/features/my-feature',
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

  it('creates sandbox with hidden dirs removed, clean git, and mounted scripts; destroySandbox cleans up', () => {
    const projectDir = mkdtempSync(join(process.cwd(), 'createSandbox-project-'));
    const sandboxBaseDir = mkdtempSync(join(process.cwd(), 'createSandbox-sandbox-'));
    try {
      // 1. Build dummy codebase: .git, .gitignore, saif/features with public + hidden tests
      writeFileSync(join(projectDir, '.gitignore'), 'node_modules\n');
      execSync('git init', { cwd: projectDir });
      writeFileSync(join(projectDir, 'README.md'), 'dummy');
      execSync('git add README.md', { cwd: projectDir });
      execSync('git commit -m "Initial"', {
        cwd: projectDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test',
        },
      });

      const saifDir = 'saif';
      const featureTests = join(projectDir, saifDir, 'features', 'my-feature', 'tests');
      mkdirSync(join(featureTests, 'public'), { recursive: true });
      mkdirSync(join(featureTests, 'hidden'), { recursive: true });
      writeFileSync(join(featureTests, 'tests.json'), JSON.stringify(TEST_CATALOG, null, 2));
      writeFileSync(
        join(featureTests, 'public', 'foo.spec.ts'),
        "import { expect } from 'vitest';\n",
      );
      writeFileSync(
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
      mkdirSync(otherFeatureHidden, { recursive: true });
      writeFileSync(join(otherFeatureHidden, 'edge.spec.ts'), "import { expect } from 'vitest';\n");

      const feature = resolveFeature({
        input: 'my-feature',
        projectDir,
        saifDir: 'saif',
      });
      const paths = createSandbox({
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
      expect(existsSync(join(codePath, saifDir, 'features', 'my-feature', 'tests', 'hidden'))).toBe(
        false,
      );
      expect(
        existsSync(join(codePath, saifDir, 'features', 'other-feature', 'tests', 'hidden')),
      ).toBe(false);
      expect(existsSync(join(codePath, saifDir, 'features', 'my-feature', 'tests', 'public'))).toBe(
        true,
      );

      // 4. Assert tests.json contains only public test cases
      const copiedCatalog = JSON.parse(
        readFileSync(
          join(codePath, saifDir, 'features', 'my-feature', 'tests', 'tests.json'),
          'utf8',
        ),
      );
      expect(copiedCatalog.testCases).toHaveLength(1);
      expect(copiedCatalog.testCases[0].visibility).toBe('public');
      expect(copiedCatalog.testCases[0].id).toBe('tc-public-001');

      // 5. Assert clean git (one commit "Base state")
      const commitCount = execSync('git rev-list --count HEAD', { cwd: codePath })
        .toString()
        .trim();
      expect(commitCount).toBe('1');
      const lastMsg = execSync('git log -1 --format=%s', { cwd: codePath }).toString().trim();
      expect(lastMsg).toBe('Base state');

      // 6. Assert .git from source was NOT copied (fresh init), and code has .git
      expect(existsSync(join(codePath, '.git'))).toBe(true);

      // 7. Assert mounted scripts exist with correct content and are executable
      const scripts: [string, string][] = [
        [paths.gatePath, GATE_SCRIPT],
        [paths.startupPath, STARTUP_SCRIPT],
        [paths.agentStartPath, AGENT_START_SCRIPT],
        [paths.agentPath, AGENT_SCRIPT],
        [paths.stagePath, STAGE_SCRIPT],
      ];
      for (const [p, content] of scripts) {
        expect(readFileSync(p, 'utf8')).toBe(content);
        expect((statSync(p).mode & 0o111) !== 0).toBe(true);
      }

      // 8. Destroy sandbox
      destroySandbox(sandboxBasePath);

      // 9. Assert sandbox dir is gone
      expect(existsSync(sandboxBasePath)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      if (existsSync(sandboxBaseDir)) {
        rmSync(sandboxBaseDir, { recursive: true, force: true });
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
 *   container:  factory-stage-{projectName}-{featureName}-{runId}
 *   image:      factory-stage-{projectName}-{featureName}-img-{runId}
 *   test runner: factory-test-{projectName}-{runId}
 *
 * featureName is the canonical slug from getFeatNameOrPrompt (safe for filesystem/Docker).
 *
 * The `docker clear` command:
 *   --all    → matches prefix "factory-stage-" and "factory-test-"
 *   default  → matches prefix "factory-stage-{projectName}-" and "factory-test-{projectName}-"
 */
describe('container/image naming convention (documentation)', () => {
  const buildContainerName = (projectName: string, featureName: string, runId: string) =>
    `factory-stage-${projectName}-${featureName}-${runId}`;

  const buildImageTag = (projectName: string, featureName: string, runId: string) =>
    `factory-stage-${projectName}-${featureName}-img-${runId}`;

  it('container name starts with factory-stage-', () => {
    expect(buildContainerName('my-project', 'greet-cmd', 'abc1234')).toMatch(/^factory-stage-/);
  });

  it('image tag starts with factory-stage-', () => {
    expect(buildImageTag('my-project', 'greet-cmd', 'abc1234')).toMatch(/^factory-stage-/);
  });

  it('container name is scoped by project name', () => {
    const name = buildContainerName('crawlee-one', 'greet-cmd', 'abc1234');
    expect(name.startsWith('factory-stage-crawlee-one-')).toBe(true);
  });

  it('image tag is scoped by project name', () => {
    const tag = buildImageTag('crawlee-one', 'greet-cmd', 'abc1234');
    expect(tag.startsWith('factory-stage-crawlee-one-')).toBe(true);
  });

  it('container name includes the feature name (canonical slug)', () => {
    const name = buildContainerName('my-project', 'greet-cmd', 'abc1234');
    expect(name).toContain('greet-cmd');
  });

  it('nested features use slug in container names (auth-login from (auth)/login)', () => {
    const name = buildContainerName('my-project', 'auth-login', 'abc1234');
    expect(name).not.toMatch(/[()/]/);
    expect(name).toBe('factory-stage-my-project-auth-login-abc1234');
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
    expect(proj2.startsWith(`factory-stage-project-a-`)).toBe(false);
  });

  it('test runner container name is scoped by project name', () => {
    const buildTestRunnerName = (projectName: string, runId: string) =>
      `factory-test-${projectName}-${runId}`;

    const name = buildTestRunnerName('crawlee-one', 'abc1234');
    expect(name.startsWith('factory-test-crawlee-one-')).toBe(true);
    // test runner containers are scoped: docker clear (no --all) uses factory-test-{proj}-
    expect(name).not.toContain('factory-test-other-project');
  });
});
