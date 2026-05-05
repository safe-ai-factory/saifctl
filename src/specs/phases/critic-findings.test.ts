/**
 * Tests for the findings-file lifecycle helpers (Block 4b).
 *
 * The fix template no longer tells the agent to delete the findings file —
 * earlier drafts had a silent-data-loss bug (delete-then-verify ordering, see
 * BUILTIN_FIX_TEMPLATE docstring). Saifctl owns the lifecycle now: ensure-dir
 * before discover/fix activates, delete-on-success after a fix subtask passes
 * its gate. These helpers are the orchestrator's grip on that contract; lock
 * them so a future refactor can't quietly break it.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunSubtask } from '../../runs/types.js';
import {
  cleanupFindingsForFixRow,
  ensureCriticFindingsParentDir,
  findingsHostPath,
} from './critic-findings.js';

let codePath: string;

beforeEach(async () => {
  codePath = await mkdtemp(join(tmpdir(), 'critic-findings-'));
});

afterEach(async () => {
  await rm(codePath, { recursive: true, force: true });
});

function makeRow(
  overrides: Partial<RunSubtask['criticPrompt']> & { step?: 'discover' | 'fix' } = {},
): RunSubtask {
  return {
    id: 'sub1',
    title: 'phase:01-core critic:strict round:1/1 fix',
    content: 'body',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    phaseId: '01-core',
    criticPrompt: {
      criticId: 'strict',
      round: 1,
      totalRounds: 1,
      step: overrides.step ?? 'fix',
      findingsPath:
        overrides.findingsPath ?? '/workspace/.saifctl/critic-findings/01-core--strict--r1.md',
      vars: overrides.vars ?? {
        feature: { name: 'auth', dir: 'saifctl/features/auth', plan: '/workspace/plan.md' },
        phase: {
          id: '01-core',
          dir: '/workspace/saifctl/features/auth/phases/01-core',
          spec: '/workspace/spec.md',
          tests: '/workspace/tests',
        },
      },
    },
  };
}

describe('findingsHostPath', () => {
  it('translates /workspace/<x> to <codePath>/<x>', () => {
    const p = findingsHostPath({ codePath, row: makeRow() });
    expect(p).toBe(join(codePath, '.saifctl', 'critic-findings', '01-core--strict--r1.md'));
  });

  it('returns null when the row has no criticPrompt (impl subtask)', () => {
    const row: RunSubtask = {
      id: 'i1',
      title: 'phase:01-core impl',
      content: 'body',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      phaseId: '01-core',
    };
    expect(findingsHostPath({ codePath, row })).toBeNull();
  });

  it('returns null when findingsPath does not start with /workspace/ (defensive)', () => {
    const row = makeRow({ findingsPath: '/etc/passwd' });
    expect(findingsHostPath({ codePath, row })).toBeNull();
  });
});

describe('ensureCriticFindingsParentDir', () => {
  it('creates the parent dir of the findings file (recursive — neither parent exists)', async () => {
    const result = await ensureCriticFindingsParentDir({ codePath, row: makeRow() });
    expect(result.kind).toBe('ok');
    expect(existsSync(join(codePath, '.saifctl', 'critic-findings'))).toBe(true);
  });

  it('is idempotent (safe to call when the dir already exists)', async () => {
    await ensureCriticFindingsParentDir({ codePath, row: makeRow() });
    const result = await ensureCriticFindingsParentDir({ codePath, row: makeRow() });
    expect(result.kind).toBe('ok');
  });

  it('skips rows without a findings path (impl subtasks)', async () => {
    const row: RunSubtask = {
      id: 'i1',
      title: 'impl',
      content: 'body',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      phaseId: '01-core',
    };
    const result = await ensureCriticFindingsParentDir({ codePath, row });
    expect(result.kind).toBe('skipped');
    // No directory created.
    expect(existsSync(join(codePath, '.saifctl'))).toBe(false);
  });

  it('does not pre-create the findings file itself (only its parent dir)', async () => {
    await ensureCriticFindingsParentDir({ codePath, row: makeRow() });
    const filePath = join(codePath, '.saifctl', 'critic-findings', '01-core--strict--r1.md');
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('cleanupFindingsForFixRow', () => {
  it('deletes the findings file when row is a fix subtask', async () => {
    const dir = join(codePath, '.saifctl', 'critic-findings');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, '01-core--strict--r1.md');
    await writeFile(filePath, '- [ ] something to fix', 'utf8');

    const result = await cleanupFindingsForFixRow({ codePath, row: makeRow({ step: 'fix' }) });
    expect(result.kind).toBe('ok');
    expect(existsSync(filePath)).toBe(false);
  });

  it('does NOT delete when row is a discover subtask (lifecycle invariant)', async () => {
    // The whole point of the orchestrator-owned lifecycle is that the fix
    // step keeps the file around between failed-test retries — so deleting
    // on the discover row would defeat the design.
    const dir = join(codePath, '.saifctl', 'critic-findings');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, '01-core--strict--r1.md');
    await writeFile(filePath, 'findings here', 'utf8');

    const result = await cleanupFindingsForFixRow({ codePath, row: makeRow({ step: 'discover' }) });
    expect(result.kind).toBe('skipped');
    expect(existsSync(filePath)).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe('findings here');
  });

  it('does NOT delete on impl rows', async () => {
    const dir = join(codePath, '.saifctl', 'critic-findings');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'unrelated.md');
    await writeFile(filePath, 'unrelated content', 'utf8');

    const row: RunSubtask = {
      id: 'i1',
      title: 'impl',
      content: 'body',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      phaseId: '01-core',
    };
    const result = await cleanupFindingsForFixRow({ codePath, row });
    expect(result.kind).toBe('skipped');
    expect(existsSync(filePath)).toBe(true);
  });

  it('is a no-op when the file is already missing (rm -f semantics)', async () => {
    // Discover never wrote the file, or fix already cleaned up on a prior pass.
    const result = await cleanupFindingsForFixRow({ codePath, row: makeRow({ step: 'fix' }) });
    expect(result.kind).toBe('ok');
  });

  it('refuses to touch paths outside the sandbox (defensive — bad findingsPath)', async () => {
    // A tampered subtasks.json with `findingsPath: /etc/passwd` shouldn't
    // cause us to try `rm /etc/passwd`. The translator returns null for
    // non-/workspace paths, so cleanup short-circuits to skipped.
    const result = await cleanupFindingsForFixRow({
      codePath,
      row: makeRow({ findingsPath: '/etc/passwd' }),
    });
    expect(result.kind).toBe('skipped');
  });
});
