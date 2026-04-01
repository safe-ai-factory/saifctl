import { describe, expect, it } from 'vitest';

import {
  OPTIMISTIC_RUN_STATUS_TTL_MS,
  type OptimisticRunEntry,
  optimisticRunKey,
  resolveOptimisticRunStatusForFetch,
} from './runsOptimistic';

function sampleRun(overrides: Partial<{ id: string; projectPath: string; status: string }> = {}) {
  return {
    id: 'r1',
    projectPath: '/p',
    status: 'running',
    ...overrides,
  };
}

describe('resolveOptimisticRunStatusForFetch', () => {
  it('returns API status when there is no overlay', () => {
    const optimisticByRun = new Map<string, OptimisticRunEntry>();
    const run = sampleRun({ status: 'running' });
    expect(
      resolveOptimisticRunStatusForFetch(run, { optimisticByRun, now: 1_000, ttlMs: 60_000 }),
    ).toBe('running');
    expect(optimisticByRun.size).toBe(0);
  });

  it('shows optimistic display while API status still equals previous', () => {
    const optimisticByRun = new Map<string, OptimisticRunEntry>();
    const t0 = 1_000_000;
    optimisticByRun.set(optimisticRunKey('/p', 'r1'), {
      display: 'pausing',
      prev: 'running',
      setAt: t0,
    });
    const run = sampleRun({ status: 'running' });
    expect(
      resolveOptimisticRunStatusForFetch(run, {
        optimisticByRun,
        now: t0 + 100,
        ttlMs: OPTIMISTIC_RUN_STATUS_TTL_MS,
      }),
    ).toBe('pausing');
    expect(optimisticByRun.size).toBe(1);
  });

  it('clears overlay and returns API status when server moved', () => {
    const optimisticByRun = new Map<string, OptimisticRunEntry>();
    const t0 = 1_000_000;
    optimisticByRun.set(optimisticRunKey('/p', 'r1'), {
      display: 'pausing',
      prev: 'running',
      setAt: t0,
    });
    const run = sampleRun({ status: 'paused' });
    expect(
      resolveOptimisticRunStatusForFetch(run, {
        optimisticByRun,
        now: t0 + 100,
        ttlMs: OPTIMISTIC_RUN_STATUS_TTL_MS,
      }),
    ).toBe('paused');
    expect(optimisticByRun.size).toBe(0);
  });

  it('drops overlay after TTL', () => {
    const optimisticByRun = new Map<string, OptimisticRunEntry>();
    const t0 = 1_000_000;
    optimisticByRun.set(optimisticRunKey('/p', 'r1'), {
      display: 'pausing',
      prev: 'running',
      setAt: t0,
    });
    const run = sampleRun({ status: 'running' });
    expect(
      resolveOptimisticRunStatusForFetch(run, {
        optimisticByRun,
        now: t0 + OPTIMISTIC_RUN_STATUS_TTL_MS + 1_000,
        ttlMs: OPTIMISTIC_RUN_STATUS_TTL_MS,
      }),
    ).toBe('running');
    expect(optimisticByRun.size).toBe(0);
  });
});
