/**
 * Integration tests for `saifctl run ls` (and `run list`) using a temp project with `.saifctl/runs/*.json`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';

import * as loggerModule from '../../logger.js';
import runCommand from './run.js';

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'saifctl-run-ls-'));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

/** Minimal on-disk shape; `run ls` reads runId, config.featureName, status, startedAt, updatedAt. */
async function writeRunJson(
  projectDir: string,
  runId: string,
  row: {
    featureName: string;
    status: 'failed' | 'completed';
    startedAt?: string;
    updatedAt: string;
  },
): Promise<void> {
  const dir = join(projectDir, '.saifctl', 'runs');
  await mkdir(dir, { recursive: true });
  const doc = {
    runId,
    baseCommitSha: 'abc',
    runCommits: [],
    rules: [],
    config: { featureName: row.featureName },
    status: row.status,
    startedAt: row.startedAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: row.updatedAt,
    controlSignal: null,
    pausedSandboxBasePath: null,
    liveInfra: null,
    inspectSession: null,
  };
  await writeFile(join(dir, `${runId}.json`), JSON.stringify(doc), 'utf8');
}

async function runRunSubcommand(rawArgs: string[]): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(loggerModule, 'outputCliData').mockImplementation((msg: string) => {
    lines.push(msg);
  });
  try {
    await cittyRunCommand(runCommand, { rawArgs });
    return lines;
  } finally {
    spy.mockRestore();
  }
}

describe('saifctl run ls', () => {
  it('sorts rows by updatedAt descending (newest first), then runId', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'older', {
        featureName: 'a',
        status: 'failed',
        updatedAt: '2026-03-10T10:00:00.000Z',
      });
      await writeRunJson(projectDir, 'newer', {
        featureName: 'b',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });

      const text = (await runRunSubcommand(['ls', '--project-dir', projectDir])).join('\n');
      const iNewer = text.indexOf('newer');
      const iOlder = text.indexOf('older');
      expect(iNewer).toBeGreaterThan(-1);
      expect(iOlder).toBeGreaterThan(-1);
      expect(iNewer).toBeLessThan(iOlder);
    });
  });

  it('prints table headers and one row per run under .saifctl/runs', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'aaa111', {
        featureName: 'feat-a',
        status: 'failed',
        startedAt: '2026-03-19T08:00:00.000Z',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });
      await writeRunJson(projectDir, 'bbb222', {
        featureName: 'feat-b',
        status: 'completed',
        startedAt: '2026-03-21T09:30:00.000Z',
        updatedAt: '2026-03-21T11:00:00.000Z',
      });

      const lines = await runRunSubcommand(['ls', '--project-dir', projectDir]);
      const text = lines.join('\n');

      expect(text).toContain('2 run(s):');
      expect(text).toContain('RUN_ID');
      expect(text).toContain('FEATURE');
      expect(text).toContain('STATUS');
      expect(text).toContain('STARTED');
      expect(text).toContain('UPDATED');
      expect(text).toContain('aaa111');
      expect(text).toContain('feat-a');
      expect(text).toContain('failed');
      expect(text).toContain('2026-03-19T08:00:00.000Z');
      expect(text).toContain('bbb222');
      expect(text).toContain('feat-b');
      expect(text).toContain('completed');
      expect(text).toContain('2026-03-21T09:30:00.000Z');
    });
  });

  it('prints no runs when .saifctl/runs is missing', async () => {
    await withTempProject(async (projectDir) => {
      const lines = await runRunSubcommand(['ls', '--project-dir', projectDir]);
      expect(lines.some((l) => l.includes('No Runs found.'))).toBe(true);
    });
  });

  it('respects --status failed', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'fail1', {
        featureName: 'x',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });
      await writeRunJson(projectDir, 'ok1', {
        featureName: 'y',
        status: 'completed',
        updatedAt: '2026-03-21T11:00:00.000Z',
      });

      const lines = await runRunSubcommand([
        'ls',
        '--project-dir',
        projectDir,
        '--status',
        'failed',
      ]);
      const text = lines.join('\n');

      expect(text).toContain('1 run(s):');
      expect(text).toContain('fail1');
      expect(text).not.toContain('ok1');
    });
  });

  it('prints disabled message when --storage none', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'x1', {
        featureName: 'a',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });

      const lines = await runRunSubcommand([
        'ls',
        '--project-dir',
        projectDir,
        '--storage',
        'none',
      ]);
      expect(lines.some((l) => l.includes('Run storage is disabled'))).toBe(true);
    });
  });

  it('`list` subcommand matches `ls`', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'same1', {
        featureName: 'f',
        status: 'failed',
        updatedAt: '2026-03-22T12:00:00.000Z',
      });

      const lsOut = (await runRunSubcommand(['ls', '--project-dir', projectDir])).join('\n');
      const listOut = (await runRunSubcommand(['list', '--project-dir', projectDir])).join('\n');

      expect(lsOut).toBe(listOut);
    });
  });
});
