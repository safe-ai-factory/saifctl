/**
 * Resolve {@link RunSubtaskInput}[] from manifests, auto-discovery, or plan/spec synthesis.
 */

import { join, relative, resolve } from 'node:path';

import { PLACEHOLDER_GATE_SCRIPT_MARKER } from '../constants.js';
import { consola } from '../logger.js';
import type { RunSubtaskInput } from '../runs/types.js';
import { compilePhasesToSubtasks, PhaseCompileError } from '../specs/phases/compile.js';
import { pathExists, readUtf8 } from '../utils/io.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads a JSON file and returns a validated non-empty {@link RunSubtaskInput}[].
 * Exits the process on validation failure.
 */
export async function loadSubtasksFromFile(filePath: string): Promise<RunSubtaskInput[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readUtf8(filePath)) as unknown;
  } catch (err) {
    consola.error(`Error: --subtasks file is not valid JSON: ${filePath}`);
    consola.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    consola.error(`Error: --subtasks file must be a non-empty JSON array: ${filePath}`);
    process.exit(1);
  }

  const out: RunSubtaskInput[] = [];
  const rows = raw as unknown[];
  for (let i = 0; i < rows.length; i++) {
    const el: unknown = rows[i];
    if (!isPlainObject(el)) {
      consola.error(`Error: --subtasks[${i}] must be an object: ${filePath}`);
      process.exit(1);
    }
    const content = el.content;
    if (typeof content !== 'string' || !content.trim()) {
      consola.error(`Error: --subtasks[${i}].content must be a non-empty string: ${filePath}`);
      process.exit(1);
    }
    const row: RunSubtaskInput = { content: content.trim() };
    if (el.title !== undefined) {
      if (typeof el.title !== 'string') {
        consola.error(`Error: --subtasks[${i}].title must be a string: ${filePath}`);
        process.exit(1);
      }
      row.title = el.title;
    }
    if (el.gateScript !== undefined) {
      if (typeof el.gateScript !== 'string') {
        consola.error(`Error: --subtasks[${i}].gateScript must be a string: ${filePath}`);
        process.exit(1);
      }
      // Reject `phases.compiled.json` artifacts. The compile output is a
      // review-only document — its placeholder gateScript is intentionally
      // fail-loud (Block 6 hardening), but we'd rather surface the misuse
      // here, with guidance, than have the user discover it via a
      // confusing inner-round failure. See `feat-phases.ts` for the
      // marker definition + rationale.
      if (el.gateScript.includes(PLACEHOLDER_GATE_SCRIPT_MARKER)) {
        consola.error(
          `Error: --subtasks[${i}].gateScript contains the phases.compiled.json placeholder marker.`,
        );
        consola.error(`  --subtasks file: ${filePath}`);
        consola.error(
          '  This file looks like the output of `saifctl feat phases compile`, which is a',
        );
        consola.error(
          '  review-only artifact. Run `saifctl feat run` (without --subtasks) to execute the',
        );
        consola.error(
          '  feature, or pass `--gate-script <path>` to `feat phases compile` to bake a real',
        );
        consola.error('  gate into a runnable manifest.');
        process.exit(1);
      }
      row.gateScript = el.gateScript;
    }
    if (el.agentScript !== undefined) {
      if (typeof el.agentScript !== 'string') {
        consola.error(`Error: --subtasks[${i}].agentScript must be a string: ${filePath}`);
        process.exit(1);
      }
      row.agentScript = el.agentScript;
    }
    if (el.gateRetries !== undefined) {
      if (
        typeof el.gateRetries !== 'number' ||
        !Number.isFinite(el.gateRetries) ||
        el.gateRetries < 1
      ) {
        consola.error(
          `Error: --subtasks[${i}].gateRetries must be a positive integer: ${filePath}`,
        );
        process.exit(1);
      }
      row.gateRetries = Math.floor(el.gateRetries);
    }
    if (el.reviewerEnabled !== undefined) {
      if (typeof el.reviewerEnabled !== 'boolean') {
        consola.error(`Error: --subtasks[${i}].reviewerEnabled must be a boolean: ${filePath}`);
        process.exit(1);
      }
      row.reviewerEnabled = el.reviewerEnabled;
    }
    if (el.agentEnv !== undefined) {
      if (!isPlainObject(el.agentEnv)) {
        consola.error(`Error: --subtasks[${i}].agentEnv must be an object: ${filePath}`);
        process.exit(1);
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(el.agentEnv)) {
        if (typeof v !== 'string') {
          consola.error(
            `Error: --subtasks[${i}].agentEnv values must be strings (key: ${k}): ${filePath}`,
          );
          process.exit(1);
        }
        env[k] = v;
      }
      row.agentEnv = env;
    }
    out.push(row);
  }
  return out;
}

