/**
 * Tests for the phase → subtasks compiler (Block 3 of TODO_phases_and_critics).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compilePhasesToSubtasks, PhaseCompileError } from './compile.js';

let projectDir: string;
let featureDir: string;

const FEATURE_NAME = 'auth';
const SAIFCTL_DIR = 'saifctl';

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'compile-block3-'));
  featureDir = join(projectDir, SAIFCTL_DIR, 'features', FEATURE_NAME);
  await mkdir(featureDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function makePhase(
  id: string,
  opts: { spec?: string; tests?: boolean } = {},
): Promise<string> {
  const phaseDir = join(featureDir, 'phases', id);
  await mkdir(phaseDir, { recursive: true });
  await writeFile(join(phaseDir, opts.spec ?? 'spec.md'), `# ${id} spec`, 'utf8');
  if (opts.tests !== false) {
    await mkdir(join(phaseDir, 'tests'), { recursive: true });
  }
  return phaseDir;
}

async function makeCritic(id: string, body: string): Promise<string> {
  const dir = join(featureDir, 'critics');
  await mkdir(dir, { recursive: true });
  const p = join(dir, `${id}.md`);
  await writeFile(p, body, 'utf8');
  return p;
}

async function compile(): Promise<ReturnType<typeof compilePhasesToSubtasks>> {
  return compilePhasesToSubtasks({
    featureAbsolutePath: featureDir,
    featureName: FEATURE_NAME,
    saifctlDir: SAIFCTL_DIR,
    projectDir,
    gateScript: '#!/bin/sh\nexit 0',
  });
}

describe('compilePhasesToSubtasks — basic shape', () => {
  it('emits one implementer subtask per phase in lexicographic order when no critics defined', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    const out = await compile();
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe('phase:01-core impl');
    expect(out[1]?.title).toBe('phase:02-trigger impl');
  });

  it('respects feature.yml.phases.order over lexicographic', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `phases:\n  order: [02-trigger, 01-core]\n`,
      'utf8',
    );

    const out = await compile();
    expect(out.map((s) => s.title)).toEqual(['phase:02-trigger impl', 'phase:01-core impl']);
  });

  it('threads gateScript onto every emitted subtask', async () => {
    await makePhase('01-core');
    const out = await compile();
    expect(out[0]?.gateScript).toBe('#!/bin/sh\nexit 0');
  });
});

describe('compilePhasesToSubtasks — critics', () => {
  it('emits two critic subtasks (discover + fix) per phase per critic per round (§6 split)', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');
    await makeCritic('strict', 'be strict');
    await makeCritic('paranoid', 'be paranoid');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `critics:\n  - { id: strict, rounds: 1 }\n  - { id: paranoid, rounds: 2 }\n`,
      'utf8',
    );

    const out = await compile();
    // 2 phases × (1 impl + 2*(1 strict round + 2 paranoid rounds)) = 14
    // discover + fix per round = 2 subtasks each
    expect(out).toHaveLength(14);
    expect(out.map((s) => s.title)).toEqual([
      'phase:01-core impl',
      'phase:01-core critic:strict round:1/1 discover',
      'phase:01-core critic:strict round:1/1 fix',
      'phase:01-core critic:paranoid round:1/2 discover',
      'phase:01-core critic:paranoid round:1/2 fix',
      'phase:01-core critic:paranoid round:2/2 discover',
      'phase:01-core critic:paranoid round:2/2 fix',
      'phase:02-trigger impl',
      'phase:02-trigger critic:strict round:1/1 discover',
      'phase:02-trigger critic:strict round:1/1 fix',
      'phase:02-trigger critic:paranoid round:1/2 discover',
      'phase:02-trigger critic:paranoid round:1/2 fix',
      'phase:02-trigger critic:paranoid round:2/2 discover',
      'phase:02-trigger critic:paranoid round:2/2 fix',
    ]);
  });

  it('per-phase phase.yml replaces the inherited critic list (no key-level merge)', async () => {
    await makePhase('01-core');
    await makePhase('02-edge');
    await makeCritic('strict', 'strict');
    await makeCritic('paranoid', 'paranoid');
    await makeCritic('security', 'security');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `critics:\n  - { id: strict }\n  - { id: paranoid }\n`,
      'utf8',
    );
    await writeFile(
      join(featureDir, 'phases', '02-edge', 'phase.yml'),
      `critics:\n  - { id: security }\n`,
      'utf8',
    );

    const out = await compile();
    const phase02CriticTitles = out
      .filter((s) => s.title?.startsWith('phase:02-edge'))
      .map((s) => s.title);
    expect(phase02CriticTitles).toEqual([
      'phase:02-edge impl',
      'phase:02-edge critic:security round:1/1 discover',
      'phase:02-edge critic:security round:1/1 fix',
    ]);
  });

  it('phase with explicit empty critics list runs no critics', async () => {
    await makePhase('00-spike');
    await makePhase('01-core');
    await makeCritic('strict', 'strict');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');
    await writeFile(join(featureDir, 'phases', '00-spike', 'phase.yml'), `critics: []\n`, 'utf8');

    const out = await compile();
    expect(out.filter((s) => s.title?.startsWith('phase:00-spike'))).toHaveLength(1);
    // 01-core: 1 impl + 1 strict round × 2 (discover+fix) = 3
    expect(out.filter((s) => s.title?.startsWith('phase:01-core'))).toHaveLength(3);
  });

  it('runs all discovered critics alphabetically when no critic list declared anywhere', async () => {
    await makePhase('01-core');
    // Note: written in non-alphabetical order to verify sort.
    await makeCritic('strict', 'strict');
    await makeCritic('paranoid', 'paranoid');

    const out = await compile();
    expect(out.map((s) => s.title)).toEqual([
      'phase:01-core impl',
      'phase:01-core critic:paranoid round:1/1 discover',
      'phase:01-core critic:paranoid round:1/1 fix',
      'phase:01-core critic:strict round:1/1 discover',
      'phase:01-core critic:strict round:1/1 fix',
    ]);
  });

  it('discover subtask content is the raw user template (loop renders via mustache at runtime)', async () => {
    await makePhase('01-core');
    await makeCritic('strict', 'AUDIT_BODY_TOKEN — phase {{phase.id}} round {{critic.round}}');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');

    const out = await compile();
    const discover = out.find((s) => s.title === 'phase:01-core critic:strict round:1/1 discover');
    // Raw body — mustache tokens are still literals here. Block 4's loop
    // renderer expands them just before invoking the agent.
    expect(discover?.content).toBe('AUDIT_BODY_TOKEN — phase {{phase.id}} round {{critic.round}}');
  });

  it('fix subtask content is the saifctl-owned BUILTIN_FIX_TEMPLATE (not the user critic body)', async () => {
    await makePhase('01-core');
    await makeCritic('strict', 'USER_TEMPLATE_TOKEN — phase {{phase.id}}');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');

    const out = await compile();
    const fix = out.find((s) => s.title === 'phase:01-core critic:strict round:1/1 fix');
    // The user template token must NOT appear in the fix subtask — fix uses
    // the saifctl-owned built-in template.
    expect(fix?.content).not.toContain('USER_TEMPLATE_TOKEN');
    // Built-in template references the findings file path it should read.
    expect(fix?.content).toContain('{{critic.findingsPath}}');
    expect(fix?.content).toContain('{{phase.id}}');
  });

  it('critic subtasks carry criticPrompt metadata with step + findingsPath', async () => {
    await makePhase('01-core');
    await makeCritic('paranoid', 'body');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `critics:\n  - { id: paranoid, rounds: 2 }\n`,
      'utf8',
    );

    const out = await compile();
    const r1d = out.find((s) => s.title === 'phase:01-core critic:paranoid round:1/2 discover');
    const r1f = out.find((s) => s.title === 'phase:01-core critic:paranoid round:1/2 fix');
    const r2d = out.find((s) => s.title === 'phase:01-core critic:paranoid round:2/2 discover');

    expect(r1d?.phaseId).toBe('01-core');
    expect(r1d?.criticPrompt?.criticId).toBe('paranoid');
    expect(r1d?.criticPrompt?.round).toBe(1);
    expect(r1d?.criticPrompt?.totalRounds).toBe(2);
    expect(r1d?.criticPrompt?.step).toBe('discover');
    expect(r1f?.criticPrompt?.step).toBe('fix');
    expect(r2d?.criticPrompt?.round).toBe(2);

    // discover and fix from the same round share the same findingsPath
    // (so fix can read what discover wrote). Different rounds have
    // different paths so re-runs don't collide.
    expect(r1d?.criticPrompt?.findingsPath).toBe(
      '/workspace/.saifctl/critic-findings/01-core--paranoid--r1.md',
    );
    expect(r1f?.criticPrompt?.findingsPath).toBe(r1d?.criticPrompt?.findingsPath);
    expect(r2d?.criticPrompt?.findingsPath).toBe(
      '/workspace/.saifctl/critic-findings/01-core--paranoid--r2.md',
    );
    expect(r2d?.criticPrompt?.findingsPath).not.toBe(r1d?.criticPrompt?.findingsPath);

    // Pre-bound mustache vars (everything except phase.baseRef, which is
    // a runtime concern captured by the loop).
    expect(r1d?.criticPrompt?.vars.feature.name).toBe(FEATURE_NAME);
    expect(r1d?.criticPrompt?.vars.feature.dir).toBe(`${SAIFCTL_DIR}/features/${FEATURE_NAME}`);
    expect(r1d?.criticPrompt?.vars.feature.plan).toBe(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/plan.md`,
    );
    expect(r1d?.criticPrompt?.vars.phase.id).toBe('01-core');
    expect(r1d?.criticPrompt?.vars.phase.spec).toBe(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/phases/01-core/spec.md`,
    );
    expect(r1d?.criticPrompt?.vars.phase.tests).toBe(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/phases/01-core/tests`,
    );
  });

  it('discover and fix in the same round share testScope (both gate on phase tests)', async () => {
    await makePhase('01-core');
    await makeCritic('strict', 'strict');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');

    const out = await compile();
    const discover = out.find((s) => s.title === 'phase:01-core critic:strict round:1/1 discover');
    const fix = out.find((s) => s.title === 'phase:01-core critic:strict round:1/1 fix');
    // Both gate on the same cumulative test set as the impl that wrote the code.
    expect(discover?.testScope).toEqual(fix?.testScope);
  });

  it('impl subtask carries phaseId but no criticPrompt', async () => {
    await makePhase('01-core');
    const out = await compile();
    const impl = out[0]!;
    expect(impl.phaseId).toBe('01-core');
    expect(impl.criticPrompt).toBeUndefined();
  });
});

describe('compilePhasesToSubtasks — testScope (cumulative gate)', () => {
  it('every subtask emits cumulative=true with its own phase tests dir', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');
    await makeCritic('strict', 'strict');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');

    const out = await compile();
    for (const s of out) {
      expect(s.testScope?.cumulative).toBe(true);
      expect(s.testScope?.include?.[0]).toMatch(/phases\/(01-core|02-trigger)\/tests$/);
    }
  });

  it('phase 1 testScope includes only its own phase tests dir', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');

    const out = await compile();
    const phase1 = out.find((s) => s.title === 'phase:01-core impl');
    expect(phase1?.testScope?.include).toEqual([join(featureDir, 'phases', '01-core', 'tests')]);
  });

  it('LAST phase additionally includes <feature>/tests/ and <saifctlDir>/tests/', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger'); // last

    const out = await compile();
    const lastImpl = out.find((s) => s.title === 'phase:02-trigger impl');
    expect(lastImpl?.testScope?.include).toEqual([
      join(featureDir, 'phases', '02-trigger', 'tests'),
      join(featureDir, 'tests'),
      join(projectDir, SAIFCTL_DIR, 'tests'),
    ]);
  });

  it('LAST phase critics share the same expanded testScope as the last impl', async () => {
    await makePhase('01-core');
    await makePhase('02-trigger');
    await makeCritic('strict', 'strict');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');

    const out = await compile();
    const lastImpl = out.find((s) => s.title === 'phase:02-trigger impl');
    const lastDiscover = out.find(
      (s) => s.title === 'phase:02-trigger critic:strict round:1/1 discover',
    );
    const lastFix = out.find((s) => s.title === 'phase:02-trigger critic:strict round:1/1 fix');
    expect(lastDiscover?.testScope?.include).toEqual(lastImpl?.testScope?.include);
    expect(lastFix?.testScope?.include).toEqual(lastImpl?.testScope?.include);
  });
});

describe('compilePhasesToSubtasks — implementer prompt', () => {
  it('links to spec + plan, mentions phase id, warns about saifctl/', async () => {
    await makePhase('01-core');
    const out = await compile();
    const impl = out[0]!;
    expect(impl.content).toContain("phase '01-core'");
    expect(impl.content).toContain(`feature '${FEATURE_NAME}'`);
    expect(impl.content).toContain(`spec.md`);
    expect(impl.content).toContain(`plan.md`);
    expect(impl.content).toContain(`/${SAIFCTL_DIR}/`);
    // link-only — must not embed plan / spec contents
    expect(impl.content).not.toContain('# 01-core spec');
  });

  it('emits container-side workspace paths for plan / spec, not host-absolute paths', async () => {
    await makePhase('01-core');
    const out = await compile();
    const impl = out[0]!;
    // Container-visible paths under /workspace/...
    expect(impl.content).toContain(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/phases/01-core/spec.md`,
    );
    expect(impl.content).toContain(`/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/plan.md`);
    // The host-absolute prefix (the temp project dir) must not appear — that
    // path doesn't exist in the agent's container.
    expect(impl.content).not.toContain(projectDir);
  });

  it('uses phase.yml.spec override for the spec link', async () => {
    await makePhase('01-core', { spec: 'SPEC.md' });
    await writeFile(join(featureDir, 'phases', '01-core', 'phase.yml'), `spec: SPEC.md\n`, 'utf8');
    const out = await compile();
    expect(out[0]?.content).toContain('SPEC.md');
    expect(out[0]?.content).not.toMatch(/\bspec\.md\b/);
  });

  it('critic prompt vars use workspace-relative paths, not host-absolute', async () => {
    await makePhase('01-core');
    await makeCritic('strict', 'BODY');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: strict }\n`, 'utf8');
    const out = await compile();
    const critic = out.find((s) => s.title === 'phase:01-core critic:strict round:1/1 discover');
    // Paths live on criticPrompt.vars now (Block 4); content is the raw body.
    expect(critic?.criticPrompt?.vars.phase.spec).toBe(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/phases/01-core/spec.md`,
    );
    expect(critic?.criticPrompt?.vars.feature.plan).toBe(
      `/workspace/${SAIFCTL_DIR}/features/${FEATURE_NAME}/plan.md`,
    );
    // Prompt-facing fields (content + criticPrompt.vars) must be free of
    // host-absolute paths. testScope.include is host-side by design and is
    // not surfaced to the agent.
    expect(critic?.content).not.toContain(projectDir);
    expect(JSON.stringify(critic?.criticPrompt?.vars)).not.toContain(projectDir);
  });
});

describe('compilePhasesToSubtasks — error paths', () => {
  it('throws PhaseCompileError when phases/ has no valid phase dirs', async () => {
    await mkdir(join(featureDir, 'phases'), { recursive: true });
    await expect(compile()).rejects.toBeInstanceOf(PhaseCompileError);
  });

  it('throws PhaseCompileError when feature.yml references unknown critic', async () => {
    await makePhase('01-core');
    await writeFile(join(featureDir, 'feature.yml'), `critics:\n  - { id: ghost }\n`, 'utf8');
    await expect(compile()).rejects.toMatchObject({
      name: 'PhaseCompileError',
      message: expect.stringContaining("unknown critic 'ghost'"),
    });
  });

  it('throws PhaseCompileError when feature.yml.phases.order references unknown phase', async () => {
    await makePhase('01-core');
    await writeFile(
      join(featureDir, 'feature.yml'),
      `phases:\n  order: [01-core, 99-ghost]\n`,
      'utf8',
    );
    await expect(compile()).rejects.toMatchObject({
      name: 'PhaseCompileError',
      message: expect.stringContaining("unknown phase '99-ghost'"),
    });
  });

  it('throws PhaseCompileError when tests.enforce: read-only is set anywhere', async () => {
    await makePhase('01-core');
    await writeFile(join(featureDir, 'feature.yml'), `tests:\n  enforce: read-only\n`, 'utf8');
    await expect(compile()).rejects.toMatchObject({
      name: 'PhaseCompileError',
      message: expect.stringContaining('read-only'),
    });
  });
});
