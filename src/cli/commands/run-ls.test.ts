/**
 * Integration tests for `saifac run ls` (and `run list`) using a temp project with `.saifac/runs/*.json`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';

import { consola } from '../../logger.js';
import runCommand from './run.js';

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'saifac-run-ls-'));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

/** Minimal on-disk shape; `run ls` only reads runId, config.featureName, status, updatedAt. */
async function writeRunJson(
  projectDir: string,
  runId: string,
  row: { featureName: string; status: 'failed' | 'completed'; updatedAt: string; taskId?: string },
): Promise<void> {
  const dir = join(projectDir, '.saifac', 'runs');
  await mkdir(dir, { recursive: true });
  const doc = {
    runId,
    taskId: row.taskId,
    baseCommitSha: 'abc',
    runPatchDiff: '',
    specRef: 'saifac/features/x',
    config: { featureName: row.featureName },
    status: row.status,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: row.updatedAt,
  };
  await writeFile(join(dir, `${runId}.json`), JSON.stringify(doc), 'utf8');
}

async function runRunSubcommand(rawArgs: string[]): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(consola, 'log').mockImplementation((msg?: unknown) => {
    lines.push(msg == null ? '' : String(msg));
  });
  try {
    await cittyRunCommand(runCommand, { rawArgs });
    return lines;
  } finally {
    spy.mockRestore();
  }
}

describe('saifac run ls', () => {
  it('prints table headers and one row per run under .saifac/runs', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'aaa111', {
        featureName: 'feat-a',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });
      await writeRunJson(projectDir, 'bbb222', {
        featureName: 'feat-b',
        status: 'completed',
        updatedAt: '2026-03-21T11:00:00.000Z',
      });

      const lines = await runRunSubcommand(['ls', '--project-dir', projectDir]);
      const text = lines.join('\n');

      expect(text).toContain('2 run(s):');
      expect(text).toContain('RUN ID');
      expect(text).toContain('FEATURE');
      expect(text).toContain('STATUS');
      expect(text).toContain('UPDATED');
      expect(text).toContain('aaa111');
      expect(text).toContain('feat-a');
      expect(text).toContain('failed');
      expect(text).toContain('bbb222');
      expect(text).toContain('feat-b');
      expect(text).toContain('completed');
    });
  });

  it('prints no runs when .saifac/runs is missing', async () => {
    await withTempProject(async (projectDir) => {
      const lines = await runRunSubcommand(['ls', '--project-dir', projectDir]);
      expect(lines.some((l) => l.includes('No stored runs found.'))).toBe(true);
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

  it('respects --task filter', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'r1', {
        featureName: 'a',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
        taskId: 'task-alpha',
      });
      await writeRunJson(projectDir, 'r2', {
        featureName: 'b',
        status: 'failed',
        updatedAt: '2026-03-21T11:00:00.000Z',
        taskId: 'task-beta',
      });

      const lines = await runRunSubcommand([
        'ls',
        '--project-dir',
        projectDir,
        '--task',
        'task-beta',
      ]);
      const text = lines.join('\n');

      expect(text).toContain('1 run(s):');
      expect(text).toContain('r2');
      expect(text).not.toContain('r1');
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
