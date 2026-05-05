/**
 * Phase → subtasks compiler.
 *
 * Reads the filesystem (`feature.yml`, per-phase `phase.yml`, `phases/`,
 * `critics/`), runs Block 1's structural validator, and emits a
 * deterministic `RunSubtaskInput[]` for the existing iterative loop:
 *
 *   - 1 implementer subtask per phase (in resolved phase order)
 *   - N critic subtasks per phase per critic per round
 *
 * Each emitted subtask declares `testScope.include = [<phase>/tests/]` with
 * `cumulative: true`; Block 2's loop-side resolver chains them into the
 * cumulative gate per §9. The **last** phase additionally includes
 * `<feature>/tests/` and `<saifctlDir>/tests/`, so end-state contracts gate
 * only at the end of the run (the mongo→postgres rationale in §9 / Block 2).
 *
 * **Block 4 (critic prompt rendering, mustache):** every emitted subtask
 * carries `phaseId`. Critic subtasks additionally carry `criticPrompt`
 * metadata (critic id, round, total rounds, and the closed mustache var set
 * minus `phase.baseRef`). Critic `content` is the raw `critics/<id>.md`
 * body — the loop captures `phase.baseRef` when the phase's impl subtask
 * starts and renders the body via `renderCriticPrompt` just before the
 * critic subtask becomes the active row. The compile-time output stays
 * config-faithful (raw body), runtime output is rendered.
 *
 * Paths emitted in prompts are **container-side** (under `/workspace`), since
 * the agent runs inside Docker with the repo bind-mounted at `/workspace` (see
 * `engines/docker/index.ts`). Host-absolute paths from `feature.absolutePath`
 * are translated via `relative(projectDir, …)` before being put in the prompt.
 */

import { join, relative } from 'node:path';

import type { RunSubtaskInput, RunSubtaskTestScope } from '../../runs/types.js';
import { readUtf8 } from '../../utils/io.js';
import { BUILTIN_FIX_TEMPLATE } from './critic-prompt.js';
import { type DiscoveredCritic, effectivePhaseOrder, type ValidationReport } from './discover.js';
import { resolvePhaseConfig } from './load.js';
import type { CriticEntry } from './schema.js';
import { validatePhasedFeature } from './validate.js';

export interface CompilePhasesOptions {
  /** Absolute path to the feature dir. */
  featureAbsolutePath: string;
  /** Display name for prompt content + error messages. */
  featureName: string;
  /** Saifctl dir name (e.g. 'saifctl') — used for project-level tests path + prompt boilerplate. */
  saifctlDir: string;
  /** Absolute project root — used to compute project-level tests path for the last phase. */
  projectDir: string;
  /** Run-level gate script content; threaded onto every emitted subtask for manifest parity. */
  gateScript: string;
}

/**
 * Compile a phased feature into deterministic subtasks.
 *
 * Throws {@link PhaseCompileError} when structural validation fails (typo'd
 * critic id, unknown phase in `feature.yml.phases.order`, etc.). The error
 * message is human-readable and prefixed with `[feature '<name>']`.
 */
