import { describe, expect, it } from 'vitest';

import { buildDiffDirTrie, parseCombinedPatch } from './runDiffParser';

const PATCH_TWO_FILES = `diff --git a/src/index.ts b/src/index.ts
index 111..222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
 unchanged
diff --git /dev/null b/new.md
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# Hi
+line
`;

describe('parseCombinedPatch', () => {
  it('returns empty for empty patch', () => {
    expect(parseCombinedPatch('')).toEqual([]);
    expect(parseCombinedPatch('   \n')).toEqual([]);
  });

  it('parses modify and add', () => {
    const rows = parseCombinedPatch(PATCH_TWO_FILES);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      path: 'src/index.ts',
      change: 'modified',
      added: 1,
      removed: 0,
    });
    expect(rows[1]).toMatchObject({
      path: 'new.md',
      change: 'added',
      added: 2,
      removed: 0,
    });
    expect(rows[0]!.section).toContain('diff --git a/src/index.ts');
  });

  it('parses deleted file', () => {
    const patch = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`;
    const [row] = parseCombinedPatch(patch);
    expect(row).toMatchObject({
      path: 'gone.txt',
      change: 'deleted',
      removed: 2,
      added: 0,
    });
  });

  it('parses rename', () => {
    const patch = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
    const [row] = parseCombinedPatch(patch);
    expect(row).toMatchObject({
      path: 'new.ts',
      fromPath: 'old.ts',
      change: 'renamed',
    });
  });
});

describe('buildDiffDirTrie', () => {
  it('nests paths', () => {
    const stats = parseCombinedPatch(PATCH_TWO_FILES);
    const root = buildDiffDirTrie(stats);
    expect(root.files).toHaveLength(1);
    expect(root.files[0]?.path).toBe('new.md');
    const src = root.dirs.find((d) => d.segment === 'src');
    expect(src?.files).toHaveLength(1);
    expect(src?.files[0]?.path).toBe('src/index.ts');
  });
});
