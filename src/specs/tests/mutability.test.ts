/**
 * Tests for {@link classifyTestPaths} (Block 7 — three-layer model from §5.6).
 *
 * The classifier is the load-bearing piece for diff-inspection enforcement:
 * any file marked `mutable: false` here will fail the gate when modified.
 * These tests lock the §5.6 contract precisely so a future refactor can't
 * silently relax mutability somewhere downstream.
 */

import { describe, expect, it } from 'vitest';

import type { FeatureConfig, PhaseConfig } from '../phases/schema.js';
import {
  classifyTestPaths,
  findUnusedImmutableFileGlobs,
  toProjectRelativePosix,
} from './mutability.js';

const FEATURE_REL = 'saifctl/features/auth';
const SAIFCTL = 'saifctl';

function classify(opts: {
  paths: string[];
  featureConfig?: FeatureConfig | null;
  phaseConfigs?: ReadonlyMap<string, PhaseConfig | null>;
  projectDefaultStrict?: boolean;
}) {
  return classifyTestPaths({
    paths: opts.paths,
    saifctlDir: SAIFCTL,
    featureRelativePath: FEATURE_REL,
    featureConfig: opts.featureConfig ?? null,
    phaseConfigs: opts.phaseConfigs ?? new Map(),
    projectDefaultStrict: opts.projectDefaultStrict ?? true,
  });
}

describe('classifyTestPaths', () => {
  describe('layer 1: saifctl/tests/** is always immutable', () => {
    it('marks anything under saifctl/tests/ immutable, even with --no-strict', () => {
      const out = classify({
        paths: ['saifctl/tests/contract.spec.ts', 'saifctl/tests/sub/dir/x.spec.ts'],
        projectDefaultStrict: false,
      });
      for (const r of out) {
        expect(r.mutable).toBe(false);
        expect(r.layer).toBe('project');
        expect(r.reason).toContain('always immutable');
      }
    });

    it('the always-immutable rule survives a feature.yml that tries to flip it', () => {
      // §9 explicitly forbids overriding the saifctl/tests/ rule. Even if a
      // future user nests `tests.mutable: true` somewhere they thought
      // would help, the project-level path stays immutable.
      const out = classify({
        paths: ['saifctl/tests/contract.spec.ts'],
        featureConfig: { tests: { mutable: true } },
        projectDefaultStrict: false,
      });
      expect(out[0]?.mutable).toBe(false);
      expect(out[0]?.layer).toBe('project');
    });
  });

  describe('layer 3: feature-level tests', () => {
    it('default strict ⇒ feature tests immutable', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/tests/login.spec.ts`],
        projectDefaultStrict: true,
      });
      expect(out[0]?.mutable).toBe(false);
      expect(out[0]?.layer).toBe('feature');
      expect(out[0]?.reason).toMatch(/immutable/);
    });

    it('--no-strict (projectDefaultStrict=false) ⇒ feature tests mutable', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/tests/login.spec.ts`],
        projectDefaultStrict: false,
      });
      expect(out[0]?.mutable).toBe(true);
      expect(out[0]?.layer).toBe('feature');
    });

    it('feature.yml tests.mutable: true overrides strict default', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/tests/login.spec.ts`],
        featureConfig: { tests: { mutable: true } },
        projectDefaultStrict: true,
      });
      expect(out[0]?.mutable).toBe(true);
    });

    it('feature.yml tests.mutable: false overrides --no-strict', () => {
      // Explicit per-scope decision wins over the global flip; the feature
      // owner gets the final say within their dir.
      const out = classify({
        paths: [`${FEATURE_REL}/tests/login.spec.ts`],
        featureConfig: { tests: { mutable: false } },
        projectDefaultStrict: false,
      });
      expect(out[0]?.mutable).toBe(false);
    });
  });

  describe('layer 2: phase-level tests', () => {
    it('inherits feature-level mutable=true', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/x.spec.ts`],
        featureConfig: { tests: { mutable: true } },
      });
      expect(out[0]?.mutable).toBe(true);
      expect(out[0]?.layer).toBe('phase');
      expect(out[0]?.reason).toContain("'01-core'");
    });

    it('phase.yml tests.mutable: false beats feature-level mutable: true', () => {
      // Most-specific-wins per §5.3.
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/x.spec.ts`],
        featureConfig: { tests: { mutable: true } },
        phaseConfigs: new Map<string, PhaseConfig | null>([
          ['01-core', { tests: { mutable: false } }],
        ]),
      });
      expect(out[0]?.mutable).toBe(false);
    });

    it('feature.yml.phases.defaults.tests.mutable applies when phase.yml is silent', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/x.spec.ts`],
        featureConfig: { phases: { defaults: { tests: { mutable: true } } } },
        phaseConfigs: new Map<string, PhaseConfig | null>([['01-core', null]]),
      });
      expect(out[0]?.mutable).toBe(true);
      expect(out[0]?.layer).toBe('phase');
    });

    it('--no-strict (projectDefaultStrict=false) ⇒ phase tests mutable when no declarations exist', () => {
      // Regression: phase-level was previously hard-defaulted to immutable
      // because `BUILT_IN_DEFAULTS.testsMutable: false` collapsed the
      // inheritance chain inside `resolveTests`, so `--no-strict` was a no-op
      // for phase paths even though it flipped feature-level paths. §5.6 is
      // explicit that the project default applies when nothing in the chain
      // declares `mutable`.
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/x.spec.ts`],
        featureConfig: null,
        phaseConfigs: new Map<string, PhaseConfig | null>([['01-core', null]]),
        projectDefaultStrict: false,
      });
      expect(out[0]?.mutable).toBe(true);
      expect(out[0]?.layer).toBe('phase');
    });

    it('explicit phase.yml mutable: false beats --no-strict (most-specific wins)', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/x.spec.ts`],
        phaseConfigs: new Map<string, PhaseConfig | null>([
          ['01-core', { tests: { mutable: false } }],
        ]),
        projectDefaultStrict: false,
      });
      expect(out[0]?.mutable).toBe(false);
    });
  });

  describe('per-file immutable-files glob escape hatch', () => {
    it('locks an individual file even when surrounding scope is mutable', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/tests/api-contract.test.ts`, `${FEATURE_REL}/tests/login.spec.ts`],
        featureConfig: {
          tests: {
            mutable: true,
            'immutable-files': ['tests/api-contract.test.ts'],
          },
        },
      });
      expect(out[0]?.mutable).toBe(false);
      expect(out[0]?.reason).toContain('api-contract.test.ts');
      expect(out[1]?.mutable).toBe(true);
    });

    it('glob with **/ matches nested files', () => {
      const out = classify({
        paths: [
          `${FEATURE_REL}/tests/auth-flows/oauth.spec.ts`,
          `${FEATURE_REL}/tests/auth-flows/saml/login.spec.ts`,
          `${FEATURE_REL}/tests/login.spec.ts`,
        ],
        featureConfig: {
          tests: { mutable: true, 'immutable-files': ['tests/auth-flows/**'] },
        },
      });
      expect(out[0]?.mutable).toBe(false);
      expect(out[1]?.mutable).toBe(false);
      expect(out[2]?.mutable).toBe(true);
    });

    it('glob also locks phase-level test files (anchored at feature dir)', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/tests/lock-me.spec.ts`],
        featureConfig: {
          tests: { mutable: true, 'immutable-files': ['phases/01-core/tests/lock-me.spec.ts'] },
        },
      });
      expect(out[0]?.mutable).toBe(false);
      expect(out[0]?.layer).toBe('feature');
    });
  });

  describe('paths outside any tests/ scope', () => {
    it('marks src/foo.ts under feature as unscoped (caller filters)', () => {
      const out = classify({ paths: [`${FEATURE_REL}/src/foo.ts`] });
      expect(out[0]?.layer).toBe('unscoped');
      expect(out[0]?.mutable).toBe(true);
    });

    it('paths outside the feature dir are unscoped', () => {
      const out = classify({ paths: ['src/orchestrator/loop.ts'] });
      expect(out[0]?.layer).toBe('unscoped');
      expect(out[0]?.mutable).toBe(true);
    });

    it('paths under phases/<id>/ but not in tests/ are unscoped', () => {
      const out = classify({
        paths: [`${FEATURE_REL}/phases/01-core/spec.md`],
      });
      expect(out[0]?.layer).toBe('unscoped');
    });
  });

  it('preserves input order in the output', () => {
    const inputs = [
      'saifctl/tests/a.spec.ts',
      `${FEATURE_REL}/tests/b.spec.ts`,
      `${FEATURE_REL}/phases/01-core/tests/c.spec.ts`,
    ];
    const out = classify({ paths: inputs });
    expect(out.map((r) => r.path)).toEqual(inputs);
  });
});

