/**
 * Post-round modification warnings (Block 8 of TODO_phases_and_critics, §9).
 *
 * After every coding round, saifctl prints an informational warning to the
 * run log when the agent's commits modified any plan/spec/test file. The
 * warning is **non-fatal** and **independent of mutability enforcement** —
 * Block 7's diff-inspection fails the gate when *immutable* tests are
 * touched; this module surfaces *all* such modifications regardless of
 * mutability so a reviewer skimming an overnight run can spot deviations
 * without reading the full diff.
 *
 * Two destinations per the §9 / Block 8 clarifications:
 *
 *   1. `consola.warn` — visible in realtime, one warning per round.
 *   2. `<projectDir>/.saifctl/runs/<runId>/modifications.log` — newline-
 *      delimited JSON, one record per warning, for post-hoc grep-ability
 *      after long runs. Always lands in the project's local `.saifctl/`
 *      regardless of the {@link RunStorage} backend (S3 etc.) — the
 *      breadcrumb is small and the local copy is the one a developer is
 *      most likely to scan.
 *
 * **De-duplication.** Per spec: emit one warning per round. Don't try to
 * collapse repeats across rounds — the user wants to see frequency, not just
 * presence.
 *
 * **Critic findings excluded.** `/workspace/.saifctl/critic-findings/**`
 * matches transient discover/fix artifacts (Block 4b lifecycle). Discover
 * writes; fix reads + deletes. Surfacing those would drown the signal —
 * §6.2 explicitly excludes them.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { consola } from '../logger.js';
import { resolvePhaseConfig } from '../specs/phases/load.js';
import { validatePhasedFeature } from '../specs/phases/validate.js';

/**
 * Three buckets the warning surfaces. `kind` lets the JSONL log distinguish
 * deviations of plan/spec from incidental test edits (which may also be
 * mutability violations — that decision is Block 7's, not ours).
 */
export type ModifiedFileKind = 'plan' | 'spec' | 'test';

export interface ClassifiedModifiedFile {
  /** Project-relative POSIX path (echoed from `git diff --name-only`). */
  path: string;
  kind: ModifiedFileKind;
}

export interface ClassifyModifiedPathsOpts {
  /** Project-relative POSIX paths from `git diff --name-only <base>..HEAD`. */
  paths: readonly string[];
  /** Saifctl config dir name, e.g. `'saifctl'`. */
  saifctlDir: string;
  /**
   * Feature dir relative to the project root (POSIX), or `null` for
   * non-feature runs (POC mode / `--subtasks`). When null, only project-level
   * `<saifctlDir>/tests/` matches the test bucket — there's no feature scope
   * to anchor plan/spec patterns against.
   */
  featureRelativePath: string | null;
  /**
   * Per-phase spec filename, resolved from `phases.defaults.spec` (and
   * per-phase overrides) by {@link import('../specs/phases/load.js').resolvePhaseConfig}.
   * Map key is the phase id; value is the filename relative to `<phase>/`.
   * Omit (or pass an empty map) to fall back to the built-in default
   * `'spec.md'`, which covers ~all real projects.
   */
  phaseSpecFilenames?: ReadonlyMap<string, string>;
}

/**
 * Pure classifier: pick out plan / spec / test paths from a list of changed
 * files. Anything else (src/**, docs/**, etc.) is dropped silently. The
 * critic-findings exclusion fires here so callers don't need to remember it.
 *
 * No I/O. Path matching is string-based; callers MUST pass POSIX-separated
 * project-relative paths (the shape `git diff --name-only` produces).
 */
