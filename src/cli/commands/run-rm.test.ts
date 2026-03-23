/**
 * Integration tests for `saifac run rm` (and `run remove`) using a temp project with `.saifac/runs/*.json`.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { describe, expect, it, vi } from 'vitest';

import { consola } from '../../logger.js';
import runCommand from './run.js';

const EXIT_SENTINEL = '__PROCESS_EXIT__';

async function withTempProject(fn: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), 'saifac-run-rm-'));
  try {
    await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function writeRunJson(
  projectDir: string,
  runId: string,
  row: { featureName: string; status: 'failed' | 'completed'; updatedAt: string },
): Promise<void> {
  const dir = join(projectDir, '.saifac', 'runs');
  await mkdir(dir, { recursive: true });
  const doc = {
    runId,
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

async function runFileExists(projectDir: string, runId: string): Promise<boolean> {
  try {
    await access(join(projectDir, '.saifac', 'runs', `${runId}.json`));
    return true;
  } catch {
    return false;
  }
}

interface RunCapture {
  logs: string[];
  errors: string[];
  /** Set when `process.exit(n)` was invoked (handler stops after exit). */
  exitCode: number | undefined;
}

async function runRunSubcommand(rawArgs: string[]): Promise<RunCapture> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(consola, 'log').mockImplementation((msg?: unknown) => {
    logs.push(msg == null ? '' : String(msg));
  });
  const errSpy = vi.spyOn(consola, 'error').mockImplementation((msg?: unknown) => {
    errors.push(msg == null ? '' : String(msg));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
  }) as never);
  try {
    await cittyRunCommand(runCommand, { rawArgs });
    return { logs, errors, exitCode: undefined };
  } catch (e) {
    if (e instanceof Error && e.message === EXIT_SENTINEL && 'exitCode' in e) {
      return { logs, errors, exitCode: (e as Error & { exitCode: number }).exitCode };
    }
    throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('saifac run rm', () => {
  it('deletes one run file and leaves others', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'gone', {
        featureName: 'a',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });
      await writeRunJson(projectDir, 'stays', {
        featureName: 'b',
        status: 'completed',
        updatedAt: '2026-03-21T11:00:00.000Z',
      });

      const { logs, errors, exitCode } = await runRunSubcommand([
        'rm',
        'gone',
        '--project-dir',
        projectDir,
      ]);

      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();
      expect(logs.some((l) => l.includes('Deleted run gone'))).toBe(true);
      expect(await runFileExists(projectDir, 'gone')).toBe(false);
      expect(await runFileExists(projectDir, 'stays')).toBe(true);
    });
  });

  it('throws when run id is missing', async () => {
    await withTempProject(async (projectDir) => {
      await expect(runRunSubcommand(['rm', '--project-dir', projectDir])).rejects.toThrow(
        'Missing required positional argument: RUNID',
      );
    });
  });

  it('errors and exits 1 when run not found', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'only', {
        featureName: 'x',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });

      const { logs, errors, exitCode } = await runRunSubcommand([
        'rm',
        'nope',
        '--project-dir',
        projectDir,
      ]);

      expect(logs).toEqual([]);
      expect(errors.some((e) => e.includes('Run not found: nope'))).toBe(true);
      expect(exitCode).toBe(1);
      expect(await runFileExists(projectDir, 'only')).toBe(true);
    });
  });

  it('errors and exits 1 when --storage none', async () => {
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'x1', {
        featureName: 'a',
        status: 'failed',
        updatedAt: '2026-03-20T10:00:00.000Z',
      });

      const { logs, errors, exitCode } = await runRunSubcommand([
        'rm',
        'x1',
        '--project-dir',
        projectDir,
        '--storage',
        'none',
      ]);

      expect(logs).toEqual([]);
      expect(errors.some((e) => e.includes('Run storage is disabled'))).toBe(true);
      expect(exitCode).toBe(1);
      expect(await runFileExists(projectDir, 'x1')).toBe(true);
    });
  });

  it('`remove` subcommand matches `rm`', async () => {
    const row = {
      featureName: 'f',
      status: 'failed' as const,
      updatedAt: '2026-03-22T12:00:00.000Z',
    };

    let rmLogs: string[] = [];
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'delme', row);
      const r = await runRunSubcommand(['rm', 'delme', '--project-dir', projectDir]);
      rmLogs = r.logs;
      expect(r.errors).toEqual([]);
      expect(r.exitCode).toBeUndefined();
    });

    let removeLogs: string[] = [];
    await withTempProject(async (projectDir) => {
      await writeRunJson(projectDir, 'delme', row);
      const r = await runRunSubcommand(['remove', 'delme', '--project-dir', projectDir]);
      removeLogs = r.logs;
      expect(r.errors).toEqual([]);
      expect(r.exitCode).toBeUndefined();
    });

    expect(rmLogs).toEqual(removeLogs);
  });
});