export async function compilePhasesToSubtasks(
  opts: CompilePhasesOptions,
): Promise<RunSubtaskInput[]> {
  const { featureAbsolutePath, featureName, saifctlDir, projectDir, gateScript } = opts;

  // --- Load + discover + validate. -----------------------------------------
  // Block 6 unifies validation behind `validatePhasedFeature` so the same
  // checks run for `feat phases compile`, `feat phases validate`, and the
  // `feat run` pre-flight. On any error we throw `PhaseCompileError` with the
  // full report; on success the loaded context is reused below so we don't
  // re-stat the filesystem.
  const { report, context } = await validatePhasedFeature({ featureAbsolutePath });
  if (report.errors.length > 0) {
    throw new PhaseCompileError(featureName, report);
  }
  // context is guaranteed non-null when errors.length === 0.
  const { featureConfig, phases, critics, phaseConfigs } = context!;

  // --- Effective order. -----------------------------------------------------
  const order = effectivePhaseOrder({ featureConfig, discoveredPhases: phases });
  if (order.length === 0) {
    throw new PhaseCompileError(featureName, {
      errors: [`[feature '${featureName}'] phases/ exists but contains no valid phase directories`],
      warnings: [],
    });
  }

  // --- Compile. -------------------------------------------------------------
  const phaseById = new Map(phases.map((p) => [p.id, p]));
  const criticsById = new Map(critics.map((c) => [c.id, c]));

  // Workspace-relative feature dir (e.g. 'saifctl/features/auth'). The agent
  // runs in a container with `/workspace` mounted to the host project; raw
  // host-absolute paths from `feature.absolutePath` would not resolve there.
  const featureWorkspaceDir = relative(projectDir, featureAbsolutePath);
  const featurePlanWorkspacePath = workspacePath(featureWorkspaceDir, 'plan.md');

  // Read each referenced critic body exactly once (not once per phase). The
  // raw body is identical across rounds — every per-round difference (round
  // counter, findingsPath, baseRef) lives in `criticPrompt.vars` / runtime
  // state and is woven in by the loop's mustache renderer.
  const criticBodies = new Map<string, string>();

  const out: RunSubtaskInput[] = [];
  const lastPhaseId = order[order.length - 1]!;

  for (const phaseId of order) {
    const phase = phaseById.get(phaseId)!;
    const config = resolvePhaseConfig({
      phaseId,
      phaseConfig: phaseConfigs.get(phaseId) ?? null,
      featureConfig,
    });

    const isLast = phaseId === lastPhaseId;
    const testScope = buildPhaseTestScope({
      phaseAbsolutePath: phase.absolutePath,
      featureAbsolutePath,
      projectDir,
      saifctlDir,
      isLast,
    });

    const phaseRelativeDir = `${featureWorkspaceDir}/phases/${phaseId}`;
    const phaseWorkspaceDir = workspacePath(phaseRelativeDir);
    const specWorkspacePath = workspacePath(phaseRelativeDir, config.spec);
    const testsWorkspacePath = workspacePath(phaseRelativeDir, 'tests');

    // Implementer subtask.
    out.push({
      title: `phase:${phaseId} impl`,
      content: buildImplementerPrompt({
        featureName,
        saifctlDir,
        phaseId,
        specWorkspacePath,
        featurePlanWorkspacePath,
      }),
      gateScript,
      testScope,
      phaseId,
    });

    // Critics for this phase.
    const criticEntries = resolveCriticListForPhase({
      resolvedCritics: config.critics,
      discoveredCritics: critics,
    });
    for (const entry of criticEntries) {
      const critFile = criticsById.get(entry.id);
      if (!critFile) {
        // validatePhaseGraph should have caught this; defensive only.
        throw new PhaseCompileError(featureName, {
          errors: [
            `[feature '${featureName}'] phase '${phaseId}' references unknown critic '${entry.id}'`,
          ],
          warnings: [],
        });
      }
      let rawBody = criticBodies.get(entry.id);
      if (rawBody === undefined) {
        rawBody = await readUtf8(critFile.absolutePath);
        criticBodies.set(entry.id, rawBody);
      }
      const totalRounds = entry.rounds;
      const baseVars = {
        feature: {
          name: featureName,
          dir: featureWorkspaceDir,
          plan: featurePlanWorkspacePath,
        },
        phase: {
          id: phaseId,
          dir: phaseWorkspaceDir,
          spec: specWorkspacePath,
          tests: testsWorkspacePath,
        },
      };
      for (let r = 1; r <= totalRounds; r++) {
        const findingsPath = buildFindingsPath({ phaseId, criticId: entry.id, round: r });
        // Per §6: each round = (discover, fix). Discover writes findings to
        // a temp file; fix reads + applies + deletes. Both subtasks share the
        // phase's testScope. Discover's `content` is the user's
        // `critics/<id>.md` body; fix's is the saifctl-owned BUILTIN_FIX_TEMPLATE.
        // Both are mustache-rendered by the loop just before activation.
        out.push({
          title: `phase:${phaseId} critic:${entry.id} round:${r}/${totalRounds} discover`,
          content: rawBody,
          gateScript,
          testScope,
          phaseId,
          criticPrompt: {
            criticId: entry.id,
            round: r,
            totalRounds,
            step: 'discover',
            findingsPath,
            vars: baseVars,
          },
        });
        out.push({
          title: `phase:${phaseId} critic:${entry.id} round:${r}/${totalRounds} fix`,
          content: BUILTIN_FIX_TEMPLATE,
          gateScript,
          testScope,
          phaseId,
          criticPrompt: {
            criticId: entry.id,
            round: r,
            totalRounds,
            step: 'fix',
            findingsPath,
            vars: baseVars,
          },
        });
      }
    }
  }

  return out;
}

/**
 * Build a `/workspace`-rooted absolute path from path segments that are
 * already workspace-relative. Joins with `posix` slashes regardless of host —
 * the path is consumed inside a Linux container, not on the host.
 */
function workspacePath(...segments: string[]): string {
  // node:path's posix `join` is the right primitive but adds an import burden;
  // since we control all callers and pass already-clean segments, a manual
  // join keeps the surface tight. Strip leading/trailing `/` from segments
  // so accidentally absolute pieces don't break the prefix.
  const cleaned = segments.flatMap((s) => s.split(/[\\/]+/).filter(Boolean));
  return `/workspace/${cleaned.join('/')}`;
}

