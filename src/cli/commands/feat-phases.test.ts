/**
 * Integration tests for `saifctl feat phases compile|validate` (Block 6).
 *
 * Drives the actual citty subcommands — exit code, stdout/stderr capture,
 * and the on-disk artifact written by `compile`. The point is to lock the
 * full CLI contract so a future refactor can't quietly break the user-facing
 * behavior (output path, exit codes, error messages).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand as cittyRunCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as loggerModule from '../../logger.js';
import phasesCommand, { compiledPhasesOutputPath } from './feat-phases.js';

const EXIT_SENTINEL = '__PROCESS_EXIT__';

interface RunCapture {
  logs: string[];
  errors: string[];
  warnings: string[];
  exitCode: number | undefined;
}

async function runPhasesSubcommand(rawArgs: string[]): Promise<RunCapture> {
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const logSpy = vi.spyOn(loggerModule.consola, 'log').mockImplementation((msg?: unknown) => {
    logs.push(msg == null ? '' : String(msg));
  });
  const errSpy = vi.spyOn(loggerModule.consola, 'error').mockImplementation((msg?: unknown) => {
    errors.push(msg == null ? '' : String(msg));
  });
  const warnSpy = vi.spyOn(loggerModule.consola, 'warn').mockImplementation((msg?: unknown) => {
    warnings.push(msg == null ? '' : String(msg));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
  }) as never);
  try {
    await cittyRunCommand(phasesCommand, { rawArgs });
    return { logs, errors, warnings, exitCode: undefined };
  } catch (e) {
    if (e instanceof Error && e.message === EXIT_SENTINEL && 'exitCode' in e) {
      return { logs, errors, warnings, exitCode: (e as Error & { exitCode: number }).exitCode };
    }
    throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

let projectDir: string;
let featureDir: string;
const FEATURE_NAME = 'auth';

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'saifctl-feat-phases-'));
  featureDir = join(projectDir, 'saifctl', 'features', FEATURE_NAME);
  await mkdir(featureDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function makePhase(id: string): Promise<void> {
  const phaseDir = join(featureDir, 'phases', id);
  await mkdir(phaseDir, { recursive: true });
  await writeFile(join(phaseDir, 'spec.md'), `# ${id} spec\n`, 'utf8');
}

describe('saifctl feat phases validate', () => {
  it('exits 0 with a passed message for a valid phased feature', async () => {
    await makePhase('01-core');
    const { errors, exitCode, logs } = await runPhasesSubcommand([
      'validate',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);
    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();
    expect(logs.some((m) => /Validation passed/.test(m))).toBe(true);
  });

  it('exits 1 with the validation report when a phase is missing its spec', async () => {
    // Create the phase dir but no spec.md.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });
    const { errors, exitCode } = await runPhasesSubcommand([
      'validate',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);
    expect(exitCode).toBe(1);
    // Header + one bulleted error line ⇒ at least 2 entries.
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((m) => /Validation failed/.test(m))).toBe(true);
    expect(errors.some((m) => /spec\.md/.test(m) && /01-core/.test(m))).toBe(true);
  });

  it('exits 1 when feature has no phases/ directory at all', async () => {
    // Feature dir exists, but no phases/ → nothing to validate.
    const { errors, exitCode } = await runPhasesSubcommand([
      'validate',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);
    expect(exitCode).toBe(1);
    expect(errors.some((m) => /no phases\/ directory/.test(m))).toBe(true);
  });
});

describe('saifctl feat phases compile', () => {
  it('writes phases.compiled.json under .saifctl/features/<feat>/ and prints the count', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    const { errors, exitCode, logs } = await runPhasesSubcommand([
      'compile',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);

    expect(errors).toEqual([]);
    expect(exitCode).toBeUndefined();

    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    expect(outPath).toBe(
      join(projectDir, '.saifctl', 'features', FEATURE_NAME, 'phases.compiled.json'),
    );
    const raw = await readFile(outPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true); // trailing newline for diff-friendliness
    const parsed = JSON.parse(raw) as Array<{ title?: string; phaseId?: string }>;
    expect(parsed.map((s) => s.title)).toEqual(['phase:01-core impl', 'phase:02-trigger impl']);
    expect(logs.some((m) => /Wrote 2 subtask/.test(m))).toBe(true);
  });

  it('emits a fail-loud placeholder gate script when --gate-script is omitted', async () => {
    await makePhase('01-core');
    await runPhasesSubcommand(['compile', '--name', FEATURE_NAME, '--project-dir', projectDir]);
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    const parsed = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ gateScript?: string }>;
    // Bash shebang stays so the script is syntactically valid.
    expect(parsed[0]?.gateScript).toMatch(/^#!\/usr\/bin\/env bash/);
    // The placeholder MUST embed the shared marker constant; loadSubtasksFromFile
    // greps for this exact string to detect misuse of compile artifacts as
    // `feat run --subtasks` inputs.
    expect(parsed[0]?.gateScript).toContain('SAIFCTL_PHASES_COMPILED_PLACEHOLDER_GATE');
    // Fail closed (exit 1), NOT exit 0. Pre-fix Block 6 used `exit 0` which
    // silently bypassed every gate when the compile artifact was misused as
    // a runnable manifest — exactly the "optional input whose default
    // elevates access" footgun the user warned about.
    expect(parsed[0]?.gateScript).toMatch(/\bexit 1\b/);
    expect(parsed[0]?.gateScript).not.toMatch(/^exit 0$/m);
    // Operator-facing message points the user at the right command.
    expect(parsed[0]?.gateScript).toMatch(/saifctl feat run/);
  });

  it('embeds a real gate script when --gate-script is passed', async () => {
    await makePhase('01-core');
    const gatePath = join(projectDir, 'gate.sh');
    const gateBody = '#!/bin/bash\n# real gate\nexit 0\n';
    await writeFile(gatePath, gateBody, 'utf8');

    await runPhasesSubcommand([
      'compile',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
      '--gate-script',
      'gate.sh',
    ]);
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    const parsed = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ gateScript?: string }>;
    expect(parsed[0]?.gateScript).toBe(gateBody);
  });

  // `--gate-script` previously used `path.join` which silently rewrote an
  // absolute argument like `/abs/gate.sh` into `<projectDir>/abs/gate.sh`.
  // Compare with `--subtasks` which uses `path.resolve`. Lock the parity:
  // an absolute path must be honoured verbatim.
  it('honours an absolute --gate-script path verbatim', async () => {
    await makePhase('01-core');
    // Place the gate script outside projectDir so we know `join` would mangle it.
    const externalDir = await mkdtemp(join(tmpdir(), 'saifctl-feat-phases-gate-'));
    try {
      const gateAbs = join(externalDir, 'gate.sh');
      const gateBody = '#!/bin/bash\n# absolute gate\nexit 0\n';
      await writeFile(gateAbs, gateBody, 'utf8');

      const { errors, exitCode } = await runPhasesSubcommand([
        'compile',
        '--name',
        FEATURE_NAME,
        '--project-dir',
        projectDir,
        '--gate-script',
        gateAbs,
      ]);
      expect(errors).toEqual([]);
      expect(exitCode).toBeUndefined();

      const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
      const parsed = JSON.parse(await readFile(outPath, 'utf8')) as Array<{ gateScript?: string }>;
      expect(parsed[0]?.gateScript).toBe(gateBody);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  // The artifact is the user-facing diff target — host-absolute paths in
  // testScope.include would make two engineers' compiles differ purely
  // because their home directories differ. Lock the rebase: in-tree absolute
  // paths must be rewritten to project-relative POSIX form. Forward slashes
  // even on Windows, since this JSON is read by humans, not by `path.*`.
  it('rewrites testScope.include entries to project-relative POSIX paths in the artifact', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    await runPhasesSubcommand(['compile', '--name', FEATURE_NAME, '--project-dir', projectDir]);
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    const raw = await readFile(outPath, 'utf8');
    const parsed = JSON.parse(raw) as Array<{
      title?: string;
      testScope?: { include?: string[]; cumulative?: boolean };
    }>;

    // Spot-check the first phase.
    const first = parsed[0]?.testScope?.include ?? [];
    expect(first).toContain(`saifctl/features/${FEATURE_NAME}/phases/01-core/tests`);
    // The last phase additionally contains feature- and project-level tests.
    const last = parsed[parsed.length - 1]?.testScope?.include ?? [];
    expect(last).toContain(`saifctl/features/${FEATURE_NAME}/phases/02-trigger/tests`);
    expect(last).toContain(`saifctl/features/${FEATURE_NAME}/tests`);
    expect(last).toContain('saifctl/tests');

    // Defensive: the host path prefix (whatever projectDir's parent is)
    // must NOT appear anywhere in the artifact. Catches a regression where
    // the rebase silently no-ops on some entries.
    expect(raw).not.toContain(projectDir);
    // Also no backslashes (would only show up on Windows hosts, but free to assert).
    for (const s of [...first, ...last]) {
      expect(s).not.toMatch(/\\/);
    }
  });

  it('exits 1 and writes nothing when validation fails', async () => {
    // Phase dir without spec.md ⇒ validation error.
    await mkdir(join(featureDir, 'phases', '01-core'), { recursive: true });

    const { errors, exitCode } = await runPhasesSubcommand([
      'compile',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);
    expect(exitCode).toBe(1);
    expect(errors.some((m) => /Validation failed/.test(m))).toBe(true);

    // No artifact was written.
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    await expect(readFile(outPath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('exits 1 when feature has no phases/ directory', async () => {
    const { errors, exitCode } = await runPhasesSubcommand([
      'compile',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
    ]);
    expect(exitCode).toBe(1);
    expect(errors.some((m) => /no phases\/ directory/.test(m))).toBe(true);
  });

  it('exits 1 when --gate-script points at a missing file', async () => {
    await makePhase('01-core');
    const { errors, exitCode } = await runPhasesSubcommand([
      'compile',
      '--name',
      FEATURE_NAME,
      '--project-dir',
      projectDir,
      '--gate-script',
      'does-not-exist.sh',
    ]);
    expect(exitCode).toBe(1);
    expect(errors.some((m) => /--gate-script file not found/.test(m))).toBe(true);
  });

  // End-to-end: compile-then-load round-trip MUST fail loud, not silently
  // bypass gates. This is the load-bearing security guarantee for the
  // Block-6-hardening fix — pre-fix, an `exit 0` placeholder + no detector
  // meant the round-trip silently let every gate pass.
  it('compile output rejected by loadSubtasksFromFile when used as `feat run --subtasks` input', async () => {
    await makePhase('01-core');
    await runPhasesSubcommand(['compile', '--name', FEATURE_NAME, '--project-dir', projectDir]);
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });

    // Same fixture, real loader.
    const { loadSubtasksFromFile } = await import('../../orchestrator/resolve-subtasks.js');
    const errors: string[] = [];
    const errSpy = vi.spyOn(loggerModule.consola, 'error').mockImplementation((m?: unknown) => {
      errors.push(m == null ? '' : String(m));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw Object.assign(new Error(EXIT_SENTINEL), { exitCode: code ?? 0 });
    }) as never);
    try {
      await expect(loadSubtasksFromFile(outPath)).rejects.toThrow();
      expect(errors.some((m) => /phases\.compiled\.json placeholder marker/.test(m))).toBe(true);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('compiled output is byte-stable across runs (deterministic for diffing)', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    await runPhasesSubcommand(['compile', '--name', FEATURE_NAME, '--project-dir', projectDir]);
    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: FEATURE_NAME });
    const first = await readFile(outPath, 'utf8');

    await runPhasesSubcommand(['compile', '--name', FEATURE_NAME, '--project-dir', projectDir]);
    const second = await readFile(outPath, 'utf8');

    expect(second).toBe(first);
  });
});
