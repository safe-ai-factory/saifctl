/**
 * Unit tests for sandbox utilities.
 *
 * Focuses on the pure, side-effect-free helpers that can run without Docker
 * or the filesystem.
 */

import { describe, expect, it } from 'vitest';

import { filterPatchHunks } from './sandbox.js';

const PATCH_TWO_FILES = `\
diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 export const greet = () => 'hello';
+export const farewell = () => 'bye';
diff --git a/openspec/changes/foo/tests/tests.json b/openspec/changes/foo/tests/tests.json
index 111aaaa..222bbbb 100644
--- a/openspec/changes/foo/tests/tests.json
+++ b/openspec/changes/foo/tests/tests.json
@@ -1 +1 @@
-{}
+{"testCases":[]}
`;

describe('filterPatchHunks', () => {
  it('returns the full patch when no exclude rules are given', () => {
    expect(filterPatchHunks(PATCH_TWO_FILES, [])).toBe(PATCH_TWO_FILES);
  });

  it('strips sections matching a glob exclude rule', () => {
    const result = filterPatchHunks(PATCH_TWO_FILES, [{ type: 'glob', pattern: 'openspec/**' }]);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('openspec/changes/foo/tests/tests.json');
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

/**
 * Documents the container/image naming convention used by docker.ts / modes.ts.
 * These tests verify the *format* of names, not the real Docker API calls.
 * They use local builder functions that mirror the format strings in docker.ts so that
 * if the format changes, both places must be updated in sync (intentional coupling).
 *
 * Format (from docker.ts):
 *   container:  factory-stage-{projectName}-{changeName}-{runId}
 *   image:      factory-stage-{projectName}-{changeName}-img-{runId}
 *   test runner: factory-test-{projectName}-{runId}
 *
 * The `docker clear` command:
 *   --all    → matches prefix "factory-stage-" and "factory-test-"
 *   default  → matches prefix "factory-stage-{projectName}-" and "factory-test-{projectName}-"
 */
describe('container/image naming convention (documentation)', () => {
  const buildContainerName = (projectName: string, changeName: string, runId: string) =>
    `factory-stage-${projectName}-${changeName}-${runId}`;

  const buildImageTag = (projectName: string, changeName: string, runId: string) =>
    `factory-stage-${projectName}-${changeName}-img-${runId}`;

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

  it('container name includes the feature name', () => {
    const name = buildContainerName('my-project', 'greet-cmd', 'abc1234');
    expect(name).toContain('greet-cmd');
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