export function classifyModifiedPaths(opts: ClassifyModifiedPathsOpts): ClassifiedModifiedFile[] {
  const { paths, saifctlDir, featureRelativePath } = opts;

  // Workspace-side critic findings dir — agents commit through this on the
  // discover/fix lifecycle. Both the workspace-root and feature-root forms
  // are excluded; the agent's cwd is the workspace root, so writes land at
  // `.saifctl/critic-findings/...`. The feature-root form is paranoid
  // belt-and-braces in case a future critic template changes the convention.
  const criticFindingsPrefixes = [
    `.saifctl/critic-findings/`,
    featureRelativePath ? `${featureRelativePath}/.saifctl/critic-findings/` : null,
  ].filter((p): p is string => p !== null);

  const projectTestsPrefix = `${saifctlDir}/tests/`;

  const out: ClassifiedModifiedFile[] = [];
  for (const path of paths) {
    if (criticFindingsPrefixes.some((p) => path.startsWith(p))) continue;

    // Project-level always-immutable tests (§5.6 layer 1) — surfaced as
    // 'test' regardless of feature scope. `git diff --name-only` returns file
    // paths only, so the `<saifctlDir>/tests/<...>` prefix is the only shape
    // we need to match (a bare directory name is unreachable here).
    if (path.startsWith(projectTestsPrefix)) {
      out.push({ path, kind: 'test' });
      continue;
    }

    if (!featureRelativePath) continue;

    const featurePrefix = `${featureRelativePath}/`;
    if (!path.startsWith(featurePrefix)) continue;
    const tail = path.slice(featurePrefix.length);

    // plan: exactly `<feature>/plan.md`. Sub-plans (`docs/plan.md` etc.) are
    // not the canonical plan and shouldn't trigger the deviation signal.
    if (tail === 'plan.md') {
      out.push({ path, kind: 'plan' });
      continue;
    }

    // spec at feature root: `<feature>/specification.md` (Block 5 convention)
    // or `<feature>/spec.md` (legacy non-phased shape).
    if (tail === 'specification.md' || tail === 'spec.md') {
      out.push({ path, kind: 'spec' });
      continue;
    }
    // spec under a phase dir: `<feature>/phases/<id>/<spec-filename>`. The
    // filename is configurable per `phases.defaults.spec` (default `spec.md`);
    // callers that have already loaded the resolved phase configs can pass
    // {@link ClassifyModifiedPathsOpts.phaseSpecFilenames} so a project that
    // sets `defaults: { spec: SPEC.md }` still has its deviations surfaced.
    // When the map is omitted we fall back to `'spec.md'` — the dominant case
    // and the literal naming the §9 directive references.
    if (tail.startsWith('phases/')) {
      const segments = tail.split('/');
      if (segments.length === 3 && segments[0] === 'phases') {
        const phaseId = segments[1] ?? '';
        const fileName = segments[2] ?? '';
        const expectedSpecName = opts.phaseSpecFilenames?.get(phaseId) ?? 'spec.md';
        if (fileName === expectedSpecName) {
          out.push({ path, kind: 'spec' });
          continue;
        }
      }
      // tests under a phase dir: `<feature>/phases/<id>/tests/**`.
      const afterPhases = tail.slice('phases/'.length);
      const slash = afterPhases.indexOf('/');
      if (slash !== -1) {
        const rest = afterPhases.slice(slash + 1);
        if (rest.startsWith('tests/')) {
          out.push({ path, kind: 'test' });
          continue;
        }
      }
    }

    // tests at feature root: `<feature>/tests/**`.
    if (tail.startsWith('tests/')) {
      out.push({ path, kind: 'test' });
      continue;
    }
  }
  return out;
}

export interface SurfaceModifiedPathsAfterRoundOpts {
  /** Round number (1-based; the loop's `attempts` counter is fine). */
  round: number;
  /** Subtask cursor index — embedded in the JSONL for easier post-hoc tracing. */
  subtaskIndex: number;
  /** Phase id when the subtask is part of a phased feature, else null. */
  phaseId: string | null;
  /**
   * Critic id when the subtask is a discover/fix step, else null. Lets a
   * reviewer scanning the JSONL distinguish "implementer touched the spec"
   * from "the strict critic's fix step rewrote the spec."
   */
  criticId: string | null;
  /** `git diff --name-only <base>..HEAD` output, project-relative POSIX. */
  changedPaths: readonly string[];
  /** Saifctl config dir name. */
  saifctlDir: string;
  /** Feature dir relative to project root, POSIX-separated. `null` in POC mode. */
  featureRelativePath: string | null;
  /**
   * Per-phase spec filename map (see {@link ClassifyModifiedPathsOpts.phaseSpecFilenames}).
   * Optional — defaults to `'spec.md'` for every phase id when omitted.
   */
  phaseSpecFilenames?: ReadonlyMap<string, string>;
  /**
   * Absolute project root. The JSONL log lands at
   * `<projectDir>/.saifctl/runs/<runId>/modifications.log`. Independent of
   * the run-storage backend (S3/local) — small breadcrumb, always local.
   */
  projectDir: string;
  /** Run identifier (used for the JSONL path). */
  runId: string;
}

