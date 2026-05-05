/**
 * Unit tests for sandbox utilities.
 *
 * Focuses on the pure, side-effect-free helpers that can run without Docker
 * or the filesystem. Also includes filesystem-based tests for removeAllHiddenDirs.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SANDBOX_CEDAR_POLICY_BASENAME } from '../constants.js';
import { leashManagerContainerName, leashTargetContainerName } from '../engines/docker/index.js';
import { resolveFeature } from '../specs/discover.js';
import { git, gitAdd, gitCommit, gitInit } from '../utils/git.js';
import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { sandboxHasCommitsBeyondInitialImport } from './loop.js';
import {
  createSandbox,
  destroySandbox,
  extractIncrementalRoundPatch,
  filterPatchHunks,
  listFilePathsInUnifiedDiff,
  removeAllHiddenDirs,
  sandboxFromPausedBasePath,
} from './sandbox.js';

const PATCH_TWO_FILES = `\
diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export const greet = () => 'hello';
+export const farewell = () => 'bye';
diff --git a/saifctl/features/foo/tests/tests.json b/saifctl/features/foo/tests/tests.json
index 111aaaa..222bbbb 100644
--- a/saifctl/features/foo/tests/tests.json
+++ b/saifctl/features/foo/tests/tests.json
@@ -1 +1 @@
-{}
+{"testCases":[]}
`;

describe('Leash container naming (pause/resume / stale cleanup)', () => {
  it('manager name is target name with -leash suffix (matches leash runner)', () => {
    const base = '/tmp/saifctl/sandboxes/saifctl-dummy-abc12';
    const target = leashTargetContainerName(base);
    expect(leashManagerContainerName(base)).toBe(`${target}-leash`);
  });
});

describe('sandboxFromPausedBasePath', () => {
  it('derives code, saifctl, and host-base paths', () => {
    const s = sandboxFromPausedBasePath({ runId: 'rid', sandboxBasePath: '/tmp/sbx/p-q-r' });
    expect(s.runId).toBe('rid');
    expect(s.sandboxBasePath).toBe('/tmp/sbx/p-q-r');
    expect(s.codePath).toBe(join('/tmp/sbx/p-q-r', 'code'));
    expect(s.saifctlPath).toBe(join('/tmp/sbx/p-q-r', 'saifctl'));
    expect(s.hostBasePatchPath).toBe(join('/tmp/sbx/p-q-r', 'host-base.patch'));
  });
});

describe('listFilePathsInUnifiedDiff', () => {
  it('returns [] for empty or whitespace patch', () => {
    expect(listFilePathsInUnifiedDiff('')).toEqual([]);
    expect(listFilePathsInUnifiedDiff('   \n')).toEqual([]);
  });

  it('lists paths from standard diff --git headers', () => {
    expect(listFilePathsInUnifiedDiff(PATCH_TWO_FILES)).toEqual([
      'src/index.ts',
      'saifctl/features/foo/tests/tests.json',
    ]);
  });

  it('handles new file header from /dev/null', () => {
    const patch = `diff --git /dev/null b/dummy.md
new file mode 100644
--- /dev/null
+++ b/dummy.md
@@ -0,0 +1 @@
+# Hi
`;
    expect(listFilePathsInUnifiedDiff(patch)).toEqual(['dummy.md']);
  });

  it('dedupes repeated paths', () => {
    const patch = `diff --git a/x b/x
--- a/x
+++ b/x
+1
diff --git a/x b/x
--- a/x
+++ b/x
+2
`;
    expect(listFilePathsInUnifiedDiff(patch)).toEqual(['x']);
  });
});

describe('filterPatchHunks', () => {
  it('returns the full patch when no exclude rules are given', () => {
    expect(filterPatchHunks(PATCH_TWO_FILES, [])).toBe(PATCH_TWO_FILES);
  });

  it('strips sections matching a glob exclude rule', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'glob', pattern: 'saifctl/**' }]);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('saifctl/features/foo/tests/tests.json');
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

  it('strips .saifctl/** (factory task file) when excluded', () => {
    const patchWithTask = `${PATCH_TWO_FILES}diff --git a/.saifctl/task.md b/.saifctl/task.md
index 0000000..1111111 100644
--- /dev/null
+++ b/.saifctl/task.md
@@ -0,0 +1 @@
+task body
`;
    const result = filterPatchHunks(patchWithTask, [{ type: 'glob', pattern: '.saifctl/**' }]);
    expect(result).not.toContain('.saifctl/task.md');
    expect(result).toContain('src/index.ts');
  });
});

describe('sandboxHasCommitsBeyondInitialImport', () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@test.dev',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@test.dev',
  };

  it('is false when only the initial sandbox import commit exists', async () => {
    const base = await mkdtemp(join(process.cwd(), 'sb-commits-0-'));
    const codePath = join(base, 'code');
    try {
      await mkdir(codePath, { recursive: true });
      await gitInit({ cwd: codePath, stdio: 'pipe' });
      await writeUtf8(join(codePath, 'README.md'), 'v0\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'Base state' });
      await expect(sandboxHasCommitsBeyondInitialImport(codePath)).resolves.toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('is true after an additional commit (e.g. replayed runCommits)', async () => {
    const base = await mkdtemp(join(process.cwd(), 'sb-commits-1-'));
    const codePath = join(base, 'code');
    try {
      await mkdir(codePath, { recursive: true });
      await gitInit({ cwd: codePath, stdio: 'pipe' });
      await writeUtf8(join(codePath, 'README.md'), 'v0\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'Base state' });
      await writeUtf8(join(codePath, 'x.txt'), 'x\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'replay step' });
      await expect(sandboxHasCommitsBeyondInitialImport(codePath)).resolves.toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('extractIncrementalRoundPatch', () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@test.dev',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@test.dev',
  };

  it('returns one run commit per commit on the first-parent chain', async () => {
    const base = await mkdtemp(join(process.cwd(), 'extract-round-'));
    const codePath = join(base, 'code');
    try {
      await mkdir(codePath, { recursive: true });
      await gitInit({ cwd: codePath, stdio: 'pipe' });
      await writeUtf8(join(codePath, 'README.md'), 'v0\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'Base state' });
      const preRound = (await git({ cwd: codePath, args: ['rev-parse', 'HEAD'] })).trim();

      await writeUtf8(join(codePath, 'a.txt'), 'a\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({
        cwd: codePath,
        env: gitEnv,
        message: 'commit one',
        author: 'Agent1 <a1@x.dev>',
      });

      await writeUtf8(join(codePath, 'b.txt'), 'b\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({
        cwd: codePath,
        env: gitEnv,
        message: 'commit two',
        author: 'Agent2 <a2@x.dev>',
      });

      const { commits, patch } = await extractIncrementalRoundPatch(codePath, {
        preRoundHeadSha: preRound,
        attempt: 1,
      });
      expect(commits).toHaveLength(2);
      expect(commits[0].message).toContain('commit one');
      expect(commits[0].author).toContain('Agent1');
      expect(commits[1].message).toContain('commit two');
      expect(commits[1].author).toContain('Agent2');
      expect(patch).toContain('a.txt');
      expect(patch).toContain('b.txt');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('records a single WIP run commit when there are no new commits but staged changes', async () => {
    const base = await mkdtemp(join(process.cwd(), 'extract-wip-'));
    const codePath = join(base, 'code');
    try {
      await mkdir(codePath, { recursive: true });
      await gitInit({ cwd: codePath, stdio: 'pipe' });
      await writeUtf8(join(codePath, 'README.md'), 'v0\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'Base state' });
      const preRound = (await git({ cwd: codePath, args: ['rev-parse', 'HEAD'] })).trim();

      await writeUtf8(join(codePath, 'wip.txt'), 'wip\n');
      await gitAdd({ cwd: codePath, env: gitEnv });

      const { commits, patch } = await extractIncrementalRoundPatch(codePath, {
        preRoundHeadSha: preRound,
        attempt: 1,
      });
      expect(commits).toHaveLength(1);
      expect(commits[0].message).toBe('saifctl: coding attempt 1');
      expect(patch).toContain('wip.txt');
      const headAfter = (await git({ cwd: codePath, args: ['rev-parse', 'HEAD'] })).trim();
      expect(headAfter).not.toBe(preRound);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns no commits when nothing changed since preRoundHead', async () => {
    const base = await mkdtemp(join(process.cwd(), 'extract-empty-'));
    const codePath = join(base, 'code');
    try {
      await mkdir(codePath, { recursive: true });
      await gitInit({ cwd: codePath, stdio: 'pipe' });
      await writeUtf8(join(codePath, 'README.md'), 'v0\n');
      await gitAdd({ cwd: codePath, env: gitEnv });
      await gitCommit({ cwd: codePath, env: gitEnv, message: 'Base state' });
      const preRound = (await git({ cwd: codePath, args: ['rev-parse', 'HEAD'] })).trim();

      const { commits, patch } = await extractIncrementalRoundPatch(codePath, {
        preRoundHeadSha: preRound,
        attempt: 1,
      });
      expect(commits).toEqual([]);
      expect(patch).toBe('');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
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
    featureDir: 'saifctl/features/my-feature',
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
  const AGENT_INSTALL_SCRIPT = '#!/bin/sh\necho "agent-install"';
  const AGENT_SCRIPT = '#!/bin/sh\necho "agent"';
  const STAGE_SCRIPT = '#!/bin/sh\necho "stage"';
  const CEDAR_SCRIPT = '// test cedar policy';

  it('creates sandbox with hidden dirs removed, clean git, and mounted scripts; destroySandbox cleans up', async () => {
    const projectDir = await mkdtemp(join(process.cwd(), 'createSandbox-project-'));
    const sandboxBaseDir = await mkdtemp(join(process.cwd(), 'createSandbox-sandbox-'));
    try {
      // 1. Build dummy codebase: .git, .gitignore, saifctl/features with public + hidden tests
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

      const saifctlDir = 'saifctl';
      const featureTests = join(projectDir, saifctlDir, 'features', 'my-feature', 'tests');
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
        saifctlDir,
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

      const gitTestEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test',
      };
      await gitAdd({ cwd: projectDir });
      await gitCommit({
        cwd: projectDir,
        message: 'Add saifctl feature fixtures',
        env: gitTestEnv,
      });

      const feature = await resolveFeature({
        input: 'my-feature',
        projectDir,
        saifctlDir: 'saifctl',
      });
      const paths = await createSandbox({
        feature,
        projectDir,
        saifctlDir,
        projectName: 'test-proj',
        sandboxBaseDir,
        runId: 'abc123',
        gateScript: GATE_SCRIPT,
        startupScript: STARTUP_SCRIPT,
        agentInstallScript: AGENT_INSTALL_SCRIPT,
        agentScript: AGENT_SCRIPT,
        stageScript: STAGE_SCRIPT,
        cedarScript: CEDAR_SCRIPT,
        includeDirty: false,
      });

      const codePath = paths.codePath;
      const sandboxBasePath = paths.sandboxBasePath;

      // 3. Assert hidden dirs are removed
      expect(
        await pathExists(join(codePath, saifctlDir, 'features', 'my-feature', 'tests', 'hidden')),
      ).toBe(false);
      expect(
        await pathExists(
          join(codePath, saifctlDir, 'features', 'other-feature', 'tests', 'hidden'),
        ),
      ).toBe(false);
      expect(
        await pathExists(join(codePath, saifctlDir, 'features', 'my-feature', 'tests', 'public')),
      ).toBe(true);

      // 4. Assert tests.json contains only public test cases
      const copiedCatalog = JSON.parse(
        await readUtf8(join(codePath, saifctlDir, 'features', 'my-feature', 'tests', 'tests.json')),
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

      // 7. Assert saifctl/ bundle scripts exist with correct content and are executable
      const saifctl = paths.saifctlPath;
      const scripts: [string, string][] = [
        [join(saifctl, 'gate.sh'), GATE_SCRIPT],
        [join(saifctl, 'startup.sh'), STARTUP_SCRIPT],
        [join(saifctl, 'agent-install.sh'), AGENT_INSTALL_SCRIPT],
        [join(saifctl, 'agent.sh'), AGENT_SCRIPT],
        [join(saifctl, 'stage.sh'), STAGE_SCRIPT],
      ];
      for (const [p, content] of scripts) {
        expect(await readUtf8(p)).toBe(content);
        expect(((await stat(p)).mode & 0o111) !== 0).toBe(true);
      }
      const cedarPath = join(saifctl, SANDBOX_CEDAR_POLICY_BASENAME);
      expect(await readUtf8(cedarPath)).toBe(CEDAR_SCRIPT);
      for (const name of [
        'coder-start.sh',
        'sandbox-start.sh',
        'staging-start.sh',
        'reviewer.sh',
      ] as const) {
        const p = join(saifctl, name);
        expect(await pathExists(p)).toBe(true);
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

  it('removes existing sandbox and recreates on collision unless reuseExistingSandbox', async () => {
    const projectDir = await mkdtemp(join(process.cwd(), 'createSandbox-project-'));
    const sandboxBaseDir = await mkdtemp(join(process.cwd(), 'createSandbox-sandbox-'));
    try {
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

      const saifctlDir = 'saifctl';
      const featureTests = join(projectDir, saifctlDir, 'features', 'my-feature', 'tests');
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

      const gitTestEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test',
      };
      await gitAdd({ cwd: projectDir });
      await gitCommit({
        cwd: projectDir,
        message: 'Add saifctl feature fixtures',
        env: gitTestEnv,
      });

      const feature = await resolveFeature({
        input: 'my-feature',
        projectDir,
        saifctlDir: 'saifctl',
      });

      const baseOpts = {
        feature,
        projectDir,
        saifctlDir,
        projectName: 'test-proj',
        sandboxBaseDir,
        runId: 'resume-lock-1',
        gateScript: GATE_SCRIPT,
        startupScript: STARTUP_SCRIPT,
        agentInstallScript: AGENT_INSTALL_SCRIPT,
        agentScript: AGENT_SCRIPT,
        stageScript: STAGE_SCRIPT,
        cedarScript: CEDAR_SCRIPT,
        includeDirty: false,
      };

      const first = await createSandbox(baseOpts);
      await expect(
        createSandbox({ ...baseOpts, reuseExistingSandbox: true }),
      ).resolves.toMatchObject({
        sandboxBasePath: first.sandboxBasePath,
        runId: 'resume-lock-1',
      });

      const afterReuse = await createSandbox(baseOpts);
      expect(afterReuse.sandboxBasePath).toBe(first.sandboxBasePath);
      expect(await pathExists(join(afterReuse.codePath, '.git'))).toBe(true);

      await destroySandbox(afterReuse.sandboxBasePath);
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
      // 1. Build dummy codebase with nested feature saifctl/features/(auth)/login
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

      const saifctlDir = 'saifctl';
      const NESTED_CATALOG = {
        ...TEST_CATALOG,
        featureName: '(auth)/login',
        featureDir: 'saifctl/features/(auth)/login',
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

      const loginTests = join(projectDir, saifctlDir, 'features', '(auth)', 'login', 'tests');
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
        saifctlDir,
        'features',
        '(core)',
        'profile',
        'tests',
        'hidden',
      );
      await mkdir(profileHidden, { recursive: true });
      await writeUtf8(join(profileHidden, 'edge.spec.ts'), "import { expect } from 'vitest';\n");

      const gitTestEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test',
      };
      await gitAdd({ cwd: projectDir });
      await gitCommit({
        cwd: projectDir,
        message: 'Add nested saifctl feature fixtures',
        env: gitTestEnv,
      });

      const feature = await resolveFeature({
        input: '(auth)/login',
        projectDir,
        saifctlDir,
      });
      const paths = await createSandbox({
        feature,
        projectDir,
        saifctlDir,
        projectName: 'test-proj',
        sandboxBaseDir,
        runId: 'def456',
        gateScript: GATE_SCRIPT,
        startupScript: STARTUP_SCRIPT,
        agentInstallScript: AGENT_INSTALL_SCRIPT,
        agentScript: AGENT_SCRIPT,
        stageScript: STAGE_SCRIPT,
        cedarScript: CEDAR_SCRIPT,
        includeDirty: false,
      });

      const codePath = paths.codePath;
      const sandboxBasePath = paths.sandboxBasePath;

      // 2. Assert nested feature path resolved (slug used in dir name)
      expect(feature.name).toBe('auth-login');
      expect(paths.sandboxBasePath).toContain('test-proj-auth-login-def456');

      // 3. Assert hidden dirs removed for nested features
      expect(
        await pathExists(
          join(codePath, saifctlDir, 'features', '(auth)', 'login', 'tests', 'hidden'),
        ),
      ).toBe(false);
      expect(
        await pathExists(
          join(codePath, saifctlDir, 'features', '(core)', 'profile', 'tests', 'hidden'),
        ),
      ).toBe(false);
      expect(
        await pathExists(
          join(codePath, saifctlDir, 'features', '(auth)', 'login', 'tests', 'public'),
        ),
      ).toBe(true);

      // 4. Assert tests.json contains only public test cases
      const copiedCatalog = JSON.parse(
        await readUtf8(
          join(codePath, saifctlDir, 'features', '(auth)', 'login', 'tests', 'tests.json'),
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
 *   container:  saifctl-stage-{projectName}-{featureName}-{runId}
 *   image:      saifctl-stage-{projectName}-{featureName}-img-{runId}
 *   test runner: saifctl-test-{projectName}-{runId}
 *
 * featureName is the canonical slug from getFeatNameOrPrompt (safe for filesystem/Docker).
 *
 * The `docker clear` command:
 *   --all    → matches prefix "saifctl-stage-" and "saifctl-test-"
 *   default  → matches prefix "saifctl-stage-{projectName}-" and "saifctl-test-{projectName}-"
 */
