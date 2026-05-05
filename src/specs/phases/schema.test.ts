/**
 * Unit tests for feature.yml / phase.yml Zod schemas.
 */

import { describe, expect, it } from 'vitest';

import {
  criticEntrySchema,
  featureConfigSchema,
  phaseConfigSchema,
  testsConfigSchema,
} from './schema.js';

describe('criticEntrySchema', () => {
  it('accepts {id, rounds}', () => {
    const r = criticEntrySchema.parse({ id: 'strict', rounds: 2 });
    expect(r).toEqual({ id: 'strict', rounds: 2 });
  });

  it('defaults rounds to 1 when omitted', () => {
    const r = criticEntrySchema.parse({ id: 'paranoid' });
    expect(r.rounds).toBe(1);
  });

  it('rejects rounds < 1', () => {
    expect(() => criticEntrySchema.parse({ id: 'x', rounds: 0 })).toThrow();
    expect(() => criticEntrySchema.parse({ id: 'x', rounds: -1 })).toThrow();
  });

  it('rejects non-integer rounds', () => {
    expect(() => criticEntrySchema.parse({ id: 'x', rounds: 1.5 })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => criticEntrySchema.parse({ id: 'x', extra: true })).toThrow();
  });

  it('rejects invalid id charset', () => {
    expect(() => criticEntrySchema.parse({ id: 'Strict' })).toThrow(/match/);
    expect(() => criticEntrySchema.parse({ id: 'with space' })).toThrow();
    expect(() => criticEntrySchema.parse({ id: '-leading' })).toThrow();
  });
});

describe('testsConfigSchema', () => {
  it('accepts the empty object (all keys optional)', () => {
    expect(testsConfigSchema.parse({})).toEqual({});
  });

  it('accepts mutable / fail2pass / immutable-files', () => {
    const r = testsConfigSchema.parse({
      mutable: true,
      fail2pass: false,
      'immutable-files': ['tests/contract.ts', 'tests/api/**'],
    });
    expect(r.mutable).toBe(true);
    expect(r.fail2pass).toBe(false);
    expect(r['immutable-files']).toEqual(['tests/contract.ts', 'tests/api/**']);
  });

  it("accepts enforce: 'diff-inspection'", () => {
    expect(testsConfigSchema.parse({ enforce: 'diff-inspection' }).enforce).toBe('diff-inspection');
  });

  it("accepts enforce: 'read-only' at the schema layer (validator rejects in v1)", () => {
    // Parses successfully so users can future-proof their config files.
    // validatePhaseGraph (discover.ts) rejects 'read-only' as not implemented.
    expect(testsConfigSchema.parse({ enforce: 'read-only' }).enforce).toBe('read-only');
  });

  it('rejects enforce values outside the enum', () => {
    expect(() => testsConfigSchema.parse({ enforce: 'something-else' })).toThrow();
  });

  it('rejects immutable-files globs with `..` segments', () => {
    expect(() => testsConfigSchema.parse({ 'immutable-files': ['../escape'] })).toThrow();
  });

  it('rejects immutable-files globs that are absolute paths', () => {
    expect(() => testsConfigSchema.parse({ 'immutable-files': ['/abs/path'] })).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => testsConfigSchema.parse({ mutable: true, extra: 1 })).toThrow();
  });
});

describe('phaseConfigSchema', () => {
  it('accepts the empty object', () => {
    expect(phaseConfigSchema.parse({})).toEqual({});
  });

  it('accepts critics + spec + tests', () => {
    const r = phaseConfigSchema.parse({
      critics: [{ id: 'paranoid', rounds: 2 }],
      spec: 'spec.md',
      tests: { mutable: true },
    });
    expect(r.critics).toEqual([{ id: 'paranoid', rounds: 2 }]);
    expect(r.spec).toBe('spec.md');
    expect(r.tests?.mutable).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(() => phaseConfigSchema.parse({ foo: 'bar' })).toThrow();
  });

  it("rejects spec paths containing '..' segments", () => {
    expect(() => phaseConfigSchema.parse({ spec: '../sibling/spec.md' })).toThrow(
      /relative to the phase dir/,
    );
  });

  it('rejects absolute spec paths', () => {
    expect(() => phaseConfigSchema.parse({ spec: '/etc/passwd' })).toThrow(
      /relative to the phase dir/,
    );
  });

  it('accepts plain relative spec filenames and subpaths', () => {
    expect(phaseConfigSchema.parse({ spec: 'spec.md' }).spec).toBe('spec.md');
    expect(phaseConfigSchema.parse({ spec: 'docs/spec.md' }).spec).toBe('docs/spec.md');
  });
});

describe('featureConfigSchema', () => {
  it('accepts the empty object', () => {
    expect(featureConfigSchema.parse({})).toEqual({});
  });

  it('accepts the full feature.yml shape from the doc', () => {
    const r = featureConfigSchema.parse({
      critics: [
        { id: 'strict', rounds: 1 },
        { id: 'paranoid', rounds: 1 },
      ],
      tests: { mutable: false, 'immutable-files': [] },
      phases: {
        order: ['01-core', '02-trigger', 'e2e'],
        defaults: {
          critics: [{ id: 'strict', rounds: 1 }],
          tests: { mutable: false, fail2pass: true },
        },
        phases: {
          '01-core': {},
          '02-trigger': { critics: [{ id: 'paranoid', rounds: 2 }] },
        },
      },
    });
    expect(r.phases?.order).toEqual(['01-core', '02-trigger', 'e2e']);
    expect(r.phases?.phases?.['02-trigger']?.critics?.[0]?.id).toBe('paranoid');
  });

  it("rejects phase ids starting with '(' (route-group reserved)", () => {
    expect(() => featureConfigSchema.parse({ phases: { order: ['(auth)'] } })).toThrow(
      /Next\.js-style route groups/,
    );
  });

  it('rejects invalid phase id charset in order', () => {
    expect(() => featureConfigSchema.parse({ phases: { order: ['Phase1'] } })).toThrow(/match/);
  });

  it('rejects invalid phase id keys in inline phases map', () => {
    expect(() => featureConfigSchema.parse({ phases: { phases: { 'BAD ID': {} } } })).toThrow();
  });

  it('rejects unknown top-level keys', () => {
    expect(() => featureConfigSchema.parse({ random: 'x' })).toThrow();
  });

  it('rejects unknown keys inside phases block', () => {
    expect(() => featureConfigSchema.parse({ phases: { random: 'x' } })).toThrow();
  });
});
