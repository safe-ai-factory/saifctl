import { describe, expect, it, vi } from 'vitest';

import type { RunInfoForChat, SaifctlCliService } from './cliService';
import { RunInfoStore } from './runInfoStore';

function mockCli(infoByCall: RunInfoForChat[]): SaifctlCliService {
  let i = 0;
  return {
    getRunInfoForChat: vi.fn(async () => {
      const next = infoByCall[i];
      i += 1;
      return next ?? null;
    }),
  } as unknown as SaifctlCliService;
}

describe('RunInfoStore', () => {
  it('returns cached run info without calling CLI again', async () => {
    const first: RunInfoForChat = {
      runId: 'r1',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const cli = mockCli([first]);
    const store = new RunInfoStore();
    const a = await store.fetch({ cli, runId: 'r1', projectPath: '/p' });
    const b = await store.fetch({ cli, runId: 'r1', projectPath: '/p' });
    expect(a).toEqual(first);
    expect(b).toEqual(first);
    expect(cli.getRunInfoForChat).toHaveBeenCalledTimes(1);
  });

  it('force refetches and replaces cache', async () => {
    const v1: RunInfoForChat = { runId: 'r1', status: 'running' };
    const v2: RunInfoForChat = { runId: 'r1', status: 'completed' };
    const cli = mockCli([v1, v2]);
    const store = new RunInfoStore();
    await store.fetch({ cli, runId: 'r1', projectPath: '/p' });
    const after = await store.fetch({ cli, runId: 'r1', projectPath: '/p', force: true });
    expect(after).toEqual(v2);
    expect(cli.getRunInfoForChat).toHaveBeenCalledTimes(2);
  });

  it('invalidateAbsent removes stale keys', async () => {
    const cli = mockCli([
      { runId: 'a', status: 'completed' },
      { runId: 'b', status: 'completed' },
    ]);
    const store = new RunInfoStore();
    await store.fetch({ cli, runId: 'a', projectPath: '/p' });
    await store.fetch({ cli, runId: 'b', projectPath: '/q' });
    store.invalidateAbsent([{ projectPath: '/p', runId: 'a' }]);
    expect(store.get('/q', 'b')).toBeUndefined();
    expect(store.get('/p', 'a')).toBeDefined();
  });
});
