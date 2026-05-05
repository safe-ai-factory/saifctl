/**
 * Standalone phased-feature validator (Block 6).
 *
 * Loads `feature.yml` + per-phase `phase.yml`, discovers `phases/` and
 * `critics/` on disk, runs the same cross-file structural checks as
 * `validatePhaseGraph` (discover.ts), then layers on file-existence checks
 * the compiler doesn't currently do (each phase's resolved spec file must
 * exist).
 *
 * Returns a {@link ValidationReport} (errors + warnings) — never throws
 * for routine validation failures, so `feat phases validate` can print
 * every problem at once instead of bailing on the first parse error.
 *
 * Two callers:
 *   - `compilePhasesToSubtasks` runs validation up-front and aborts on
 *     errors; the returned `context` lets compile reuse the loaded data.
 *   - `feat phases validate` and the `feat run` pre-flight call this
 *     directly to surface errors before the orchestrator boots.
 */

import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { pathExists } from '../../utils/io.js';
import { findUnusedImmutableFileGlobs } from '../tests/mutability.js';
import {
  discoverCritics,
  type DiscoveredCritic,
  type DiscoveredPhase,
  discoverPhases,
  validatePhaseGraph,
  type ValidationReport,
} from './discover.js';
import {
  loadFeatureConfig,
  loadPhaseConfig,
  MultipleConfigVariantsError,
  PhaseConfigParseError,
  resolvePhaseConfig,
} from './load.js';
import type { FeatureConfig, PhaseConfig } from './schema.js';

/** Loaded + discovered state shared between validate and compile. */
export interface PhasedFeatureContext {
  featureConfig: FeatureConfig | null;
  phases: DiscoveredPhase[];
  critics: DiscoveredCritic[];
  /** phaseId → loaded phase.yml (null when no file or when its load failed). */
  phaseConfigs: Map<string, PhaseConfig | null>;
  /** Whether `subtasks.json` is present alongside `phases/` (cross-check). */
  subtasksJsonPresent: boolean;
}

/** Inputs to {@link validatePhasedFeature}: just the absolute path to the feature dir. */
export interface ValidatePhasedFeatureOptions {
  /** Absolute path to the feature directory. */
  featureAbsolutePath: string;
}

/**
 * Load → discover → validate. Always returns a report; only throws on
 * unexpected I/O errors (which surface as the underlying error type so the
 * caller can decide what to do). Parse and schema errors are folded into
 * `report.errors`.
 *
 * `context` is `null` when the report has errors — callers that need to do
 * further work (compile) should treat any error as a hard stop and not
 * try to use partial data.
 */
export async function validatePhasedFeature(opts: ValidatePhasedFeatureOptions): Promise<{
  report: ValidationReport;
  context: PhasedFeatureContext | null;
}> {
  const { featureAbsolutePath } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const featureLabel = `[feature '${basename(featureAbsolutePath)}']`;

  const subtasksJsonPath = join(featureAbsolutePath, 'subtasks.json');
  const subtasksJsonPresent = await pathExists(subtasksJsonPath);

  let featureConfig: FeatureConfig | null = null;
  try {
    const result = await loadFeatureConfig(featureAbsolutePath);
    featureConfig = result?.config ?? null;
  } catch (err) {
    errors.push(`${featureLabel} ${formatLoadError(err)}`);
  }

  const { phases, invalidIds: invalidPhaseIds } = await discoverPhases(featureAbsolutePath);
  const { critics, invalidIds: invalidCriticIds } = await discoverCritics(featureAbsolutePath);

  const phaseConfigs = new Map<string, PhaseConfig | null>();
  for (const p of phases) {
    try {
      const loaded = await loadPhaseConfig(p.absolutePath);
      phaseConfigs.set(p.id, loaded?.config ?? null);
    } catch (err) {
      // Don't abort — record and move on so the user sees every parse
      // error in one pass. Other phases may still have valid configs.
      errors.push(`${featureLabel} ${formatLoadError(err)}`);
      phaseConfigs.set(p.id, null);
    }
  }

  // Cross-file structural checks.
  const cross = validatePhaseGraph({
    featureDir: featureAbsolutePath,
    featureConfig,
    phaseConfigs,
    discoveredPhases: phases,
    discoveredCritics: critics,
    invalidPhaseIds,
    invalidCriticIds,
    subtasksJsonPresent,
  });
  errors.push(...cross.errors);
  warnings.push(...cross.warnings);

  // File existence: each phase's resolved spec file must be on disk.
  // Per Block 5, the implementer prompt's "MUST read <spec>" directive must
  // never point at a missing file — that invites the agent to fabricate
  // content. The compiler bakes the resolved spec path into the prompt
  // verbatim, so this check belongs at validate time, before compile runs.
  for (const p of phases) {
    const cfg = resolvePhaseConfig({
      phaseId: p.id,
      phaseConfig: phaseConfigs.get(p.id) ?? null,
      featureConfig,
    });
    const specPath = join(p.absolutePath, cfg.spec);
    if (!(await pathExists(specPath))) {
      errors.push(
        `${featureLabel} phase '${p.id}' is missing its spec file '${cfg.spec}' (expected at ${specPath})`,
      );
    }
  }

  // Block 7 (§5.5): warn when a `feature.yml.tests.immutable-files` glob
  // matches no file on disk. Per the spec this is a *warning*, not an error
  // — the user may have declared the glob in anticipation of a phase that
  // hasn't written the test yet. We collect the on-disk feature-relative
  // test paths (under `tests/` and `phases/<id>/tests/`) and ask the
  // mutability module which globs went unused.
  const declaredGlobs = featureConfig?.tests?.['immutable-files'] ?? [];
  if (declaredGlobs.length > 0) {
    const featureRelativeTestPaths = await collectFeatureRelativeTestPaths({
      featureAbsolutePath,
      phases,
    });
    const unused = findUnusedImmutableFileGlobs({
      featureConfig,
      featureRelativeTestPaths,
    });
    for (const g of unused) {
      warnings.push(
        `${featureLabel} feature.yml.tests.immutable-files glob '${g}' matched zero files on disk (may match files added later)`,
      );
    }
  }

  const report: ValidationReport = { errors, warnings };
  const context: PhasedFeatureContext | null =
    errors.length === 0
      ? { featureConfig, phases, critics, phaseConfigs, subtasksJsonPresent }
      : null;
  return { report, context };
}

function formatLoadError(err: unknown): string {
  if (err instanceof PhaseConfigParseError || err instanceof MultipleConfigVariantsError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk `<feature>/tests/` and every `<feature>/phases/<id>/tests/` and
 * return each file's path **relative to the feature dir**, POSIX-separated
 * (e.g. `tests/login.spec.ts`, `phases/01-core/tests/x.spec.ts`).
 *
 * Used by the unused-glob warning above. We do the walk only when there's
 * at least one declared glob, so no I/O cost when the feature doesn't use
 * the per-file escape hatch.
 *
 * Missing dirs are silently skipped (a feature may have phases but no
 * top-level `tests/`, or vice versa).
 */
async function collectFeatureRelativeTestPaths(opts: {
  featureAbsolutePath: string;
  phases: DiscoveredPhase[];
}): Promise<string[]> {
  const out: string[] = [];
  const roots = [
    join(opts.featureAbsolutePath, 'tests'),
    ...opts.phases.map((p) => join(p.absolutePath, 'tests')),
  ];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for (const f of await walkFiles(root)) {
      out.push(relative(opts.featureAbsolutePath, f).replaceAll('\\', '/'));
    }
  }
  return out;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}
