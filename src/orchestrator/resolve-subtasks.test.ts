/**
 * Tests for {@link loadSubtasksFromFile} and {@link synthesizePlanSpecSubtaskInputs}.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadSubtasksFromFile,
  resolveSubtasks,
  synthesizePlanSpecSubtaskInputs,
} from './resolve-subtasks.js';

describe('resolve-subtasks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'saifctl-subtasks-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loadSubtasksFromFile parses a valid manifest', async () => {
    const p = join(dir, 'st.json');
    await writeFile(
      p,
      JSON.stringify([{ content: '  do work  ', title: 'T', gateRetries: 2 }]),
      'utf8',
    );
    const rows = await loadSubtasksFromFile(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('do work');
    expect(rows[0]?.title).toBe('T');
    expect(rows[0]?.gateRetries).toBe(2);
  });

  it('loadSubtasksFromFile exits on invalid JSON', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, '{', 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(loadSubtasksFromFile(p)).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });

  it('loadSubtasksFromFile exits on empty array', async () => {
    const p = join(dir, 'empty.json');
    await writeFile(p, '[]', 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(loadSubtasksFromFile(p)).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });

  // Block 6 hardening: `feat phases compile` writes a "review-only" JSON
  // whose placeholder gate script embeds SAIFCTL_PHASES_COMPILED_PLACEHOLDER_GATE.
  // Loading that artifact via `feat run --subtasks <compiled>` would let the
  // placeholder gate stand in for a real one — the original `exit 0`
  // placeholder silently passed every gate. We now refuse such inputs with a
  // guiding error so the misuse is caught at load-time, not silently masked.
  it('loadSubtasksFromFile refuses a compile-output artifact (placeholder gate marker present)', async () => {
    const p = join(dir, 'compiled.json');
    await writeFile(
      p,
      JSON.stringify([
        {
          content: 'phase:01-core impl',
          gateScript: '#!/usr/bin/env bash\n# SAIFCTL_PHASES_COMPILED_PLACEHOLDER_GATE\nexit 1\n',
        },
      ]),
      'utf8',
    );
    const errors: string[] = [];
    const consolaModule = await import('../logger.js');
    const errSpy = vi.spyOn(consolaModule.consola, 'error').mockImplementation((m?: unknown) => {
      errors.push(m == null ? '' : String(m));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(loadSubtasksFromFile(p)).rejects.toThrow('exit:1');
      expect(errors.some((m) => /phases\.compiled\.json placeholder marker/.test(m))).toBe(true);
      // Error must point the user at the right command, not just bail.
      expect(errors.some((m) => /saifctl feat run/.test(m))).toBe(true);
      expect(errors.some((m) => /--gate-script/.test(m))).toBe(true);
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('loadSubtasksFromFile exits when content is missing', async () => {
    const p = join(dir, 'noc.json');
    await writeFile(p, JSON.stringify([{ title: 'x' }]), 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(loadSubtasksFromFile(p)).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });

  // Block 5 (link, don't inline): synthesizePlanSpecSubtaskInputs no longer
  // embeds plan/spec content into the prompt. It emits a strong directive
  // pointing at workspace-root-relative paths and tells the agent it MUST
  // read them. The synthesiser runs at options-baseline time, before any
  // `--engine local` CLI override is applied — so the directive uses
  // **relative POSIX paths** (engine-agnostic; agent's cwd is the
  // workspace root in both Docker and host execution). These tests lock the
  // new contract — and explicitly assert the OLD inline strings do NOT
  // appear, so a regression to inlining shows up immediately.
  it('synthesizePlanSpecSubtaskInputs links plan + spec by relative path (not inline) when both present', async () => {
    await writeFile(join(dir, 'plan.md'), '# Plan\n\nHello plan body', 'utf8');
    await writeFile(join(dir, 'specification.md'), 'SPEC BODY here', 'utf8');
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'my-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl/features/my-feat',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';

    // Workspace-root-relative paths in the directive (engine-agnostic).
    expect(content).toContain('saifctl/features/my-feat/plan.md');
    expect(content).toContain('saifctl/features/my-feat/specification.md');
    // Critical regression guard: the synthesiser must NOT bake in
    // `/workspace/...` (would break `--engine local` where the agent runs
    // on the host, not inside a container).
    expect(content).not.toContain('/workspace/');
    // Strong directive — the literal "MUST read" wording is the load-bearing
    // mitigation per Block 5 risk discussion.
    expect(content).toMatch(/MUST read/);
    // Cwd hint so the agent knows the path is relative (engine-agnostic).
    expect(content).toMatch(/working directory/i);

    // Block 5 negative assertions: NO inlined content, NO section headings.
    expect(content).not.toContain('Hello plan body');
    expect(content).not.toContain('SPEC BODY here');
    expect(content).not.toContain('## Plan');
    expect(content).not.toContain('## Specification');
  });

  it('synthesizePlanSpecSubtaskInputs spec-only path uses spec-only directive', async () => {
    await writeFile(join(dir, 'specification.md'), 'SPEC ONLY', 'utf8');
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'spec-only-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl/features/spec-only-feat',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';
    expect(content).toContain('saifctl/features/spec-only-feat/specification.md');
    expect(content).not.toContain('/workspace/');
    expect(content).not.toContain('plan.md');
    expect(content).not.toContain('SPEC ONLY');
  });

  it('synthesizePlanSpecSubtaskInputs plan-only path uses plan-only directive', async () => {
    await writeFile(join(dir, 'plan.md'), 'PLAN ONLY', 'utf8');
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'plan-only-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl/features/plan-only-feat',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';
    expect(content).toContain('saifctl/features/plan-only-feat/plan.md');
    expect(content).not.toContain('/workspace/');
    expect(content).not.toContain('specification.md');
    expect(content).not.toContain('PLAN ONLY');
  });

  it('synthesizePlanSpecSubtaskInputs falls back to honest "no spec/plan" prompt when neither file exists', async () => {
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'bare-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl/features/bare-feat',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';
    expect(content).toContain('bare-feat');
    expect(content).toMatch(/no specification or plan was found/i);
    expect(content).not.toContain('plan.md');
    expect(content).not.toContain('specification.md');
  });

  it('resolveSubtasks auto-loads feature subtasks.json when flag is unset', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'auto-f');
    await mkdir(featDir, { recursive: true });
    await writeFile(
      join(featDir, 'subtasks.json'),
      JSON.stringify([{ content: 'from manifest' }]),
      'utf8',
    );
    const rows = await resolveSubtasks({
      subtasksFlag: undefined,
      featureAbsolutePath: featDir,
      featureName: 'auto-f',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      projectDir: dir,
    });
    expect(rows).toEqual([{ content: 'from manifest' }]);
  });

  it('resolveSubtasks exits when --subtasks file is missing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(
        resolveSubtasks({
          subtasksFlag: 'missing-subtasks.json',
          featureAbsolutePath: dir,
          featureName: 'f',
          saifctlDir: 'saifctl',
          gateScript: 'g',
          projectDir: dir,
        }),
      ).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });

  // The synthesiser normalises `\\` → `/` internally so callers can pass
  // either separator style without breaking the directive on Windows.
  // Symmetric with agent-task.ts (which also normalises internally).
  it('resolveSubtasks: forward-slash POSIX path appears in the directive regardless of host', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'norm-feat');
    await mkdir(featDir, { recursive: true });
    await writeFile(join(featDir, 'plan.md'), '# Plan', 'utf8');
    await writeFile(join(featDir, 'specification.md'), '# Spec', 'utf8');

    const rows = await resolveSubtasks({
      subtasksFlag: undefined,
      featureAbsolutePath: featDir,
      featureName: 'norm-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';
    expect(content).toContain('saifctl/features/norm-feat/plan.md');
    expect(content).toContain('saifctl/features/norm-feat/specification.md');
    expect(content).not.toMatch(/saifctl\\features/);
  });

  it('synthesizePlanSpecSubtaskInputs normalises backslash-bearing featureRelativePath to POSIX', async () => {
    // Block 5 deviation rewrite: normalisation moved INTO the synthesiser
    // (was in resolveSubtasks). Lock the new contract — passing a
    // backslash-separated `featureRelativePath` (what `path.relative()`
    // returns on a Windows host) must still yield a POSIX directive.
    await writeFile(join(dir, 'plan.md'), 'PLAN', 'utf8');
    await writeFile(join(dir, 'specification.md'), 'SPEC', 'utf8');
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'win-rel',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl\\features\\win-rel',
      projectDir: dir,
    });
    const content = rows[0]?.content ?? '';
    expect(content).toContain('saifctl/features/win-rel/plan.md');
    expect(content).toContain('saifctl/features/win-rel/specification.md');
    expect(content).not.toMatch(/saifctl\\features/);
  });

  it('synthesizePlanSpecSubtaskInputs includes gateScript on the row', async () => {
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: dir,
      featureName: 'my-feat',
      saifctlDir: 'saifctl',
      gateScript: '#!/bin/bash\necho gate',
      featureRelativePath: 'saifctl/features/my-feat',
      projectDir: dir,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('my-feat');
    expect(rows[0]?.gateScript).toBe('#!/bin/bash\necho gate');
    expect(rows[0]?.content).toContain('my-feat');
    expect(rows[0]?.content).toContain('/saifctl/');
  });

  // Block 7: every feature run (phased OR not) must include the
  // project-level `saifctl/tests/` dir in its testScope so the always-immutable
  // suite gates regardless of feature config. The phased path adds it inside
  // `compilePhasesToSubtasks` (Block 3); the non-phased synthesiser does it
  // here. `synthesizeMergedTestsDir` silently skips missing source dirs, so
  // declaring the path is safe even when `saifctl/tests/` doesn't yet exist.
  it('synthesizePlanSpecSubtaskInputs includes project-level saifctl/tests/ in testScope.include', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'my-feat');
    await mkdir(featDir, { recursive: true });
    const rows = await synthesizePlanSpecSubtaskInputs({
      featureAbsolutePath: featDir,
      featureName: 'my-feat',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      featureRelativePath: 'saifctl/features/my-feat',
      projectDir: dir,
    });
    expect(rows[0]?.testScope?.include).toContain(join(dir, 'saifctl', 'tests'));
    expect(rows[0]?.testScope?.include).toContain(join(featDir, 'tests'));
    expect(rows[0]?.testScope?.cumulative).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Block 3 — phases/ source + mutual exclusion with subtasks.json
  // -------------------------------------------------------------------------

  it('resolveSubtasks compiles a phased feature when phases/ exists', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'phased-f');
    const phase1 = join(featDir, 'phases', '01-core');
    await mkdir(phase1, { recursive: true });
    await writeFile(join(phase1, 'spec.md'), '# spec', 'utf8');
    await mkdir(join(phase1, 'tests'), { recursive: true });

    const rows = await resolveSubtasks({
      subtasksFlag: undefined,
      featureAbsolutePath: featDir,
      featureName: 'phased-f',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      projectDir: dir,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('phase:01-core impl');
    expect(rows[0]?.testScope?.include).toEqual([
      join(featDir, 'phases', '01-core', 'tests'),
      join(featDir, 'tests'),
      join(dir, 'saifctl', 'tests'),
    ]);
  });

  it('resolveSubtasks exits when phases/ AND subtasks.json both exist', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'conflict-f');
    await mkdir(join(featDir, 'phases', '01-core'), { recursive: true });
    await writeFile(join(featDir, 'phases', '01-core', 'spec.md'), '# spec', 'utf8');
    await writeFile(
      join(featDir, 'subtasks.json'),
      JSON.stringify([{ content: 'manual' }]),
      'utf8',
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(
        resolveSubtasks({
          subtasksFlag: undefined,
          featureAbsolutePath: featDir,
          featureName: 'conflict-f',
          saifctlDir: 'saifctl',
          gateScript: 'g',
          projectDir: dir,
        }),
      ).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });

  it('resolveSubtasks: --subtasks flag overrides feature-dir sources (escape hatch)', async () => {
    // Both phases/ AND subtasks.json present in feature dir — would normally
    // be a fatal mutual-exclusion error. --subtasks bypasses the check.
    const featDir = join(dir, 'saifctl', 'features', 'override-f');
    await mkdir(join(featDir, 'phases', '01-core'), { recursive: true });
    await writeFile(join(featDir, 'phases', '01-core', 'spec.md'), '# spec', 'utf8');
    await writeFile(
      join(featDir, 'subtasks.json'),
      JSON.stringify([{ content: 'feat-dir manifest' }]),
      'utf8',
    );

    const explicit = join(dir, 'explicit.json');
    await writeFile(
      explicit,
      JSON.stringify([{ content: 'from --subtasks flag', title: 'override' }]),
      'utf8',
    );

    const rows = await resolveSubtasks({
      subtasksFlag: explicit,
      featureAbsolutePath: featDir,
      featureName: 'override-f',
      saifctlDir: 'saifctl',
      gateScript: 'g',
      projectDir: dir,
    });
    expect(rows).toEqual([{ content: 'from --subtasks flag', title: 'override' }]);
  });

  it('resolveSubtasks exits with the compile error when phases config is invalid', async () => {
    const featDir = join(dir, 'saifctl', 'features', 'bad-phases');
    await mkdir(join(featDir, 'phases', '01-core'), { recursive: true });
    await writeFile(join(featDir, 'phases', '01-core', 'spec.md'), '# spec', 'utf8');
    // feature.yml references a critic that doesn't exist
    await writeFile(join(featDir, 'feature.yml'), `critics:\n  - { id: ghost }\n`, 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    try {
      await expect(
        resolveSubtasks({
          subtasksFlag: undefined,
          featureAbsolutePath: featDir,
          featureName: 'bad-phases',
          saifctlDir: 'saifctl',
          gateScript: 'g',
          projectDir: dir,
        }),
      ).rejects.toThrow('exit:1');
    } finally {
      exit.mockRestore();
    }
  });
});
