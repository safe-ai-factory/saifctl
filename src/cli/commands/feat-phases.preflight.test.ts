/**
 * Integration test for the `feat run` auto-pre-flight phases validation
 * (Block 6 — clarification: "Auto-runs as a pre-flight before `feat run`").
 *
 * The pre-flight must:
 * 1. Run when `phases/` exists AND `--subtasks` is unset → fail fast with
 *    the validation report on errors.
 * 2. Be SKIPPED when `--subtasks` is passed (the user is explicitly
 *    bypassing phase compilation).
 * 3. Be SKIPPED when no `phases/` dir exists (nothing phased to validate).
 *
 * We exercise the real `parseRunArgs` and assert on what it prints to
 * `consola.error` — the pre-flight is the only thing in `parseRunArgs` that
 * emits `Validation failed for feature` so its presence/absence is a clean
 * signal.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as loggerModule from '../../logger.js';
import { parseRunArgs } from './feat.js';

const EXIT_SENTINEL = '__PROCESS_EXIT__';

interface ParseCapture {
  errors: string[];
  exitCode: number | undefined;
  threwOther: Error | null;
}

async function tryParseRunArgs(
  args: Record<string, string | boolean | undefined>,
): Promise<ParseCapture> {
  const errors: string[] = [];
  const errSpy = vi.spyOn(loggerModule.consola, 'error').mockImplementation((msg?: unknown) => {
    errors.push(msg == null ? '' : String(msg));
  });
  // Suppress the noisy `consola.log` messages parseRunArgs emits before
  // hitting the heavy resolver.
  const logSpy = vi.spyOn(loggerModule.consola, 'log').mockImplementation(() => {});
  const warnSpy = vi.spyOn(loggerModule.consola, 'warn').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
  }) as never);
  try {
    // parseRunArgs is typed against a citty-derived shape; the runtime only
    // reads the keys this test needs, so cast to any.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await parseRunArgs(args as any);
    return { errors, exitCode: undefined, threwOther: null };
  } catch (e) {
    if (e instanceof Error && e.message === EXIT_SENTINEL && 'exitCode' in e) {
      return { errors, exitCode: (e as Error & { exitCode: number }).exitCode, threwOther: null };
    }
    return { errors, exitCode: undefined, threwOther: e instanceof Error ? e : new Error(String(e)) };
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

let projectDir: string;
let featureDir: string;
const FEATURE_NAME = 'auth';

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'saifctl-preflight-'));
  featureDir = join(projectDir, 'saifctl', 'features', FEATURE_NAME);
  await mkdir(featureDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('feat run pre-flight phases validation (Block 6)', () => {
  it('exits 1 with the validation report when phases/ has errors', async () => {
    // Phase dir exists but no spec.md → validate fails.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });

    const { errors, exitCode } = await tryParseRunArgs({
      name: FEATURE_NAME,
      'project-dir': projectDir,
    });

    expect(exitCode).toBe(1);
    expect(errors.some((m) => /Validation failed for feature 'auth'/.test(m))).toBe(true);
    expect(errors.some((m) => /spec\.md/.test(m) && /01-core/.test(m))).toBe(true);
  });

  it('SKIPS the pre-flight when --subtasks is set (escape hatch must bypass validation)', async () => {
    // Same broken phase config as above, but pass --subtasks ⇒ pre-flight
    // must NOT run, so we should NOT see the "Validation failed" message.
    // parseRunArgs may still fail later for other reasons (missing config,
    // missing subtasks file) — we only assert the pre-flight didn't fire.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });

    const { errors } = await tryParseRunArgs({
      name: FEATURE_NAME,
      'project-dir': projectDir,
      subtasks: 'nonexistent.json',
    });

    expect(errors.every((m) => !/Validation failed for feature/.test(m))).toBe(true);
  });

  it('SKIPS the pre-flight when no phases/ directory exists (non-phased feature)', async () => {
    // No phases dir at all — pre-flight must short-circuit.
    const { errors } = await tryParseRunArgs({
      name: FEATURE_NAME,
      'project-dir': projectDir,
    });

    expect(errors.every((m) => !/Validation failed for feature/.test(m))).toBe(true);
  });
});
