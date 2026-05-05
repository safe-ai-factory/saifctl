/**
 * Tests for phase / critic filesystem discovery + cross-validation.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverCritics,
  type DiscoveredCritic,
  type DiscoveredPhase,
  discoverPhases,
  effectivePhaseOrder,
  validatePhaseGraph,
} from './discover.js';

let TEST_BASE: string;

beforeEach(async () => {
  TEST_BASE = join(
    tmpdir(),
    `phases-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(TEST_BASE, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(TEST_BASE, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// discoverPhases
// ---------------------------------------------------------------------------

describe('discoverPhases', () => {
  it("returns empty when phases/ doesn't exist", async () => {
    const r = await discoverPhases(TEST_BASE);
    expect(r.phases).toEqual([]);
    expect(r.invalidIds).toEqual([]);
  });

  it('discovers valid phase dirs in lexicographic order', async () => {
    await mkdir(join(TEST_BASE, 'phases', '02-trigger'), { recursive: true });
    await mkdir(join(TEST_BASE, 'phases', '01-core'), { recursive: true });
    await mkdir(join(TEST_BASE, 'phases', 'e2e'), { recursive: true });
    const r = await discoverPhases(TEST_BASE);
    expect(r.phases.map((p) => p.id)).toEqual(['01-core', '02-trigger', 'e2e']);
  });

  it('skips files (only directories count)', async () => {
    await mkdir(join(TEST_BASE, 'phases'), { recursive: true });
    await writeFile(join(TEST_BASE, 'phases', 'NOT-A-PHASE.txt'), '');
    const r = await discoverPhases(TEST_BASE);
    expect(r.phases).toEqual([]);
  });

  it('skips _-prefixed dirs (reserved for examples)', async () => {
    await mkdir(join(TEST_BASE, 'phases', '_template'), { recursive: true });
    await mkdir(join(TEST_BASE, 'phases', '01-core'), { recursive: true });
    const r = await discoverPhases(TEST_BASE);
    expect(r.phases.map((p) => p.id)).toEqual(['01-core']);
  });

  it('flags invalid dir names (reported as errors by validatePhaseGraph)', async () => {
    await mkdir(join(TEST_BASE, 'phases', 'BadName'), { recursive: true });
    await mkdir(join(TEST_BASE, 'phases', '(routegroup)'), { recursive: true });
    await mkdir(join(TEST_BASE, 'phases', '01-core'), { recursive: true });
    const r = await discoverPhases(TEST_BASE);
    expect(r.phases.map((p) => p.id)).toEqual(['01-core']);
    expect(r.invalidIds.sort()).toEqual(['(routegroup)', 'BadName']);
  });
});

// ---------------------------------------------------------------------------
// discoverCritics
// ---------------------------------------------------------------------------

describe('discoverCritics', () => {
  it("returns empty when critics/ doesn't exist", async () => {
    const r = await discoverCritics(TEST_BASE);
    expect(r.critics).toEqual([]);
    expect(r.invalidIds).toEqual([]);
  });

  it('discovers .md files; ignores non-.md files', async () => {
    await mkdir(join(TEST_BASE, 'critics'), { recursive: true });
    await writeFile(join(TEST_BASE, 'critics', 'strict.md'), '# strict\n');
    await writeFile(join(TEST_BASE, 'critics', 'paranoid.md'), '# paranoid\n');
    await writeFile(join(TEST_BASE, 'critics', 'NOTES.txt'), 'ignored');
    const r = await discoverCritics(TEST_BASE);
    expect(r.critics.map((c) => c.id).sort()).toEqual(['paranoid', 'strict']);
  });

  it('flags invalid critic file names (bad id charset; bare id, no .md suffix)', async () => {
    await mkdir(join(TEST_BASE, 'critics'), { recursive: true });
    await writeFile(join(TEST_BASE, 'critics', 'BadName.md'), '');
    await writeFile(join(TEST_BASE, 'critics', 'good.md'), '');
    const r = await discoverCritics(TEST_BASE);
    expect(r.critics.map((c) => c.id)).toEqual(['good']);
    // Aligned with discoverPhases: bare id, no extension. Validator reformats with `.md`.
    expect(r.invalidIds).toEqual(['BadName']);
  });

  it('skips _-prefixed .md files (reserved for docs like _README.md, _template.md)', async () => {
    await mkdir(join(TEST_BASE, 'critics'), { recursive: true });
    await writeFile(join(TEST_BASE, 'critics', '_README.md'), '# notes\n');
    await writeFile(join(TEST_BASE, 'critics', '_template.md'), '');
    await writeFile(join(TEST_BASE, 'critics', 'strict.md'), '');
    const r = await discoverCritics(TEST_BASE);
    expect(r.critics.map((c) => c.id)).toEqual(['strict']);
    expect(r.invalidIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePhaseGraph
// ---------------------------------------------------------------------------

const emptyInputBase = {
  featureDir: '/fake/features/auth',
  featureConfig: null,
  phaseConfigs: new Map(),
  discoveredPhases: [] as DiscoveredPhase[],
  discoveredCritics: [] as DiscoveredCritic[],
  invalidPhaseIds: [],
  invalidCriticIds: [],
  subtasksJsonPresent: false,
};

describe('validatePhaseGraph', () => {
  it('reports no errors for an empty feature', () => {
    const r = validatePhaseGraph(emptyInputBase);
    expect(r.errors).toEqual([]);
  });

  it('prefixes every error with the feature-dir basename for multi-feature runs', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      invalidPhaseIds: ['BadName'],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^\[feature 'auth'\] /);
  });

  it('surfaces invalid phase / critic ids from discovery', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      invalidPhaseIds: ['BadName'],
      invalidCriticIds: ['BadCritic'],
    });
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/BadName/);
    // Validator reformats critic id with `.md` suffix in the message.
    expect(r.errors[1]).toMatch(/BadCritic\.md/);
  });

  it('errors when phases/ AND subtasks.json both present', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
      subtasksJsonPresent: true,
    });
    expect(r.errors.some((e) => /mutually exclusive/.test(e))).toBe(true);
  });

  it('errors when feature.yml has phases: but no phases/ dir', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { defaults: {} } },
    });
    expect(r.errors.some((e) => /no phases\/ directory exists/.test(e))).toBe(true);
  });

  it('errors when feature.yml.phases.order references unknown phase', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { order: ['01-core', '02-missing'] } },
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
    });
    expect(r.errors.some((e) => /02-missing/.test(e) && /order/.test(e))).toBe(true);
  });

  it('errors when feature.yml.phases.order omits a discovered phase (silent-drop guard)', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { order: ['01-core', '02-trigger'] } },
      discoveredPhases: [
        { id: '01-core', absolutePath: '/fake/phases/01-core' },
        { id: '02-trigger', absolutePath: '/fake/phases/02-trigger' },
        { id: '03-edge', absolutePath: '/fake/phases/03-edge' },
      ],
    });
    expect(r.errors.some((e) => /03-edge/.test(e) && /omits/.test(e))).toBe(true);
  });

  it('errors when a critic id is listed twice in the same critics list', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: {
        critics: [
          { id: 'strict', rounds: 1 },
          { id: 'strict', rounds: 2 },
        ],
      },
      discoveredCritics: [{ id: 'strict', absolutePath: '/fake/critics/strict.md' }],
    });
    expect(r.errors.some((e) => /more than once/.test(e) && /'strict'/.test(e))).toBe(true);
  });

  it('errors when feature.yml.phases.phases.<id> references unknown phase', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { phases: { 'ghost-phase': {} } } },
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
    });
    expect(r.errors.some((e) => /ghost-phase/.test(e))).toBe(true);
  });

  it('errors on critic refs (feature-level) that point to unknown ids', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { critics: [{ id: 'unknown-critic', rounds: 1 }] },
      discoveredCritics: [{ id: 'strict', absolutePath: '/fake/critics/strict.md' }],
    });
    expect(r.errors.some((e) => /unknown-critic/.test(e) && /feature\.yml\.critics/.test(e))).toBe(
      true,
    );
  });

  it('errors on critic refs in phases.defaults that point to unknown ids', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { defaults: { critics: [{ id: 'unknown', rounds: 1 }] } } },
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
      discoveredCritics: [{ id: 'strict', absolutePath: '/fake/critics/strict.md' }],
    });
    expect(r.errors.some((e) => /unknown/.test(e) && /phases\.defaults/.test(e))).toBe(true);
  });

  it('errors on critic refs in phase.yml that point to unknown ids', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      phaseConfigs: new Map([['01-core', { critics: [{ id: 'unknown', rounds: 1 }] }]]),
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
      discoveredCritics: [{ id: 'strict', absolutePath: '/fake/critics/strict.md' }],
    });
    expect(r.errors.some((e) => /unknown/.test(e) && /phase\.yml/.test(e))).toBe(true);
  });

  it("rejects tests.enforce: 'read-only' at feature level (v1 ships only diff-inspection)", () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { tests: { enforce: 'read-only' } },
    });
    expect(
      r.errors.some(
        (e) => /'read-only' is documented for v2/.test(e) && /feature\.yml\.tests\.enforce/.test(e),
      ),
    ).toBe(true);
  });

  it("rejects tests.enforce: 'read-only' in phases.defaults", () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { phases: { defaults: { tests: { enforce: 'read-only' } } } },
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
    });
    expect(
      r.errors.some((e) => /phases\.defaults\.tests\.enforce/.test(e) && /read-only/.test(e)),
    ).toBe(true);
  });

  it("rejects tests.enforce: 'read-only' in phase.yml", () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      phaseConfigs: new Map([['01-core', { tests: { enforce: 'read-only' } }]]),
      discoveredPhases: [{ id: '01-core', absolutePath: '/fake/phases/01-core' }],
    });
    expect(
      r.errors.some(
        (e) => /phases\/01-core\/phase\.yml#tests\.enforce/.test(e) && /read-only/.test(e),
      ),
    ).toBe(true);
  });

  it("accepts tests.enforce: 'diff-inspection'", () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: { tests: { enforce: 'diff-inspection' } },
    });
    expect(r.errors).toEqual([]);
  });

  it('passes when all references resolve', () => {
    const r = validatePhaseGraph({
      ...emptyInputBase,
      featureConfig: {
        critics: [{ id: 'strict', rounds: 1 }],
        phases: { order: ['01-core', '02-trigger'] },
      },
      discoveredPhases: [
        { id: '01-core', absolutePath: '/fake/phases/01-core' },
        { id: '02-trigger', absolutePath: '/fake/phases/02-trigger' },
      ],
      discoveredCritics: [{ id: 'strict', absolutePath: '/fake/critics/strict.md' }],
    });
    expect(r.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// effectivePhaseOrder
// ---------------------------------------------------------------------------

describe('effectivePhaseOrder', () => {
  it('returns lex-sorted order of discovered phases when no explicit order is given', () => {
    // Defensive re-sort: even if a future caller hands us unsorted input,
    // the fallback path is deterministic.
    const r = effectivePhaseOrder({
      featureConfig: null,
      discoveredPhases: [
        { id: '02-b', absolutePath: '/x' },
        { id: '01-a', absolutePath: '/x' },
      ],
    });
    expect(r).toEqual(['01-a', '02-b']);
  });

  it('respects feature.yml.phases.order when set (even if not lex order)', () => {
    const r = effectivePhaseOrder({
      featureConfig: { phases: { order: ['e2e', '01-core'] } },
      discoveredPhases: [
        { id: '01-core', absolutePath: '/x' },
        { id: 'e2e', absolutePath: '/x' },
      ],
    });
    expect(r).toEqual(['e2e', '01-core']);
  });

  it('falls back to discovered order (lex-sorted) when order is empty', () => {
    const r = effectivePhaseOrder({
      featureConfig: { phases: { order: [] } },
      discoveredPhases: [{ id: 'p1', absolutePath: '/x' }],
    });
    expect(r).toEqual(['p1']);
  });
});