/**
 * Builds one {@link RunSubtaskInput} for the legacy non-phased path
 * (no `phases/` dir, no `subtasks.json`). Plan and spec are referenced by
 * **link**, not inlined — see Block 5 of TODO_phases_and_critics.
 *
 * Why link-only:
 *   The implementer runs many rounds per task (each gate-retry, each round).
 *   Inlining a 600-1200-LOC plan in every round wastes tokens and removes
 *   the agent's ability to selectively read what it needs. The agent has
 *   filesystem access to its workspace; the directive tells it to read the
 *   files itself.
 *
 * Symmetry: this matches the link-only contract used by Block 3's phase
 * compiler (`buildImplementerPrompt`) and the critic prompts (Block 4 / 4b).
 *
 * **Behavior change from pre-Block-5:** previously this function inlined the
 * full content of `plan.md` and `specification.md` under `## Plan` /
 * `## Specification` headings. If a downstream agent regresses to ignoring
 * the directive, the documented escape hatch is
 * `feature.yml.implementer.inline-plan: true` (not yet implemented).
 *
 * **Engine-agnostic paths.** The synthesiser runs at options-baseline time,
 * before any `--engine local` CLI override has been applied. To stay
 * correct in both container and host execution, the directive emits
 * **workspace-root-relative POSIX paths** rather than absolute ones. The
 * agent's cwd is the workspace root in both modes — `/workspace` inside
 * Docker (`WorkingDir`) and `codePath` for `--engine local` (`spawn` cwd) —
 * so a relative path resolves correctly regardless of engine. Per-round
 * directives in {@link buildTaskPrompt} run at execution time when the
 * engine IS known, so they continue to use absolute paths.
 *
 * Phased features bypass this function entirely — `compilePhasesToSubtasks`
 * (Block 3) emits its own per-phase implementer prompts.
 */
export async function synthesizePlanSpecSubtaskInputs(opts: {
  featureAbsolutePath: string;
  featureName: string;
  saifctlDir: string;
  /** Run-level gate script; stored on the subtask row for manifest parity. */
  gateScript: string;
  /**
   * Workspace-relative path to the feature dir (e.g. `saifctl/features/auth`).
   * Native or POSIX separators accepted; the synthesiser normalises to `/`
   * so the directive is portable across host OSes.
   */
  featureRelativePath: string;
  /**
   * Absolute project root. Block 7: needed to compute the absolute path of
   * `<projectDir>/<saifctlDir>/tests/` so the loop's test-scope resolver can
   * find the project-level always-immutable suite.
   */
  projectDir: string;
}): Promise<RunSubtaskInput[]> {
  const {
    featureAbsolutePath,
    featureName,
    saifctlDir,
    gateScript,
    featureRelativePath,
    projectDir,
  } = opts;
  const planHostPath = join(featureAbsolutePath, 'plan.md');
  const specHostPath = join(featureAbsolutePath, 'specification.md');

  const [hasPlan, hasSpec] = await Promise.all([
    pathExists(planHostPath),
    pathExists(specHostPath),
  ]);

  // Workspace-root-relative POSIX paths (see fn-doc rationale). The agent's
  // cwd is the workspace root in both engine modes, so `<feat>/plan.md`
  // resolves correctly without knowing whether we're in Docker or host
  // execution. Normalise here so callers may pass either `\\` or `/`.
  const posixRel = featureRelativePath.replaceAll('\\', '/');
  const planAgentPath = `${posixRel}/plan.md`;
  const specAgentPath = `${posixRel}/specification.md`;

  const parts: string[] = [];

  if (hasPlan && hasSpec) {
    parts.push(
      `Implement the feature '${featureName}' per the specification at \`${specAgentPath}\` and the plan at \`${planAgentPath}\` (both relative to your workspace root, i.e. your current working directory). Both files are in your workspace and you MUST read them before you make any changes.`,
    );
  } else if (hasSpec) {
    parts.push(
      `Implement the feature '${featureName}' per the specification at \`${specAgentPath}\` (relative to your workspace root, i.e. your current working directory). The file is in your workspace; you MUST read it before you make any changes.`,
    );
  } else if (hasPlan) {
    parts.push(
      `Implement the feature '${featureName}' per the implementation plan at \`${planAgentPath}\` (relative to your workspace root, i.e. your current working directory). The file is in your workspace; you MUST read it before you make any changes.`,
    );
  } else {
    // Neither file exists — fall back to a name-only prompt. Without spec or
    // plan there's no mechanical way to know what to build; the agent will
    // have to ask or infer. Keep the prompt honest about that.
    parts.push(
      `Implement the feature '${featureName}'. No specification or plan was found in the feature directory; do the best you can with the feature name as your only spec.`,
    );
  }

  parts.push(
    `Write code in the workspace directory. Do NOT modify files in the /${saifctlDir}/ directory.`,
    'When complete, ensure the code compiles and passes linting.',
  );

  // Block 7: project-level `saifctl/tests/` runs as part of every feature run
  // (always-immutable per §5.6). Set testScope.include explicitly here so the
  // non-phased path picks them up — the loop's `synthesizeMergedTestsDir`
  // skips sources that don't exist on disk, so this is safe even when the
  // project hasn't created `saifctl/tests/` yet. The feature's own tests/
  // dir is the legacy default; we list it explicitly so the merged-tests
  // synthesis sees both rather than silently dropping back to a single
  // fallback path.
  return [
    {
      title: featureName,
      content: parts.join('\n'),
      gateScript,
      testScope: {
        include: [join(featureAbsolutePath, 'tests'), join(projectDir, saifctlDir, 'tests')],
        cumulative: true,
      },
    },
  ];
}

