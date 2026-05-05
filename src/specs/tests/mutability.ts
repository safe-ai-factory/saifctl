/**
 * Test-file mutability classifier (Block 7 of TODO_phases_and_critics).
 *
 * Implements the three-layer model from §5.6:
 *
 *   1. `saifctl/tests/**`                                 → ALWAYS immutable.
 *   2. `saifctl/features/<feat>/phases/<id>/tests/**`     → resolved per phase
 *      config (phase.yml ⇒ feature.yml.phases.defaults ⇒ feature.yml.tests
 *      ⇒ project default).
 *   3. `saifctl/features/<feat>/tests/**`                 → resolved per feature
 *      config (feature.yml.tests ⇒ project default).
 *
 * Per-file escape hatch (`feature.yml.tests.immutable-files` globs) marks
 * specific files as immutable even when their surrounding scope resolved as
 * mutable. The reverse — making a saifctl/tests/ file mutable — is
 * intentionally not supported (the always-immutable rule is non-overridable
 * per §9).
 *
 * The classifier takes the config + the project default and a list of paths;
 * it does no I/O. Callers that have only host-absolute paths convert them to
 * project-relative POSIX before calling — this module's contract is
 * project-relative POSIX only, so it composes cleanly with `git diff
 * --name-only` output (also project-relative POSIX).
 */

import { minimatch } from 'minimatch';

import { resolvePhaseConfig } from '../phases/load.js';
import type { FeatureConfig, PhaseConfig } from '../phases/schema.js';

/** One classification result. `mutable: false` means immutable (gate-failing). */
export interface TestPathClassification {
  /** Project-relative POSIX path of the test file (echoed from input). */
  path: string;
  /** `true` ⇒ agent is allowed to modify it. `false` ⇒ touching it fails the gate. */
  mutable: boolean;
  /**
   * Human-readable reason — surfaced in diff-inspection failure messages and
   * `feat phases validate` reports. Stable enough to match in tests.
   */
  reason: string;
  /** Which layer of §5.6 made the decision. Useful for grouped log output. */
  layer: 'project' | 'phase' | 'feature' | 'unscoped';
}

/** Inputs to {@link classifyTestPaths}: paths to classify plus the feature/phase config that drives the decision. */
export interface ClassifyTestPathsOptions {
  /**
   * Project-relative POSIX paths of test files to classify (e.g. what
   * `git diff --name-only` returns). Non-test paths SHOULD be filtered by
   * the caller — this module classifies whatever it receives; an arbitrary
   * `src/foo.ts` would be reported as `unscoped` + mutable.
   */
  paths: readonly string[];
  /** Saifctl config-dir name (e.g. `'saifctl'`). Project-relative, no leading slash. */
  saifctlDir: string;
  /**
   * Feature dir relative to projectDir, POSIX-separated (e.g.
   * `saifctl/features/auth` or `saifctl/features/(auth)/login`). The
   * classifier matches paths against this prefix to identify feature- and
   * phase-level test files.
   */
  featureRelativePath: string;
  /** Loaded `feature.yml` content, or `null` if absent. */
  featureConfig: FeatureConfig | null;
  /**
   * Per-phase loaded `phase.yml`, keyed by phase id. Pass `null` for any
   * phase that exists on disk but has no `phase.yml` — same convention as
   * `validatePhasedFeature`'s `PhasedFeatureContext.phaseConfigs`.
   */
  phaseConfigs: ReadonlyMap<string, PhaseConfig | null>;
  /**
   * Project default for `tests.mutable` after applying CLI `--strict` /
   * `--no-strict` and the project-level `defaults.strict` config. `true`
   * (the saifctl default) means "default to immutable"; `false` means
   * "default to mutable".
   */
  projectDefaultStrict: boolean;
}

/**
 * Classify each path. Pure function: no I/O, no globbing on disk — globs
 * match by string only. Order of input paths is preserved in output.
 */
