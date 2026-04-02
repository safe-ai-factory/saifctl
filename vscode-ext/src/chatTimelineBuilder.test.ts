import { describe, expect, it } from 'vitest';

import { buildTimeline, innerRoundLabel, outerAttemptLabel } from './chatTimelineBuilder';
import type { RunInfoForChat } from './cliService';

describe('innerRoundLabel', () => {
  it('maps phases', () => {
    expect(innerRoundLabel('gate_passed')).toBe('Gate passed');
    expect(innerRoundLabel('reviewer_passed')).toBe('Gate + review passed');
    expect(innerRoundLabel('gate_failed', 'line1\nline2')).toContain('Gate failed');
    expect(innerRoundLabel('agent_failed', 'curl: (22)')).toContain('Agent error');
  });
});

describe('outerAttemptLabel', () => {
  it('maps phases', () => {
    expect(outerAttemptLabel('tests_passed')).toBe('All tests passed');
    expect(outerAttemptLabel('no_changes')).toBe('Agent made no changes');
    expect(outerAttemptLabel('aborted')).toBe('Aborted');
  });
});

describe('buildTimeline', () => {
  it('merges and sorts by time', () => {
    const info: RunInfoForChat = {
      runId: 'r1',
      status: 'running',
      roundSummaries: [
        {
          attempt: 2,
          phase: 'tests_passed',
          innerRoundCount: 0,
          innerRounds: [],
          commitCount: 0,
          patchBytes: 0,
          startedAt: '2026-01-02T00:00:00Z',
          completedAt: '2026-01-02T00:01:00Z',
        },
        {
          attempt: 1,
          phase: 'tests_failed',
          innerRoundCount: 0,
          innerRounds: [],
          commitCount: 0,
          patchBytes: 0,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
        },
      ],
      rules: [
        {
          id: 'a',
          content: 'hi',
          scope: 'once',
          createdAt: '2026-01-01T12:00:00Z',
          updatedAt: '2026-01-01T12:00:00Z',
        },
      ],
    };
    const t = buildTimeline(info);
    expect(t.map((e) => e.kind)).toEqual(['attempt', 'rule', 'attempt']);
  });
});