/**
 * Top-level entry point: classify, log, and persist. Safe to call every
 * round; emits nothing when no plan/spec/test files were touched.
 *
 * The function never throws — JSONL append errors are logged but not
 * propagated, since failing a coding round over a missing breadcrumb dir
 * would be a regression.
 */
export async function surfaceModifiedPathsAfterRound(
  opts: SurfaceModifiedPathsAfterRoundOpts,
): Promise<ClassifiedModifiedFile[]> {
  const classified = classifyModifiedPaths({
    paths: opts.changedPaths,
    saifctlDir: opts.saifctlDir,
    featureRelativePath: opts.featureRelativePath,
    phaseSpecFilenames: opts.phaseSpecFilenames,
  });
  if (classified.length === 0) return classified;

  const message = formatRoundWarning(opts.round, classified);
  consola.warn(`[orchestrator] ${message}`);

  const logPath = join(opts.projectDir, '.saifctl', 'runs', opts.runId, 'modifications.log');
  const record = {
    timestamp: new Date().toISOString(),
    round: opts.round,
    subtaskIndex: opts.subtaskIndex,
    phaseId: opts.phaseId,
    criticId: opts.criticId,
    files: classified,
  };
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    consola.warn(
      `[orchestrator] Could not append modifications.log at '${logPath}': ${err instanceof Error ? err.message : String(err)}. (Run continues; the consola.warn above is the authoritative record for this round.)`,
    );
  }
  return classified;
}

/**
 * Resolve `phaseId → spec filename` for the feature, applying the same
 * inheritance chain `inspectImmutableTestChanges` uses (phase.yml > inline >
 * phases.defaults). Returns an empty map (the same as "use built-in default")
 * on any load/validate error — Block 8 is a soft signal, never a gate, so a
 * malformed feature.yml mid-round must NOT fail the loop.
 *
 * Call this ONCE at loop init and pass the resulting map to every
 * {@link surfaceModifiedPathsAfterRound} invocation. The cost is one feature
 * config + N phase config reads; the alternative (re-load per round) blows
 * up the disk-read profile on long overnight runs.
 */
export async function loadPhaseSpecFilenames(
  featureAbsolutePath: string,
): Promise<ReadonlyMap<string, string>> {
  try {
    const { context } = await validatePhasedFeature({ featureAbsolutePath });
    if (!context) return new Map();
    const out = new Map<string, string>();
    for (const phase of context.phases) {
      const cfg = resolvePhaseConfig({
        phaseId: phase.id,
        phaseConfig: context.phaseConfigs.get(phase.id) ?? null,
        featureConfig: context.featureConfig,
      });
      out.set(phase.id, cfg.spec);
    }
    return out;
  } catch (err) {
    // Falling back to default `'spec.md'` is safe for the dominant case; the
    // loud surface is the consola.warn so a developer reviewing the run can
    // see the resolution failed.
    consola.warn(
      `[orchestrator] Could not resolve phase-spec filenames for Block 8 surfacing (${err instanceof Error ? err.message : String(err)}); falling back to default 'spec.md' for every phase.`,
    );
    return new Map();
  }
}

/**
 * Stable wording. Test asserts against this format, so changes here must be
 * paired with the matching test update.
 */
export function formatRoundWarning(
  round: number,
  classified: readonly ClassifiedModifiedFile[],
): string {
  const list = classified.map((c) => `${c.path} (${c.kind})`).join(', ');
  return `[round ${round}] Agent modified the following plan/spec/test files: ${list}`;
}
