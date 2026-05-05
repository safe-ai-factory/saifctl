/**
 * Post-round diff inspection for test-file mutability (Block 7 of
 * TODO_phases_and_critics, §5.6 / §9 "diff-inspection (default)").
 *
 * The loop calls {@link inspectImmutableTestChanges} after each round, before
 * the staging tests run. It:
 *
 *   1. Asks `git diff --name-only <preRoundHead>..HEAD` what changed in this
 *      round (a "round" = one outer attempt; the diff base is the HEAD git
 *      rev at the start of the agent's coding work, already tracked as
 *      `perSubtaskPreRoundHead` in loop.ts).
 *   2. Loads the feature config (or uses the supplied pre-loaded copy) so the
 *      classifier has the right inheritance chain.
 *   3. Hands every changed test path to {@link classifyTestPaths} and returns
 *      the immutable-violations subset.
 *
 * The decision to *fail* the gate is the loop's; this module only reports.
 * Surfacing mutability decisions through a pure function lets us test the
 * full classify-then-filter pipeline without spinning up a sandbox.
 *
 * Only `git diff` and `validatePhasedFeature` are I/O. Both are scoped tightly
 * — no shelling out beyond `git`, no globbing the workspace.
 */

import { relative } from 'node:path';

import { consola } from '../logger.js';
import type { FeatureConfig, PhaseConfig } from '../specs/phases/schema.js';
import { validatePhasedFeature } from '../specs/phases/validate.js';
import { classifyTestPaths, type TestPathClassification } from '../specs/tests/mutability.js';
import { git } from '../utils/git.js';

/** Options for {@link inspectImmutableTestChanges}. */
export interface InspectImmutableTestChangesOpts {
  /** Sandbox working tree (the agent's cwd). */
  codePath: string;
  /** Absolute project root — used to convert git output to project-relative POSIX. */
  projectDir: string;
  /** Saifctl config dir name (e.g. `'saifctl'`). */
  saifctlDir: string;
  /** Absolute path to the feature dir inside the sandbox. */
  featureAbsolutePath: string;
  /** `--strict` (true) ⇒ default-immutable. From `resolveStrictFlag`. */
  projectDefaultStrict: boolean;
  /** Git rev at the start of this round (the diff base). */
  preRoundHead: string;
  /**
   * Pre-loaded feature/phase config, optional. When omitted the inspector
   * lazy-loads via {@link validatePhasedFeature} once per call. Provide it
   * when you already have the loaded context (e.g. from a Block 6 pre-flight
   * validation) to avoid re-reading `feature.yml` every round.
   */
  preLoadedConfig?: {
    featureConfig: FeatureConfig | null;
    phaseConfigs: ReadonlyMap<string, PhaseConfig | null>;
  };
}

/** Result of {@link inspectImmutableTestChanges}: changed paths, classified test paths, and the immutable-violations subset. */
export interface InspectImmutableTestChangesResult {
  /** Project-relative POSIX paths of every file the agent touched this round. */
  changedPaths: string[];
  /** Subset that fell under a tests/ scope (as classified). */
  classifiedTestPaths: TestPathClassification[];
  /** Subset of `classifiedTestPaths` that are immutable — these MUST fail the gate. */
  violations: TestPathClassification[];
}

/**
 * Inspect the round's git diff, classify every changed test file, and return
 * any immutable-test violations. Pure-ish: I/O is `git diff` and (optionally)
 * one config load.
 *
 * On `git diff` failure (e.g. `<preRoundHead>` no longer exists in the repo),
 * the inspector returns an empty result rather than throwing — a missing
 * baseline must not silently *bypass* mutability enforcement, but it also
 * must not crash the loop. The loop's caller logs and decides; we surface
 * the empty arrays so the caller's "no violations" path executes.
 */
export async function inspectImmutableTestChanges(
  opts: InspectImmutableTestChangesOpts,
): Promise<InspectImmutableTestChangesResult> {
  const {
    codePath,
    projectDir,
    saifctlDir,
    featureAbsolutePath,
    projectDefaultStrict,
    preRoundHead,
  } = opts;

  let diffOut: string;
  try {
    diffOut = await git({
      cwd: codePath,
      args: ['diff', '--name-only', `${preRoundHead}..HEAD`],
    });
  } catch (err) {
    // Bail-open semantics (see fn-doc): a missing baseline must not crash
    // mid-round, but it also means the immutable-test gate is silently
    // disabled for this round. Surface the bypass loudly so a user reviewing
    // the run log can spot it — otherwise this is exactly the "default
    // elevates access" footgun.
    const reason = err instanceof Error ? err.message : String(err);
    consola.warn(
      `[orchestrator] mutability gate skipped this round: 'git diff ${preRoundHead}..HEAD' failed (${reason}). Immutable-test enforcement will resume next round once the baseline is reachable.`,
    );
    return { changedPaths: [], classifiedTestPaths: [], violations: [] };
  }

  // `git diff --name-only` outputs paths relative to the repo root (codePath)
  // with POSIX separators. The sandbox checkout mirrors the project layout, so
  // a path like `saifctl/features/auth/tests/foo.spec.ts` is already in the
  // shape the classifier expects. We trim only.
  const changedPaths = diffOut
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (changedPaths.length === 0) {
    return { changedPaths: [], classifiedTestPaths: [], violations: [] };
  }

  // Pre-loaded or freshly-loaded config — both produce the same shape.
  let featureConfig: FeatureConfig | null = null;
  let phaseConfigs: ReadonlyMap<string, PhaseConfig | null> = new Map();
  if (opts.preLoadedConfig) {
    featureConfig = opts.preLoadedConfig.featureConfig;
    phaseConfigs = opts.preLoadedConfig.phaseConfigs;
  } else {
    const { context } = await validatePhasedFeature({ featureAbsolutePath });
    if (context) {
      featureConfig = context.featureConfig;
      phaseConfigs = context.phaseConfigs;
    }
    // No context (validation errors) ⇒ fall back to schema-default
    // classification. The Block 6 pre-flight should have caught this; if it
    // didn't, defaulting to `tests.mutable: false` (immutable) keeps us
    // safe rather than silently allowing modifications.
  }

  const featureRelativePath = relative(projectDir, featureAbsolutePath).replaceAll('\\', '/');

  const classifiedTestPaths = classifyTestPaths({
    paths: changedPaths,
    saifctlDir,
    featureRelativePath,
    featureConfig,
    phaseConfigs,
    projectDefaultStrict,
  }).filter((c) => c.layer !== 'unscoped');

  const violations = classifiedTestPaths.filter((c) => !c.mutable);

  return { changedPaths, classifiedTestPaths, violations };
}

/**
 * Format violations as a human-readable, multi-line gate-failure message.
 * Stable wording — tests match against it.
 */
export function formatImmutableViolations(violations: readonly TestPathClassification[]): string {
  if (violations.length === 0) return '';
  const lines = [
    `Gate failed: agent modified ${violations.length} immutable test file${violations.length === 1 ? '' : 's'}:`,
    ...violations.map((v) => `  - ${v.path} — ${v.reason}`),
    'Saifctl considers these tests part of the contract; they cannot be edited by the agent. Revert the changes (or set `tests.mutable: true` for the relevant scope, then retry).',
  ];
  return lines.join('\n');
}