describe('toProjectRelativePosix', () => {
  it('strips the projectDir prefix and forward-slashes', () => {
    expect(toProjectRelativePosix('/Users/x/proj/saifctl/tests/a.spec.ts', '/Users/x/proj')).toBe(
      'saifctl/tests/a.spec.ts',
    );
  });

  it('returns the input (POSIX-normalised) when not under projectDir', () => {
    expect(toProjectRelativePosix('/etc/passwd', '/Users/x/proj')).toBe('/etc/passwd');
  });

  it('handles a trailing slash on projectDir', () => {
    expect(toProjectRelativePosix('/Users/x/proj/saifctl/foo', '/Users/x/proj/')).toBe(
      'saifctl/foo',
    );
  });

  it('normalises Windows-style backslashes', () => {
    expect(
      toProjectRelativePosix('C:\\Users\\x\\proj\\saifctl\\tests\\a.spec.ts', 'C:\\Users\\x\\proj'),
    ).toBe('saifctl/tests/a.spec.ts');
  });
});

describe('findUnusedImmutableFileGlobs', () => {
  it('returns globs that matched no test files', () => {
    const unused = findUnusedImmutableFileGlobs({
      featureConfig: {
        tests: {
          mutable: true,
          'immutable-files': ['tests/will-match.spec.ts', 'tests/will-not-match.spec.ts'],
        },
      },
      featureRelativeTestPaths: ['tests/will-match.spec.ts'],
    });
    expect(unused).toEqual(['tests/will-not-match.spec.ts']);
  });

  it('returns [] when no immutable-files declared', () => {
    expect(
      findUnusedImmutableFileGlobs({
        featureConfig: { tests: { mutable: true } },
        featureRelativeTestPaths: ['tests/x.spec.ts'],
      }),
    ).toEqual([]);
  });

  it('a `**` glob is satisfied by any file', () => {
    const unused = findUnusedImmutableFileGlobs({
      featureConfig: { tests: { mutable: true, 'immutable-files': ['tests/**'] } },
      featureRelativeTestPaths: ['tests/auth/x.spec.ts'],
    });
    expect(unused).toEqual([]);
  });
});
