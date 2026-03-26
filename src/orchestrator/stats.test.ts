import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consola } from '../logger.js';
import { writeUtf8 } from '../utils/io.js';
import { prepareRoundsStatsFile, readInnerRounds, roundsStatsPath } from './stats.js';

describe('stats', () => {
  beforeEach(() => {
    vi.spyOn(consola, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('readInnerRounds parses valid JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saifac-rounds-'));
    try {
      const logPath = roundsStatsPath(dir);
      await prepareRoundsStatsFile(dir);
      await writeUtf8(
        logPath,
        [
          '{"type":"inner_round","round":1,"phase":"gate_failed","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","gateOutput":"oops"}',
          '{"type":"inner_round","round":2,"phase":"gate_passed","startedAt":"2026-01-01T00:02:00Z","completedAt":"2026-01-01T00:03:00Z"}',
          '',
        ].join('\n'),
      );
      const rows = await readInnerRounds(logPath);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ round: 1, phase: 'gate_failed', gateOutput: 'oops' });
      expect(rows[1]).toMatchObject({ round: 2, phase: 'gate_passed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readInnerRounds accepts agent_failed phase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saifac-rounds-'));
    try {
      const logPath = roundsStatsPath(dir);
      await prepareRoundsStatsFile(dir);
      await writeUtf8(
        logPath,
        '{"type":"inner_round","round":1,"phase":"agent_failed","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:01:00Z","gateOutput":"curl: (22)"}\n',
      );
      const rows = await readInnerRounds(logPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ round: 1, phase: 'agent_failed', gateOutput: 'curl: (22)' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readInnerRounds skips junk lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'saifac-rounds-'));
    try {
      const logPath = roundsStatsPath(dir);
      await prepareRoundsStatsFile(dir);
      await writeUtf8(
        logPath,
        'not json\n{"type":"inner_round","round":1,"phase":"reviewer_failed","startedAt":"a","completedAt":"b"}\n',
      );
      const rows = await readInnerRounds(logPath);
      expect(rows).toHaveLength(1);
      expect(rows[0].phase).toBe('reviewer_failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
