import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consola } from '../logger.js';
import { appendUtf8, readUtf8, writeUtf8 } from '../utils/io.js';
import {
  activeOnceRuleIds,
  appendMissingRunRules,
  createRunRule,
  formatRuleBlockForPending,
  markOnceRulesConsumed,
  patchRunRule,
  reconcileRunRulesWithStorage,
  removeRunRuleById,
  rulesForPrompt,
  startRulesWatcher,
} from './rules.js';
import type { RunStorage } from './storage.js';
import type { RunArtifact, RunRule } from './types.js';

function at(iso: string): Pick<RunRule, 'createdAt' | 'updatedAt'> {
  return { createdAt: iso, updatedAt: iso };
}

describe('rulesForPrompt', () => {
  it('orders by createdAt and drops consumed once rules', () => {
    const rules: RunRule[] = [
      {
        id: 'b',
        content: 'second',
        scope: 'always',
        ...at('2025-01-02T00:00:00.000Z'),
      },
      {
        id: 'a',
        content: 'first',
        scope: 'once',
        ...at('2025-01-01T00:00:00.000Z'),
      },
      {
        id: 'c',
        content: 'gone',
        scope: 'once',
        ...at('2025-01-03T00:00:00.000Z'),
        consumedAt: '2025-01-04T00:00:00.000Z',
      },
    ];
    const prompt = rulesForPrompt(rules);
    expect(prompt.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('markOnceRulesConsumed', () => {
  it('sets consumedAt only for listed once ids', () => {
    const rules: RunRule[] = [
      { id: 'x', content: '1', scope: 'once', ...at('2025-01-01T00:00:00.000Z') },
      { id: 'y', content: '2', scope: 'once', ...at('2025-01-02T00:00:00.000Z') },
      { id: 'z', content: 'p', scope: 'always', ...at('2025-01-03T00:00:00.000Z') },
    ];
    markOnceRulesConsumed(rules, ['x']);
    expect(rules[0]!.consumedAt).toBeDefined();
    expect(rules[1]!.consumedAt).toBeUndefined();
    expect(rules[2]!.consumedAt).toBeUndefined();
  });
});

describe('activeOnceRuleIds', () => {
  it('returns unconsumed once rule ids', () => {
    const rules: RunRule[] = [
      { id: 'a', content: '', scope: 'once', ...at('t'), consumedAt: 't2' },
      { id: 'b', content: '', scope: 'once', ...at('t') },
    ];
    expect(activeOnceRuleIds(rules)).toEqual(['b']);
  });
});

describe('createRunRule', () => {
  it('assigns id and timestamps', () => {
    const r = createRunRule('hello', 'always');
    expect(r.content).toBe('hello');
    expect(r.scope).toBe('always');
    expect(r.id).toMatch(/^[0-9a-f]{6}$/);
    expect(r.createdAt).toBe(r.updatedAt);
  });
});

describe('removeRunRuleById', () => {
  it('throws when missing', () => {
    expect(() => removeRunRuleById([], 'nope')).toThrow(/not found/);
  });
});

describe('reconcileRunRulesWithStorage', () => {
  it('returns inMemory when storage list is empty', () => {
    const inMemory: RunRule[] = [
      { id: 'a', content: 'x', scope: 'always', ...at('2025-01-01T00:00:00.000Z') },
    ];
    expect(reconcileRunRulesWithStorage({ inMemory, fromStorage: [] })).toBe(inMemory);
    expect(reconcileRunRulesWithStorage({ inMemory, fromStorage: undefined })).toBe(inMemory);
  });

  it('prefers storage copy for same id (storage is authoritative)', () => {
    const inMemory: RunRule[] = [
      {
        id: 'a',
        content: 'local-stale',
        scope: 'once',
        ...at('2025-01-01T00:00:00.000Z'),
      },
    ];
    const fromStorage: RunRule[] = [
      {
        id: 'a',
        content: 'remote-updated',
        scope: 'once',
        ...at('2025-01-01T00:00:00.000Z'),
        consumedAt: '2025-01-02T00:00:00.000Z',
      },
      { id: 'b', content: 'new', scope: 'always', ...at('2025-01-03T00:00:00.000Z') },
    ];
    const out = reconcileRunRulesWithStorage({ inMemory, fromStorage });
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe('remote-updated');
    expect(out[0]!.consumedAt).toBe('2025-01-02T00:00:00.000Z');
    expect(out[1]!.id).toBe('b');
  });

  it('appends memory-only ids not present in storage (defensive)', () => {
    const inMemory: RunRule[] = [
      { id: 'mem-only', content: 'x', scope: 'always', ...at('2025-01-01T00:00:00.000Z') },
    ];
    const fromStorage: RunRule[] = [
      { id: 'storage-only', content: 'y', scope: 'once', ...at('2025-01-02T00:00:00.000Z') },
    ];
    const out = reconcileRunRulesWithStorage({ inMemory, fromStorage });
    expect(out.map((r) => r.id)).toEqual(['storage-only', 'mem-only']);
  });
});

describe('appendMissingRunRules', () => {
  it('adds only new ids', () => {
    const base: RunRule[] = [
      { id: 'a', content: '1', scope: 'always', ...at('2025-01-01T00:00:00.000Z') },
    ];
    const extra: RunRule[] = [
      { id: 'a', content: 'dup', scope: 'always', ...at('2025-01-02T00:00:00.000Z') },
      { id: 'b', content: '2', scope: 'once', ...at('2025-01-03T00:00:00.000Z') },
    ];
    const out = appendMissingRunRules({ inMemory: base, incoming: extra });
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe('a');
    expect(out[0]!.content).toBe('1');
    expect(out[1]!.id).toBe('b');
  });
});

describe('startRulesWatcher', () => {
  beforeEach(() => {
    vi.spyOn(consola, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes onNewRules with new active rules (caller may write pending file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saifctl-watch-'));
    try {
      const pending = join(dir, 'pending-rules.md');
      await writeUtf8(pending, '');

      const rule: RunRule = {
        id: 'a1b2c3',
        content: 'Use semicolons',
        scope: 'once',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      const artifact = {
        runId: 'run1',
        rules: [rule],
        artifactRevision: 7,
      } as RunArtifact;

      const storage: Pick<RunStorage, 'getRun'> = {
        async getRun() {
          return artifact;
        },
      };

      const onArtifactRevision = vi.fn();
      const onNewRules = vi.fn(async (rules: RunRule[]) => {
        await mkdir(dirname(pending), { recursive: true });
        await appendUtf8(pending, formatRuleBlockForPending(rules));
      });
      const watcher = startRulesWatcher({
        runStorage: storage as RunStorage,
        runId: 'run1',
        knownRuleIds: new Set<string>(),
        onNewRules,
        onArtifactRevision,
        pollIntervalMs: 30,
      });

      for (let i = 0; i < 80 && onNewRules.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      watcher.stop();

      expect(onNewRules).toHaveBeenCalledTimes(1);
      expect(onNewRules.mock.calls[0]![0]).toEqual([rule]);
      expect(onArtifactRevision).toHaveBeenCalledWith(7);
      const body = await readUtf8(pending);
      expect(body).toContain('Use semicolons');
      expect(body).toContain('[once]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips rules already in knownRuleIds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saifctl-watch2-'));
    try {
      const pending = join(dir, 'pending-rules.md');
      await writeUtf8(pending, '');

      const rule: RunRule = {
        id: 'same',
        content: 'x',
        scope: 'always',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      const storage: Pick<RunStorage, 'getRun'> = {
        async getRun() {
          return { runId: 'r', rules: [rule] } as RunArtifact;
        },
      };

      const onNewRules = vi.fn();
      const watcher = startRulesWatcher({
        runStorage: storage as RunStorage,
        runId: 'r',
        knownRuleIds: new Set(['same']),
        onNewRules,
        pollIntervalMs: 30,
      });
      await new Promise((r) => setTimeout(r, 120));
      watcher.stop();
      expect(onNewRules).not.toHaveBeenCalled();
      expect(await readUtf8(pending)).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('patchRunRule', () => {
  it('updates fields', () => {
    const prev: RunRule[] = [
      { id: 'r1', content: 'old', scope: 'once', ...at('2025-01-01T00:00:00.000Z') },
    ];
    const next = patchRunRule(prev, { id: 'r1', content: 'new', scope: 'always' });
    expect(next[0]!.content).toBe('new');
    expect(next[0]!.scope).toBe('always');
    expect(next[0]!.updatedAt >= next[0]!.createdAt).toBe(true);
  });
});
