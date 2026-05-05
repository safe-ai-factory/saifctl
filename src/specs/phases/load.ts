/**
 * File loading + inheritance resolution for `feature.yml` and `phase.yml`.
 *
 * - File-extension precedence: when multiple of `.yml` / `.yaml` / `.json` are
 *   present in the same dir, error (refuse to silently pick one). See §5.5.
 * - Inheritance resolution per §5.3 (most-specific wins; no key-level merge for
 *   list-valued keys like `critics`).
 *
 * Cross-file validation (referenced critic id exists, referenced phase id
 * matches a discovered phase dir) lives in discover.ts — load.ts is purely
 * file → typed config → resolved-per-phase config.
 */

import { join } from 'node:path';

import { cosmiconfig } from 'cosmiconfig';
import { type ZodError } from 'zod';

import { pathExists } from '../../utils/io.js';
import {
  type CriticEntry,
  type FeatureConfig,
  featureConfigSchema,
  type PhaseConfig,
  phaseConfigSchema,
  type TestsConfig,
} from './schema.js';

const CONFIG_EXTENSIONS = ['yml', 'yaml', 'json'] as const;

/**
 * cosmiconfig loader for parsing yml / yaml / json. We bypass `search()` and
 * use `load()` directly on a path we picked ourselves so we can detect
 * duplicate variants (which `search()` would silently resolve in favor of one).
 */
const FEATURE_LOADER = cosmiconfig('saifctl-feature', { searchPlaces: [] });
const PHASE_LOADER = cosmiconfig('saifctl-phase', { searchPlaces: [] });

/**
 * Locate a config file matching `<basename>.{yml,yaml,json}` in `dir`.
 *
 * Returns the path to the single existing file, or `null` when none exists.
 * Errors when multiple variants exist (the user must pick one).
 */
async function findSingleConfigVariant(dir: string, basename: string): Promise<string | null> {
  const candidates = CONFIG_EXTENSIONS.map((ext) => join(dir, `${basename}.${ext}`));
  const present = await Promise.all(
    candidates.map(async (p) => ((await pathExists(p)) ? p : null)),
  );
  const found = present.filter((p): p is string => p !== null);
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new MultipleConfigVariantsError({ basename, dir, variants: found });
  }
  return found[0]!;
}

/** Thrown when multiple file-extension variants exist for the same config. */
export class MultipleConfigVariantsError extends Error {
  readonly variants: readonly string[];
  constructor(opts: { basename: string; dir: string; variants: readonly string[] }) {
    super(
      `Multiple ${opts.basename}.{yml,yaml,json} variants in ${opts.dir}; pick one:\n  ${opts.variants.join('\n  ')}`,
    );
    this.name = 'MultipleConfigVariantsError';
    this.variants = opts.variants;
  }
}

/** Thrown when a config file fails Zod schema validation. */
export class PhaseConfigParseError extends Error {
  readonly filepath: string;
  readonly zodError: ZodError;
  constructor(filepath: string, zodError: ZodError) {
    super(`Invalid config at ${filepath}:\n${formatZodError(zodError)}`);
    this.name = 'PhaseConfigParseError';
    this.filepath = filepath;
    this.zodError = zodError;
  }
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join('\n');
}

/**
 * Load and validate `feature.yml` (or `.yaml` / `.json`) from `featureDir`.
 *
 * Returns `null` when no file is present (the absence of feature.yml is fine —
 * everything is optional). Throws on multiple variants or invalid schema.
 */
export async function loadFeatureConfig(
  featureDir: string,
): Promise<{ config: FeatureConfig; filepath: string } | null> {
  const filepath = await findSingleConfigVariant(featureDir, 'feature');
  if (!filepath) return null;
  const result = await FEATURE_LOADER.load(filepath);
  if (!result?.config) return null;
  const parsed = featureConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    throw new PhaseConfigParseError(filepath, parsed.error);
  }
  return { config: parsed.data, filepath };
}

/**
 * Load and validate `phase.yml` (or `.yaml` / `.json`) from `phaseDir`.
 *
 * Returns `null` when no file is present. Throws on multiple variants or
 * invalid schema.
 */
export async function loadPhaseConfig(
  phaseDir: string,
): Promise<{ config: PhaseConfig; filepath: string } | null> {
  const filepath = await findSingleConfigVariant(phaseDir, 'phase');
  if (!filepath) return null;
  const result = await PHASE_LOADER.load(filepath);
  if (!result?.config) return null;
  const parsed = phaseConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    throw new PhaseConfigParseError(filepath, parsed.error);
  }
  return { config: parsed.data, filepath };
}

// ---------------------------------------------------------------------------
// Inheritance resolution
// ---------------------------------------------------------------------------

/**
 * Built-in defaults applied at the bottom of the inheritance chain.
 * Centralized here so changes are visible in one place.
 *
 * `tests.mutable`'s default is NOT here — it's derived per-resolver-call from
 * `projectDefaultStrict` (CLI `--strict`/`--no-strict` → `defaults.strict` →
 * built-in `true`) so a `--no-strict` invocation actually flips the floor.
 * See {@link resolvePhaseConfig}.
 */
export const BUILT_IN_DEFAULTS = {
  testsFail2pass: true,
  testsEnforce: 'diff-inspection' as const,
  testsImmutableFiles: [] as string[],
  defaultCriticRounds: 1,
} as const;

/**
 * Effective per-phase config after inheritance resolution.
 *
 * Distinct shape from `PhaseConfig` so callers can rely on every field being
 * populated (no optionals) and on the "undefined critics" sentinel being
 * resolved to a concrete decision (run-all vs run-specified vs run-none).
 */