export function classifyTestPaths(opts: ClassifyTestPathsOptions): TestPathClassification[] {
  const {
    paths,
    saifctlDir,
    featureRelativePath,
    featureConfig,
    phaseConfigs,
    projectDefaultStrict,
  } = opts;

  // Normalise prefixes once. We compare against forward-slash paths
  // throughout — callers MUST pass POSIX strings.
  const projectTestsPrefix = `${saifctlDir}/tests/`;
  const featurePrefix = `${featureRelativePath}/`;
  const phasesPrefix = `${featureRelativePath}/phases/`;
  const featureTestsPrefix = `${featureRelativePath}/tests/`;

  // Pre-compile per-feature immutable-files globs ONCE so repeated
  // classification doesn't re-parse them per file. Globs are
  // **feature-relative**, so we anchor each match against the path's
  // feature-relative tail.
  const immutableGlobs = featureConfig?.tests?.['immutable-files'] ?? [];

  return paths.map((path) => classifyOne(path));

  function classifyOne(path: string): TestPathClassification {
    // Layer 1: project-level always-immutable. Hard-coded; not overridable.
    if (path === projectTestsPrefix.slice(0, -1) || path.startsWith(projectTestsPrefix)) {
      return {
        path,
        mutable: false,
        reason: `${saifctlDir}/tests/ is always immutable`,
        layer: 'project',
      };
    }

    // Layers 2/3: feature-scoped. If the path doesn't fall under the feature
    // dir at all, we can't classify it from the supplied configs — return an
    // honest "unscoped" sentinel rather than guessing.
    if (!path.startsWith(featurePrefix)) {
      return {
        path,
        mutable: true,
        reason: `path is outside feature '${featureRelativePath}/' — no mutability config applies`,
        layer: 'unscoped',
      };
    }

    // Per-file immutable-files override (feature-scope only, per §5.6).
    // Checked BEFORE the scope decision so an explicit "lock this file"
    // wins over a mutable surrounding scope. Globs are feature-relative.
    const featureRelativeTail = path.slice(featurePrefix.length);
    for (const glob of immutableGlobs) {
      if (minimatch(featureRelativeTail, glob, { dot: true })) {
        return {
          path,
          mutable: false,
          reason: `matched feature.yml.tests.immutable-files glob '${glob}'`,
          layer: 'feature',
        };
      }
    }

    // Layer 2: phase-level tests. Path looks like
    // `<featureRelativePath>/phases/<id>/tests/...`. We use the immediate
    // segment after `phases/` as the phase id and consult its config.
    if (path.startsWith(phasesPrefix)) {
      const afterPhases = path.slice(phasesPrefix.length);
      const slash = afterPhases.indexOf('/');
      const phaseId = slash === -1 ? afterPhases : afterPhases.slice(0, slash);
      const phaseTestsPrefix = `${phasesPrefix}${phaseId}/tests/`;
      if (path === phaseTestsPrefix.slice(0, -1) || path.startsWith(phaseTestsPrefix)) {
        // Pass `projectDefaultStrict` through so the resolver applies the
        // right floor when no `mutable:` declaration walks up the chain.
        // (Without this, --no-strict was silently ignored for phase tests.)
        const resolved = resolvePhaseConfig({
          phaseId,
          phaseConfig: phaseConfigs.get(phaseId) ?? null,
          featureConfig,
          projectDefaultStrict,
        });
        const mutable = resolved.tests.mutable;
        return {
          path,
          mutable,
          reason: mutable
            ? `phase '${phaseId}' tests resolved as mutable (feature/phase config or --no-strict default)`
            : `phase '${phaseId}' tests resolved as immutable (feature/phase config or strict default)`,
          layer: 'phase',
        };
      }
      // Under phases/<id>/ but not /tests/ — not a test path; return
      // unscoped so callers can filter. Don't classify non-test files as
      // immutable just because they share an ancestor.
      return {
        path,
        mutable: true,
        reason: `path is under phases/${phaseId}/ but not in a tests/ directory — not a test file`,
        layer: 'unscoped',
      };
    }

    // Layer 3: feature-level tests at `<feature>/tests/`.
    if (path === featureTestsPrefix.slice(0, -1) || path.startsWith(featureTestsPrefix)) {
      const featureMutableExplicit = featureConfig?.tests?.mutable;
      const mutable = resolveMutable(featureMutableExplicit, projectDefaultStrict);
      return {
        path,
        mutable,
        reason: mutable
          ? `feature tests resolved as mutable (feature.yml or strict default)`
          : `feature tests resolved as immutable (feature.yml or strict default)`,
        layer: 'feature',
      };
    }

    // Inside the feature dir but not under any tests/ path. Same honest
    // sentinel — not our problem to classify.
    return {
      path,
      mutable: true,
      reason: `path is under feature '${featureRelativePath}/' but not in a tests/ directory — not a test file`,
      layer: 'unscoped',
    };
  }
}

/**
 * `--strict` / `--no-strict` resolution: when the explicit per-scope value is
 * `undefined` (not set anywhere in the inheritance chain), fall back to
 * `!projectDefaultStrict`. Strict ⇒ default-immutable ⇒ mutable=false.
 */
function resolveMutable(explicit: boolean | undefined, projectDefaultStrict: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return !projectDefaultStrict;
}

/**
 * Best-effort: convert a host-absolute path to project-relative POSIX.
 * Returns the original path unchanged if it isn't under `projectDir` (the
 * caller will then see it as `unscoped` from the classifier).
 *
 * Exposed because the diff-inspection loop integration has only host paths
 * coming back from `git diff` resolved against the sandbox cwd; this is the
 * one boundary where conversion is unavoidable.
 */
export function toProjectRelativePosix(hostAbsolutePath: string, projectDir: string): string {
  const normalised = hostAbsolutePath.replaceAll('\\', '/');
  const projNorm = projectDir.replaceAll('\\', '/');
  const prefix = projNorm.endsWith('/') ? projNorm : `${projNorm}/`;
  if (normalised.startsWith(prefix)) return normalised.slice(prefix.length);
  return normalised;
}

/**
 * Validate `feature.yml.tests.immutable-files` globs against actual on-disk
 * test files. Returns the globs that matched zero files — the caller (Block
 * 6's validator) can surface them as warnings per §5.5 ("globs that match
 * zero files at validate time ⇒ warn (may match files that don't exist
 * yet)").
 *
 * `featureRelativeTestPaths` is the list of test files that exist under
 * `<feature>/tests/` and `<feature>/phases/<id>/tests/`, each expressed
 * **relative to the feature dir** (POSIX). Callers that have absolute paths
 * convert with {@link toProjectRelativePosix} then strip the
 * `<featureRelativePath>/` prefix.
 */
export function findUnusedImmutableFileGlobs(opts: {
  featureConfig: FeatureConfig | null;
  featureRelativeTestPaths: readonly string[];
}): string[] {
  const globs = opts.featureConfig?.tests?.['immutable-files'] ?? [];
  if (globs.length === 0) return [];
  return globs.filter(
    (g) => !opts.featureRelativeTestPaths.some((p) => minimatch(p, g, { dot: true })),
  );
}
