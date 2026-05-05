/**
 * Tests for per-subtask test scope resolution + merged-tests-dir synthesis.
 */

import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUPPORTED_PROFILES } from '../test-profiles/index.js';
import {
  resolveSubtaskTestScope,
  type SubtaskWithTestScope,
  synthesizeMergedTestsDir,
} from './test-scope.js';

const VITEST = SUPPORTED_PROFILES['node-vitest'];

let TEST_BASE: string;

beforeEach(async () => {
  TEST_BASE = join(tmpdir(), `test-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(TEST_BASE, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_BASE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// resolveSubtaskTestScope
// ---------------------------------------------------------------------------

describe('resolveSubtaskTestScope', () => {
  it('returns empty sources when neither active nor any prior has testScope (legacy fallback)', () => {
    const r = resolveSubtaskTestScope({
      subtasks: [{}, {}],
      currentSubtaskIndex: 1,
    });
    expect(r.sources).toEqual([]);
  });

  it('returns active subtask include when cumulative=false', () => {
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      { testScope: { include: ['/feat/phases/02/tests'], cumulative: false } },
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 1 });
    expect(r.sources).toEqual(['/feat/phases/02/tests']);
  });

  it('cumulative (default true) accumulates prior subtasks include in order', () => {
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      { testScope: { include: ['/feat/phases/02/tests'] } },
      { testScope: { include: ['/feat/phases/03/tests'] } },
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 2 });
    expect(r.sources).toEqual([
      '/feat/phases/01/tests',
      '/feat/phases/02/tests',
      '/feat/phases/03/tests',
    ]);
  });

  it('skips prior subtasks that have no testScope (no implicit "whole feature")', () => {
    // E.g. a critic subtask sandwiched between phases — if the compiler
    // omitted testScope on it, we don't want to silently expand to feature-wide.
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      {}, // no testScope
      { testScope: { include: ['/feat/phases/02/tests'] } },
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 2 });
    expect(r.sources).toEqual(['/feat/phases/01/tests', '/feat/phases/02/tests']);
  });

  it('active subtask without testScope inherits cumulative chain from priors', () => {
    // This is the "sandwiched critic compiled without an explicit scope" case
    // that the deviation note promised: the critic must NOT silently expand to
    // the whole feature tests/ dir; it gates on what the surrounding phases
    // declared.
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      { testScope: { include: ['/feat/phases/02/tests'] } },
      {}, // no testScope — should still inherit priors
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 2 });
    expect(r.sources).toEqual(['/feat/phases/01/tests', '/feat/phases/02/tests']);
  });

  it('first subtask without testScope and no priors yields empty (legacy fallback)', () => {
    const r = resolveSubtaskTestScope({
      subtasks: [{}],
      currentSubtaskIndex: 0,
    });
    expect(r.sources).toEqual([]);
  });

  it('de-duplicates repeated paths (first occurrence wins)', () => {
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      // Critic subtask that re-includes phase 1's tests.
      { testScope: { include: ['/feat/phases/01/tests'] } },
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 1 });
    expect(r.sources).toEqual(['/feat/phases/01/tests']);
  });

  it('first subtask has no priors to accumulate', () => {
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 0 });
    expect(r.sources).toEqual(['/feat/phases/01/tests']);
  });

  it('include with empty array still resolves cumulative chain', () => {
    const subtasks: SubtaskWithTestScope[] = [
      { testScope: { include: ['/feat/phases/01/tests'] } },
      { testScope: { include: [] } }, // critic that adds no new sources
    ];
    const r = resolveSubtaskTestScope({ subtasks, currentSubtaskIndex: 1 });
    expect(r.sources).toEqual(['/feat/phases/01/tests']);
  });
});

// ---------------------------------------------------------------------------
// synthesizeMergedTestsDir
// ---------------------------------------------------------------------------

describe('synthesizeMergedTestsDir', () => {
  it('throws on empty sources (caller bug — should fall back before calling)', async () => {
    await expect(
      synthesizeMergedTestsDir({
        sources: [],
        destDir: join(TEST_BASE, 'merged'),
        testProfile: VITEST,
      }),
    ).rejects.toThrow(/empty sources/);
  });

  it('short-circuits when sources has exactly one entry (no synthesis)', async () => {
    const onlySource = join(TEST_BASE, 'phases', '01-core', 'tests');
    await mkdir(onlySource, { recursive: true });
    const merged = await synthesizeMergedTestsDir({
      sources: [onlySource],
      destDir: join(TEST_BASE, 'merged'),
      testProfile: VITEST,
    });
    expect(merged).toBe(onlySource);
    // destDir was never created because we short-circuited.
    await expect(lstat(join(TEST_BASE, 'merged'))).rejects.toThrow();
  });

  it('synthesizes a self-contained merged dir with real files (no symlinks)', async () => {
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(join(a, 'public'), { recursive: true });
    await mkdir(join(a, 'hidden'), { recursive: true });
    await mkdir(join(b, 'public'), { recursive: true });
    await writeFile(join(a, 'public', 'foo.test.ts'), 'a-pub-foo');
    await writeFile(join(a, 'hidden', 'bar.test.ts'), 'a-hid-bar');
    await writeFile(join(b, 'public', 'baz.test.ts'), 'b-pub-baz');

    const dest = join(TEST_BASE, 'merged');
    const out = await synthesizeMergedTestsDir({
      sources: [a, b],
      destDir: dest,
      testProfile: VITEST,
    });
    expect(out).toBe(dest);

    // Each source becomes a self-contained subtree under its label, so spec
    // files at <label>/public/foo.spec.ts can keep using `../helpers.js` —
    // helpers live at <label>/helpers.ts, exactly as in the unmerged layout.
    // Critically, each entry must be a REAL file (not a symlink) so the
    // Docker test runner's bind-mount resolves cleanly inside the container.
    const aPubFile = join(dest, '01-core_tests', 'public', 'foo.test.ts');
    const aHidFile = join(dest, '01-core_tests', 'hidden', 'bar.test.ts');
    const bPubFile = join(dest, '02-trigger_tests', 'public', 'baz.test.ts');

    const aPubStat = await lstat(aPubFile);
    const aHidStat = await lstat(aHidFile);
    const bPubStat = await lstat(bPubFile);
    expect(aPubStat.isSymbolicLink()).toBe(false);
    expect(aHidStat.isSymbolicLink()).toBe(false);
    expect(bPubStat.isSymbolicLink()).toBe(false);
    expect(aPubStat.isFile()).toBe(true);

    // Contents are identical to source.
    expect((await readFile(aPubFile, 'utf8')).toString()).toBe('a-pub-foo');
    expect((await readFile(aHidFile, 'utf8')).toString()).toBe('a-hid-bar');
    expect((await readFile(bPubFile, 'utf8')).toString()).toBe('b-pub-baz');
  });

  it('hardlinks share inode with source when same filesystem (no data duplication)', async () => {
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    await mkdir(join(a, 'public'), { recursive: true });
    await writeFile(join(a, 'public', 'foo.test.ts'), 'shared');

    // Use a second source so the synth path runs (single-source short-circuits).
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(join(b, 'public'), { recursive: true });
    await writeFile(join(b, 'public', 'bar.test.ts'), 'unrelated');

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    const srcStat = await stat(join(a, 'public', 'foo.test.ts'));
    const dstStat = await stat(join(dest, '01-core_tests', 'public', 'foo.test.ts'));
    // TEST_BASE is on a single filesystem (tmpdir), so hardlink should succeed
    // and share inode. Skip this expectation if the fallback path triggered
    // (unlikely on a tmpfs/APFS dev filesystem).
    if (srcStat.dev === dstStat.dev) {
      expect(dstStat.ino).toBe(srcStat.ino);
    }
  });

  it('omits sub-trees for source dirs missing public/ or hidden/', async () => {
    const a = join(TEST_BASE, 'phases', 'spike', 'tests');
    const b = join(TEST_BASE, 'phases', '01-core', 'tests');
    // a/ has only public; b/ has both
    await mkdir(join(a, 'public'), { recursive: true });
    await mkdir(join(b, 'public'), { recursive: true });
    await mkdir(join(b, 'hidden'), { recursive: true });

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    // a has no hidden/ — no subdir should be created for it
    await expect(stat(join(dest, 'spike_tests', 'hidden'))).rejects.toThrow();
    // b has both
    expect((await stat(join(dest, '01-core_tests', 'public'))).isDirectory()).toBe(true);
    expect((await stat(join(dest, '01-core_tests', 'hidden'))).isDirectory()).toBe(true);
  });

  it('materializes helpers.ts and infra.spec.ts per-source under each label', async () => {
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, 'helpers.ts'), 'a-helpers');
    await writeFile(join(b, 'infra.spec.ts'), 'b-infra');

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    const aHelpers = join(dest, '01-core_tests', 'helpers.ts');
    const bInfra = join(dest, '02-trigger_tests', 'infra.spec.ts');
    expect((await lstat(aHelpers)).isSymbolicLink()).toBe(false);
    expect((await lstat(bInfra)).isSymbolicLink()).toBe(false);
    expect((await readFile(aHelpers, 'utf8')).toString()).toBe('a-helpers');
    expect((await readFile(bInfra, 'utf8')).toString()).toBe('b-infra');
  });

  it("keeps each source's helpers.ts isolated under its own label (no merge ambiguity)", async () => {
    // Two sources each with their own helpers.ts: per-source isolation means
    // both materialize side-by-side under their labels — no singleton, no
    // conflict. Specs in each source keep their `../helpers.js` import.
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, 'helpers.ts'), 'a-helpers');
    await writeFile(join(b, 'helpers.ts'), 'b-helpers');

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    expect((await readFile(join(dest, '01-core_tests', 'helpers.ts'), 'utf8')).toString()).toBe(
      'a-helpers',
    );
    expect((await readFile(join(dest, '02-trigger_tests', 'helpers.ts'), 'utf8')).toString()).toBe(
      'b-helpers',
    );
  });

  it('is idempotent — re-synthesizing wipes the prior dest and rebuilds', async () => {
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    const c = join(TEST_BASE, 'phases', '03-edge', 'tests');
    for (const d of [a, b, c]) {
      await mkdir(join(d, 'public'), { recursive: true });
      await writeFile(join(d, 'public', 'placeholder.test.ts'), '');
    }

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });
    // Re-synthesize with a different source set; the old labels must be gone.
    await synthesizeMergedTestsDir({ sources: [b, c], destDir: dest, testProfile: VITEST });

    await expect(stat(join(dest, '01-core_tests'))).rejects.toThrow();
    expect((await stat(join(dest, '02-trigger_tests', 'public'))).isDirectory()).toBe(true);
    expect((await stat(join(dest, '03-edge_tests', 'public'))).isDirectory()).toBe(true);
  });

  it('recursively materializes nested subdirs (real dirs all the way down)', async () => {
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    await mkdir(join(a, 'public', 'group', 'sub'), { recursive: true });
    await writeFile(join(a, 'public', 'group', 'sub', 'deep.test.ts'), 'deep');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(join(b, 'public'), { recursive: true });

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    const deep = join(dest, '01-core_tests', 'public', 'group', 'sub', 'deep.test.ts');
    const deepStat = await lstat(deep);
    expect(deepStat.isSymbolicLink()).toBe(false);
    expect(deepStat.isFile()).toBe(true);
    expect((await readFile(deep, 'utf8')).toString()).toBe('deep');
  });

  it('materializes per-profile helpers/infra/example filenames (non-vitest profiles)', async () => {
    // Earlier versions hardcoded helpers.ts / infra.spec.ts in the merger and
    // silently dropped python/go/rust files. Verify python-pytest's three
    // top-level files (helpers.py, test_infra.py, test_example.py) plus the
    // public tree are all materialized into per-source labels.
    const PYTEST = SUPPORTED_PROFILES['python-pytest'];
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(join(a, 'public'), { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, PYTEST.helpersFilename), '# helpers');
    await writeFile(join(a, PYTEST.infraFilename!), '# infra');
    await writeFile(join(a, PYTEST.exampleFilename), '# example');
    await writeFile(join(a, 'public', 'test_thing.py'), '# spec');
    await writeFile(join(b, PYTEST.helpersFilename), '# b helpers');

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: PYTEST });

    expect(
      (await readFile(join(dest, '01-core_tests', PYTEST.helpersFilename), 'utf8')).toString(),
    ).toBe('# helpers');
    expect(
      (await readFile(join(dest, '01-core_tests', PYTEST.infraFilename!), 'utf8')).toString(),
    ).toBe('# infra');
    expect(
      (await readFile(join(dest, '01-core_tests', PYTEST.exampleFilename), 'utf8')).toString(),
    ).toBe('# example');
    expect(
      (await readFile(join(dest, '01-core_tests', 'public', 'test_thing.py'), 'utf8')).toString(),
    ).toBe('# spec');
    expect(
      (await readFile(join(dest, '02-trigger_tests', PYTEST.helpersFilename), 'utf8')).toString(),
    ).toBe('# b helpers');
    // Vitest filenames must NOT have been written: nothing requested them and
    // the source had no .ts file to materialize.
    await expect(stat(join(dest, '01-core_tests', 'helpers.ts'))).rejects.toThrow();
    await expect(stat(join(dest, '01-core_tests', 'infra.spec.ts'))).rejects.toThrow();
  });

  it('materializes example filename per-source (vitest)', async () => {
    // The example file at the top level was previously not materialized at all
    // in the multi-source path. Verify it now flows through.
    const a = join(TEST_BASE, 'phases', '01-core', 'tests');
    const b = join(TEST_BASE, 'phases', '02-trigger', 'tests');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, VITEST.exampleFilename), '// a example');
    await writeFile(join(b, VITEST.exampleFilename), '// b example');

    const dest = join(TEST_BASE, 'merged');
    await synthesizeMergedTestsDir({ sources: [a, b], destDir: dest, testProfile: VITEST });

    expect(
      (await readFile(join(dest, '01-core_tests', VITEST.exampleFilename), 'utf8')).toString(),
    ).toBe('// a example');
    expect(
      (await readFile(join(dest, '02-trigger_tests', VITEST.exampleFilename), 'utf8')).toString(),
    ).toBe('// b example');
  });
});