export interface ResolvedPhaseConfig {
  /** Phase id (matches dir name under phases/). */
  phaseId: string;
  /** Path to spec file relative to the phase dir. */
  spec: string;
  /**
   * Resolved critic list. `null` means "run all critics discovered in
   * critics/" — the resolver propagates `undefined` from the inheritance
   * chain to this sentinel; discover.ts expands it to the actual critic list.
   * `[]` means "run no critics."
   */
  critics: CriticEntry[] | null;
  tests: ResolvedTestsConfig;
}

export interface ResolvedTestsConfig {
  mutable: boolean;
  /**
   * Effective fail2pass after the "mutable=true ⇒ fail2pass=false unless
   * explicitly set" rule (per §9 / §5.6).
   */
  fail2pass: boolean;
  enforce: 'diff-inspection' | 'read-only';
  immutableFiles: string[];
}

/**
 * Resolve the effective config for one phase per §5.3 (extended by §9 to
 * include the inline-phase layer):
 *   1. phase.yml
 *   2. feature.yml.phases.phases.<id>  (inline override)
 *   3. feature.yml.phases.defaults
 *   4. feature.yml top-level (only for keys defined at both scopes; today
 *      that's `critics:` and `tests:`)
 *   5. project default (for `tests.mutable` only — driven by
 *      `projectDefaultStrict`, i.e. `--strict`/`--no-strict`)
 *   6. built-in defaults
 *
 * No key-level merge for list-valued keys: a `critics:` (or `immutable-files:`)
 * declaration at any level REPLACES all lower levels. Object-valued `tests:`
 * resolves sub-key by sub-key (per §5.6 "first explicit declaration wins").
 *
 * `projectDefaultStrict` defaults to `true` (strict ⇒ default-immutable) when
 * the caller doesn't care about strict mode (e.g. compile.ts and validate.ts,
 * which only consume `critics`/`spec` from the resolved config). The classifier
 * MUST pass it through so `--no-strict` actually flips the phase-tests floor.
 */
export function resolvePhaseConfig(opts: {
  phaseId: string;
  phaseConfig: PhaseConfig | null;
  featureConfig: FeatureConfig | null;
  projectDefaultStrict?: boolean;
}): ResolvedPhaseConfig {
  const { phaseId, phaseConfig, featureConfig } = opts;
  const projectDefaultStrict = opts.projectDefaultStrict ?? true;

  const inlinePhase = featureConfig?.phases?.phases?.[phaseId] ?? null;
  const phaseDefaults = featureConfig?.phases?.defaults ?? null;

  // critics: most-specific defined wins; undefined propagates as "run all" sentinel.
  const critics = firstDefined<CriticEntry[]>(
    phaseConfig?.critics,
    inlinePhase?.critics,
    phaseDefaults?.critics,
    featureConfig?.critics,
  );

  // tests: resolve each sub-key independently (object keys CAN merge across layers).
  const tests = resolveTests({
    layers: [phaseConfig?.tests, inlinePhase?.tests, phaseDefaults?.tests, featureConfig?.tests],
    projectDefaultStrict,
  });

  // spec: phase.yml > inline > phases.defaults > built-in 'spec.md'.
  // (defaults.spec lets a project override the spec filename uniformly,
  // e.g. `defaults: { spec: SPEC.md }` for projects with uppercase naming.)
  const spec =
    firstDefined<string>(phaseConfig?.spec, inlinePhase?.spec, phaseDefaults?.spec) ?? 'spec.md';

  return {
    phaseId,
    spec,
    critics: critics ?? null,
    tests,
  };
}

/**
 * Returns the first non-undefined value (treating null as defined for
 * "explicitly absent"). Used for inheritance resolution where `undefined`
 * means "not set at this layer."
 */
function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/**
 * Resolve `tests` config across inheritance layers. Each sub-key resolves
 * independently (most-specific defined wins). Then the
 * "mutable=true ⇒ fail2pass=false unless explicit" rule fires.
 *
 * For the list-valued `immutable-files`, no key-level merge: a defined value
 * at any layer replaces all lower layers.
 *
 * `mutable`'s floor is `!projectDefaultStrict` rather than a hard-coded
 * built-in: strict ⇒ default-immutable, --no-strict ⇒ default-mutable. Per
 * §5.6 the project default applies only when nothing in the chain declares
 * `mutable`.
 */
function resolveTests(opts: {
  layers: (TestsConfig | undefined)[];
  projectDefaultStrict: boolean;
}): ResolvedTestsConfig {
  const { layers, projectDefaultStrict } = opts;
  const get = <K extends keyof TestsConfig>(key: K): TestsConfig[K] | undefined => {
    for (const l of layers) {
      if (l && l[key] !== undefined) return l[key];
    }
    return undefined;
  };

  const mutable = get('mutable') ?? !projectDefaultStrict;
  const explicitFail2pass = get('fail2pass');
  // Mutable=true auto-flips fail2pass to false UNLESS explicitly set (§9).
  const fail2pass = explicitFail2pass ?? (mutable ? false : BUILT_IN_DEFAULTS.testsFail2pass);
  const enforce = get('enforce') ?? BUILT_IN_DEFAULTS.testsEnforce;
  const immutableFiles = get('immutable-files') ?? BUILT_IN_DEFAULTS.testsImmutableFiles;

  return { mutable, fail2pass, enforce, immutableFiles };
}