/**
 * Container-side path for a critic round's findings file. Pinned per
 * (phase, critic, round) so re-runs (resume / retry) write and read the
 * same path deterministically. Lives in the workspace `.saifctl/` dir
 * (where `task.md` already lives) — distinct from the project's `saifctl/`
 * config dir.
 */
function buildFindingsPath(opts: {
  phaseId: string;
  criticId: string;
  round: number;
}): string {
  return `/workspace/.saifctl/critic-findings/${opts.phaseId}--${opts.criticId}--r${opts.round}.md`;
}

/**
 * Resolve a phase's effective critic list per §5.4 / §9.
 *
 * - `null` (sentinel from `resolvePhaseConfig` meaning "not declared at any
 *   layer") ⇒ run all discovered critics, alphabetical, `rounds: 1` each.
 * - `[]` ⇒ run no critics for this phase.
 * - non-empty array ⇒ run those critics in declared order.
 */
function resolveCriticListForPhase(opts: {
  resolvedCritics: CriticEntry[] | null;
  discoveredCritics: DiscoveredCritic[];
}): CriticEntry[] {
  if (opts.resolvedCritics === null) {
    return opts.discoveredCritics.map((c) => ({ id: c.id, rounds: 1 }));
  }
  return opts.resolvedCritics;
}

/**
 * Build the cumulative `testScope.include` list for one phase.
 *
 * Always includes the phase's own `tests/` dir. The **last** phase in the run
 * also includes `<feature>/tests/` and `<saifctlDir>/tests/` so feature-level
 * and project-level tests gate only at the terminal state. Earlier phases
 * never include them — those tests describe end-state contracts that cannot
 * pass mid-migration (mongo→postgres rationale in §9).
 *
 * Paths that don't exist on disk are still emitted; Block 2's
 * `synthesizeMergedTestsDir` silently skips missing source dirs, so the
 * compiled output is forward-compatible with Block 7's project-level tests
 * convention even before that block lands.
 */
function buildPhaseTestScope(opts: {
  phaseAbsolutePath: string;
  featureAbsolutePath: string;
  projectDir: string;
  saifctlDir: string;
  isLast: boolean;
}): RunSubtaskTestScope {
  const include = [join(opts.phaseAbsolutePath, 'tests')];
  if (opts.isLast) {
    include.push(join(opts.featureAbsolutePath, 'tests'));
    include.push(join(opts.projectDir, opts.saifctlDir, 'tests'));
  }
  return { include, cumulative: true };
}

/**
 * Implementer prompt — link-only (consistent with Block 5). Tells the agent
 * which phase to implement, points at the spec + plan, and reminds it not to
 * touch saifctl/ or immutable test paths. Spec/plan paths are container-side
 * (`/workspace/...`) so they resolve from the agent's cwd inside Docker.
 */
function buildImplementerPrompt(opts: {
  featureName: string;
  saifctlDir: string;
  phaseId: string;
  specWorkspacePath: string;
  featurePlanWorkspacePath: string;
}): string {
  const { featureName, saifctlDir, phaseId, specWorkspacePath, featurePlanWorkspacePath } = opts;
  return [
    `Implement phase '${phaseId}' of feature '${featureName}'.`,
    '',
    `The spec for this phase is at \`${specWorkspacePath}\`. You MUST read it before making any changes.`,
    `The broader plan for this feature is at \`${featurePlanWorkspacePath}\`. Read it for context — it describes how this phase fits into the overall feature.`,
    '',
    `Write code in the /workspace directory. Within /${saifctlDir}/, you may modify ONLY this feature's plan (\`${featurePlanWorkspacePath}\`) and this phase's spec (\`${specWorkspacePath}\`) — and only when your implementation deviates from them, in which case update them to match what you actually built. Do NOT modify any other file under /${saifctlDir}/, and do NOT modify any immutable test paths.`,
    'When complete, ensure the code compiles and passes linting.',
  ].join('\n');
}

/**
 * Thrown when phase compilation fails structural validation. Wraps a
 * {@link ValidationReport} so callers (CLI, tests) can inspect each error
 * individually instead of parsing a string.
 */
export class PhaseCompileError extends Error {
  override readonly name = 'PhaseCompileError';
  readonly featureName: string;
  readonly report: ValidationReport;
  constructor(featureName: string, report: ValidationReport) {
    super(`Phase compilation failed for feature '${featureName}':\n${report.errors.join('\n')}`);
    this.featureName = featureName;
    this.report = report;
  }
}