describe('container/image naming convention (documentation)', () => {
  const buildContainerName = (projectName: string, featureName: string, runId: string) =>
    `saifctl-stage-${projectName}-${featureName}-${runId}`;

  const buildImageTag = (projectName: string, featureName: string, runId: string) =>
    `saifctl-stage-${projectName}-${featureName}-img-${runId}`;

  it('container name starts with saifctl-stage-', () => {
    expect(buildContainerName('my-project', 'greet-cmd', 'abc1234')).toMatch(/^saifctl-stage-/);
  });

  it('image tag starts with saifctl-stage-', () => {
    expect(buildImageTag('my-project', 'greet-cmd', 'abc1234')).toMatch(/^saifctl-stage-/);
  });

  it('container name is scoped by project name', () => {
    const name = buildContainerName('crawlee-one', 'greet-cmd', 'abc1234');
    expect(name.startsWith('saifctl-stage-crawlee-one-')).toBe(true);
  });

  it('image tag is scoped by project name', () => {
    const tag = buildImageTag('crawlee-one', 'greet-cmd', 'abc1234');
    expect(tag.startsWith('saifctl-stage-crawlee-one-')).toBe(true);
  });

  it('container name includes the feature name (canonical slug)', () => {
    const name = buildContainerName('my-project', 'greet-cmd', 'abc1234');
    expect(name).toContain('greet-cmd');
  });

  it('nested features use slug in container names (auth-login from (auth)/login)', () => {
    const name = buildContainerName('my-project', 'auth-login', 'abc1234');
    expect(name).not.toMatch(/[()/]/);
    expect(name).toBe('saifctl-stage-my-project-auth-login-abc1234');
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
    expect(proj2.startsWith(`saifctl-stage-project-a-`)).toBe(false);
  });

  it('test runner container name is scoped by project name', () => {
    const buildTestRunnerName = (projectName: string, runId: string) =>
      `saifctl-test-${projectName}-${runId}`;

    const name = buildTestRunnerName('crawlee-one', 'abc1234');
    expect(name.startsWith('saifctl-test-crawlee-one-')).toBe(true);
    // test runner containers are scoped: docker clear (no --all) uses saifctl-test-{proj}-
    expect(name).not.toContain('saifctl-test-other-project');
  });
});