/**
 * Resolve subtasks for a `feat run` invocation.
 *
 * Priority + mutual-exclusion model (per Block 3 of TODO_phases_and_critics):
 *
 * 1. **`--subtasks <file>`** (CLI escape hatch) — when set, used verbatim and
 *    overrides any feature-dir source. Hidden from `feat run --help`; intended
 *    for emergency manual control.
 * 2. Otherwise, the feature dir's three subtask sources are **mutually
 *    exclusive**; if any two coexist we exit with a clear error rather than
 *    silently picking one:
 *    - `phases/` directory ⇒ phase compilation (Block 3).
 *    - `subtasks.json` file ⇒ manual manifest (existing).
 *    - neither ⇒ synthesize one subtask from `plan.md` + `specification.md`.
 */
export async function resolveSubtasks(opts: {
  subtasksFlag: string | undefined;
  featureAbsolutePath: string;
  featureName: string;
  saifctlDir: string;
  gateScript: string;
  projectDir: string;
}): Promise<RunSubtaskInput[]> {
  const { subtasksFlag, featureAbsolutePath, featureName, saifctlDir, gateScript, projectDir } =
    opts;

  // 1. Explicit CLI escape hatch — overrides everything in the feature dir.
  if (subtasksFlag?.trim()) {
    const resolved = resolve(projectDir, subtasksFlag.trim());
    if (!(await pathExists(resolved))) {
      consola.error(`Error: --subtasks file not found: ${resolved}`);
      process.exit(1);
    }
    return loadSubtasksFromFile(resolved);
  }

  // 2. Feature-dir mutual exclusion: phases/ XOR subtasks.json XOR neither.
  const phasesDir = join(featureAbsolutePath, 'phases');
  const subtasksJsonPath = join(featureAbsolutePath, 'subtasks.json');
  const [hasPhases, hasSubtasksJson] = await Promise.all([
    pathExists(phasesDir),
    pathExists(subtasksJsonPath),
  ]);

  if (hasPhases && hasSubtasksJson) {
    consola.error(
      `Error: feature '${featureName}' has both a phases/ directory and a subtasks.json file. ` +
        'These are mutually exclusive subtask sources; pick one.\n' +
        `  phases/         ${phasesDir}\n` +
        `  subtasks.json   ${subtasksJsonPath}`,
    );
    process.exit(1);
  }

  if (hasPhases) {
    consola.log(`[orchestrator] Compiling phased feature: ${phasesDir}`);
    try {
      return await compilePhasesToSubtasks({
        featureAbsolutePath,
        featureName,
        saifctlDir,
        projectDir,
        gateScript,
      });
    } catch (err) {
      if (err instanceof PhaseCompileError) {
        consola.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  if (hasSubtasksJson) {
    consola.log(`[orchestrator] Auto-discovered subtasks manifest: ${subtasksJsonPath}`);
    return loadSubtasksFromFile(subtasksJsonPath);
  }

  // Workspace-relative feature dir for the link-only directive (Block 5).
  // The synthesiser normalises native separators internally; we pass the
  // raw `relative()` output so a Windows host's `\\`-separated value still
  // produces a POSIX directive.
  const featureRelativePath = relative(projectDir, featureAbsolutePath);
  return synthesizePlanSpecSubtaskInputs({
    featureAbsolutePath,
    featureName,
    saifctlDir,
    gateScript,
    featureRelativePath,
    projectDir,
  });
}
