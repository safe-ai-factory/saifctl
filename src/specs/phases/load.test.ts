/**
 * Tests for file loading + extension precedence + inheritance resolution.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILT_IN_DEFAULTS,
  loadFeatureConfig,
  loadPhaseConfig,
  MultipleConfigVariantsError,
  PhaseConfigParseError,
  resolvePhaseConfig,
} from './load.js';

let TEST_BASE: string;

beforeEach(async () => {
  TEST_BASE = join(tmpdir(), `phases-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// loadFeatureConfig
// ---------------------------------------------------------------------------

describe('loadFeatureConfig', () => {
  it('returns null when no feature.* file exists', async () => {
    const r = await loadFeatureConfig(TEST_BASE);
    expect(r).toBeNull();
  });

  it('loads feature.yml', async () => {
    await writeFile(join(TEST_BASE, 'feature.yml'), 'critics: [{id: strict}]\n', 'utf8');
    const r = await loadFeatureConfig(TEST_BASE);
    expect(r?.config.critics).toEqual([{ id: 'strict', rounds: 1 }]);
    expect(r?.filepath).toBe(join(TEST_BASE, 'feature.yml'));
  });

  it('loads feature.yaml', async () => {
    await writeFile(join(TEST_BASE, 'feature.yaml'), 'critics: [{id: strict}]\n', 'utf8');
    const r = await loadFeatureConfig(TEST_BASE);
    expect(r?.config.critics).toEqual([{ id: 'strict', rounds: 1 }]);
  });

  it('loads feature.json', async () => {
    await writeFile(
      join(TEST_BASE, 'feature.json'),
      JSON.stringify({ critics: [{ id: 'strict' }] }),
      'utf8',
    );
    const r = await loadFeatureConfig(TEST_BASE);
    expect(r?.config.critics).toEqual([{ id: 'strict', rounds: 1 }]);
  });

  it('errors when multiple feature.* variants exist', async () => {
    await writeFile(join(TEST_BASE, 'feature.yml'), 'critics: []\n', 'utf8');
    await writeFile(join(TEST_BASE, 'feature.yaml'), 'critics: []\n', 'utf8');
    await expect(loadFeatureConfig(TEST_BASE)).rejects.toThrow(MultipleConfigVariantsError);
  });

  it('throws PhaseConfigParseError on invalid schema', async () => {
    await writeFile(join(TEST_BASE, 'feature.yml'), 'critics: [{id: "BAD ID"}]\n', 'utf8');
    await expect(loadFeatureConfig(TEST_BASE)).rejects.toThrow(PhaseConfigParseError);
  });

  it('throws PhaseConfigParseError on unknown top-level key', async () => {
    await writeFile(join(TEST_BASE, 'feature.yml'), 'rogue: true\n', 'utf8');
    await expect(loadFeatureConfig(TEST_BASE)).rejects.toThrow(PhaseConfigParseError);
  });
});

// ---------------------------------------------------------------------------
// loadPhaseConfig
// ---------------------------------------------------------------------------

describe('loadPhaseConfig', () => {
  it('returns null when no phase.* file exists', async () => {
    const r = await loadPhaseConfig(TEST_BASE);
    expect(r).toBeNull();
  });

  it('loads phase.yml', async () => {
    await writeFile(join(TEST_BASE, 'phase.yml'), 'critics: [{id: paranoid, rounds: 2}]\n', 'utf8');
    const r = await loadPhaseConfig(TEST_BASE);
    expect(r?.config.critics).toEqual([{ id: 'paranoid', rounds: 2 }]);
  });

  it('errors on multiple variants', async () => {
    await writeFile(join(TEST_BASE, 'phase.yml'), '{}\n', 'utf8');
    await writeFile(join(TEST_BASE, 'phase.json'), '{}\n', 'utf8');
    await expect(loadPhaseConfig(TEST_BASE)).rejects.toThrow(MultipleConfigVariantsError);
  });

  it('throws on invalid schema', async () => {
    // Unknown key trips strict() — schema-time rejection.
    await writeFile(join(TEST_BASE, 'phase.yml'), 'rogue: 1\n', 'utf8');
    await expect(loadPhaseConfig(TEST_BASE)).rejects.toThrow(PhaseConfigParseError);
  });

  it("loads tests.enforce: 'read-only' without throwing (validator handles rejection)", async () => {
    // Ensures the schema layer parses 'read-only' for future-proofing.
    // validatePhaseGraph in discover.ts is responsible for the v1 rejection.
    await writeFile(join(TEST_BASE, 'phase.yml'), 'tests:\n  enforce: read-only\n', 'utf8');
    const r = await loadPhaseConfig(TEST_BASE);
    expect(r?.config.tests?.enforce).toBe('read-only');
  });
});

// ---------------------------------------------------------------------------
// resolvePhaseConfig — inheritance
// ---------------------------------------------------------------------------

describe('resolvePhaseConfig — inheritance', () => {
  it('returns built-in defaults when both inputs are null (strict baseline ⇒ immutable)', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: null,
    });
    expect(r.spec).toBe('spec.md');
    expect(r.critics).toBeNull(); // null sentinel = "run all critics"
    expect(r.tests).toEqual({
      // Strict default (projectDefaultStrict omitted ⇒ true) ⇒ default-immutable.
      mutable: false,
      fail2pass: BUILT_IN_DEFAULTS.testsFail2pass,
      enforce: BUILT_IN_DEFAULTS.testsEnforce,
      immutableFiles: BUILT_IN_DEFAULTS.testsImmutableFiles,
    });
  });

  it('projectDefaultStrict: false flips the unset-mutable floor to mutable', () => {
    // Regression for the "--no-strict silently ignored for phase tests" bug:
    // when no `mutable:` declaration walks up the chain, the project default
    // (which CLI `--no-strict` flips to false) MUST drive the resolved value.
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: null,
      projectDefaultStrict: false,
    });
    expect(r.tests.mutable).toBe(true);
    // mutable=true auto-flips fail2pass=false unless explicit (§9).
    expect(r.tests.fail2pass).toBe(false);
  });

  it('projectDefaultStrict does NOT override an explicit mutable: false declaration', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { tests: { mutable: false } },
      featureConfig: null,
      projectDefaultStrict: false, // --no-strict
    });
    expect(r.tests.mutable).toBe(false);
  });

  it('phase.yml overrides feature.yml.phases.defaults', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { critics: [{ id: 'paranoid', rounds: 3 }] },
      featureConfig: {
        phases: {
          defaults: { critics: [{ id: 'strict', rounds: 1 }] },
        },
      },
    });
    expect(r.critics).toEqual([{ id: 'paranoid', rounds: 3 }]);
  });

  it('inline phase config (feature.yml.phases.phases.<id>) overrides defaults', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: {
        phases: {
          defaults: { critics: [{ id: 'strict', rounds: 1 }] },
          phases: { p1: { critics: [{ id: 'security', rounds: 1 }] } },
        },
      },
    });
    expect(r.critics).toEqual([{ id: 'security', rounds: 1 }]);
  });

  it('phase.yml beats inline phase config', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { critics: [{ id: 'paranoid', rounds: 2 }] },
      featureConfig: {
        phases: {
          phases: { p1: { critics: [{ id: 'security', rounds: 1 }] } },
        },
      },
    });
    expect(r.critics).toEqual([{ id: 'paranoid', rounds: 2 }]);
  });

  it('feature.yml top-level critics is fallback when phases scope is silent', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: {
        critics: [{ id: 'top-level', rounds: 1 }],
      },
    });
    expect(r.critics).toEqual([{ id: 'top-level', rounds: 1 }]);
  });

  it('explicit critics: [] overrides "run all" sentinel', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { critics: [] },
      featureConfig: { critics: [{ id: 'strict', rounds: 1 }] },
    });
    expect(r.critics).toEqual([]);
  });

  it('no critics anywhere ⇒ null sentinel ("run all")', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: { tests: { mutable: false } },
    });
    expect(r.critics).toBeNull();
  });

  it('spec defaults to spec.md when neither layer sets it', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: null,
    });
    expect(r.spec).toBe('spec.md');
  });

  it('spec from phase.yml wins over inline phase config', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { spec: 'custom-from-phase-yml.md' },
      featureConfig: {
        phases: { phases: { p1: { spec: 'custom-from-inline.md' } } },
      },
    });
    expect(r.spec).toBe('custom-from-phase-yml.md');
  });

  it('spec inherits from phases.defaults when neither phase.yml nor inline sets it', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: {
        phases: { defaults: { spec: 'SPEC.md' } },
      },
    });
    expect(r.spec).toBe('SPEC.md');
  });

  it('spec from inline phase config beats phases.defaults', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: null,
      featureConfig: {
        phases: {
          defaults: { spec: 'SPEC.md' },
          phases: { p1: { spec: 'custom-from-inline.md' } },
        },
      },
    });
    expect(r.spec).toBe('custom-from-inline.md');
  });

  it('tests sub-keys resolve independently across layers', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { tests: { mutable: true } },
      featureConfig: {
        phases: {
          defaults: { tests: { 'immutable-files': ['tests/contract.ts'] } },
        },
      },
    });
    expect(r.tests.mutable).toBe(true);
    expect(r.tests.immutableFiles).toEqual(['tests/contract.ts']);
  });

  it('mutable=true auto-flips fail2pass to false unless explicitly set', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { tests: { mutable: true } },
      featureConfig: null,
    });
    expect(r.tests.mutable).toBe(true);
    expect(r.tests.fail2pass).toBe(false);
  });

  it('mutable=true with explicit fail2pass:true keeps fail2pass true', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { tests: { mutable: true, fail2pass: true } },
      featureConfig: null,
    });
    expect(r.tests.fail2pass).toBe(true);
  });

  it('list-valued immutable-files: phase.yml replaces inherited list (no merge)', () => {
    const r = resolvePhaseConfig({
      phaseId: 'p1',
      phaseConfig: { tests: { 'immutable-files': ['phase-only.ts'] } },
      featureConfig: {
        phases: {
          defaults: { tests: { 'immutable-files': ['feat-default.ts'] } },
        },
      },
    });
    expect(r.tests.immutableFiles).toEqual(['phase-only.ts']);
  });
});
