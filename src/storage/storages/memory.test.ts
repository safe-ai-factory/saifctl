import { describe, expect, it } from 'vitest';

import { MemoryStorage } from './memory.js';

interface TestItem {
  runId: string;
  status: string;
  taskId?: string;
}

describe('MemoryStorage', () => {
  it('saves and gets item', async () => {
    const storage = new MemoryStorage<TestItem>();
    const item: TestItem = { runId: 'run-1', status: 'failed' };
    await storage.save('run-1', item);
    const got = await storage.get('run-1');
    expect(got?.runId).toBe('run-1');
    expect(got?.status).toBe('failed');
  });

  it('returns null for missing item', async () => {
    const storage = new MemoryStorage<TestItem>();
    expect(await storage.get('missing')).toBeNull();
  });

  it('lists items with optional filters', async () => {
    const storage = new MemoryStorage<TestItem>();
    await storage.save('run-1', { runId: 'run-1', status: 'failed' });
    await storage.save('run-2', { runId: 'run-2', status: 'completed' });
    const all = await storage.list();
    expect(all).toHaveLength(2);
    const failed = await storage.list([{ type: 'match', field: 'status', value: 'failed' }]);
    expect(failed).toHaveLength(1);
    expect(failed[0].runId).toBe('run-1');
  });

  it('removes a saved item so subsequent get returns null', async () => {
    const storage = new MemoryStorage<TestItem>();
    await storage.save('run-1', { runId: 'run-1', status: 'failed' });
    await storage.delete('run-1');
    expect(await storage.get('run-1')).toBeNull();
  });

  it('clears items with filter', async () => {
    const storage = new MemoryStorage<TestItem>();
    await storage.save('run-1', { runId: 'run-1', status: 'failed' });
    await storage.save('run-2', { runId: 'run-2', status: 'completed' });
    await storage.clear([{ type: 'match', field: 'status', value: 'failed' }]);
    expect(await storage.get('run-1')).toBeNull();
    expect(await storage.get('run-2')).not.toBeNull();
  });
});
