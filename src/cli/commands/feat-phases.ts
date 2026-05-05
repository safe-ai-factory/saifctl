/**
 * `saifctl feat phases <subcommand>` — phase compilation + validation CLI.
 *
 * Two subcommands (Block 6 of TODO_phases_and_critics):
 *
 *   - **`compile <feature>`** — write the deterministic
 *     `RunSubtaskInput[]` the loop would see, to
 *     `.saifctl/features/<feat>/phases.compiled.json`. Diff-friendly +
 *     reviewable; lets the user inspect what gets dispatched without
 *     starting a run.
 *   - **`validate <feature>`** — schema validation, file-existence checks,
 *     mutability resolution; print errors and warnings, do NOT write
 *     anything. Exit 1 on errors.
 *
 * Both commands rely on {@link validatePhasedFeature} for the load + cross-
 * check so error reporting is consistent across the CLI and the `feat run`
 * pre-flight.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { defineCommand } from 'citty';

import { PLACEHOLDER_GATE_SCRIPT_MARKER } from '../../constants.js';
import { consola } from '../../logger.js';
import type { RunSubtaskInput } from '../../runs/types.js';
import { compilePhasesToSubtasks, PhaseCompileError } from '../../specs/phases/compile.js';
import { validatePhasedFeature } from '../../specs/phases/validate.js';
import { pathExists, readUtf8, writeUtf8 } from '../../utils/io.js';
import { nameArg, projectDirArg, saifctlDirArg } from '../args.js';
import {
  getFeatOrPrompt,
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  resolveCliProjectDir,
  resolveSaifctlDirRelative,
} from '../utils.js';

/**
 * Project-relative output path for `feat phases compile`.
 *
 * Lives at `<projectDir>/.saifctl/features/<feature.name>/phases.compiled.json`
 * (per the Block 6 clarification): per-feature, NOT per-run, because the
 * compiled output is config-derived. Per-run state lives at
 * `.saifctl/runs/<runId>/`. Returns the absolute host path.
 */
export function compiledPhasesOutputPath(opts: {
  projectDir: string;
  featureSlug: string;
}): string {
  return join(opts.projectDir, '.saifctl', 'features', opts.featureSlug, 'phases.compiled.json');
}

const phasesArgs = {
  name: nameArg,
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
};

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate a phased feature without running anything (schema + file checks).',
  },
  args: phasesArgs,
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const feature = await getFeatOrPrompt(args, projectDir);

    const phasesDir = join(feature.absolutePath, 'phases');
    if (!(await pathExists(phasesDir))) {
      consola.error(
        `Error: feature '${feature.name}' has no phases/ directory at ${phasesDir} — nothing to validate.`,
      );
      process.exit(1);
    }

    const ok = await runValidationAndPrint({
      featureAbsolutePath: feature.absolutePath,
      featureName: feature.name,
    });
    if (ok) {
      consola.log(`Validation passed for feature '${feature.name}'.`);
    } else {
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

const compileCommand = defineCommand({
  meta: {
    name: 'compile',
    description:
      'Compile a phased feature to deterministic subtasks JSON (writes .saifctl/features/<feat>/phases.compiled.json).',
  },
  args: {
    ...phasesArgs,
    'gate-script': {
      type: 'string' as const,
      // Optional: when omitted we emit a fail-loud placeholder marker (see
      // PLACEHOLDER_GATE_SCRIPT below). The compiled output is reviewer-
      // facing — it documents the prompts and structure; the real
      // gateScript content is loaded at `feat run` time from the resolved
      // gate script. Asking the user to pass a bash file just to inspect
      // the prompts would be friction. The placeholder is intentionally
      // `exit 1` (not `exit 0`) so a misuse of the artifact via
      // `--subtasks <compiled.json>` fails loud rather than silently
      // bypassing gates.
      description:
        '(optional) Path to a gate script whose content should be embedded on every emitted subtask. When omitted, gateScript is set to a fail-loud placeholder marker — the compiled JSON is review-only and not intended to be passed to `feat run --subtasks`.',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const feature = await getFeatOrPrompt(args, projectDir);

    const phasesDir = join(feature.absolutePath, 'phases');
    if (!(await pathExists(phasesDir))) {
      consola.error(
        `Error: feature '${feature.name}' has no phases/ directory at ${phasesDir} — nothing to compile.`,
      );
      process.exit(1);
    }

    const ok = await runValidationAndPrint({
      featureAbsolutePath: feature.absolutePath,
      featureName: feature.name,
    });
    if (!ok) process.exit(1);

    const gateScript = await readOptionalGateScript(args['gate-script'], projectDir);

    let subtasks;
    try {
      subtasks = await compilePhasesToSubtasks({
        featureAbsolutePath: feature.absolutePath,
        featureName: feature.name,
        saifctlDir,
        projectDir,
        gateScript,
      });
    } catch (err) {
      // Validation already ran above, so this should be unreachable in the
      // common case. Defensive: surface PhaseCompileError nicely if it
      // somehow slips through (e.g. a critic body read fails).
      if (err instanceof PhaseCompileError) {
        consola.error(err.message);
        process.exit(1);
      }
      throw err;
    }

    const outPath = compiledPhasesOutputPath({ projectDir, featureSlug: feature.name });
    await mkdir(dirname(outPath), { recursive: true });
    // The artifact is review-only; rewrite host-absolute `testScope.include`
    // entries to project-relative POSIX so two engineers running compile on
    // the same project produce byte-identical JSON (the "diff-friendly" goal).
    // The runtime path inside `feat run` keeps the absolute form — only this
    // serialised form is portable.
    const artifact = subtasks.map((s) => normalizeSubtaskForArtifact(s, projectDir));
    // Trailing newline + 2-space indent for diff-friendliness. JSON keys
    // are emitted in insertion order, which is deterministic across runs
    // because the compiler builds inputs in a fixed order.
    await writeUtf8(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    consola.log(`Wrote ${subtasks.length} subtask(s) to ${outPath}`);
  },
});

/**
 * Make one subtask portable for the on-disk compile artifact.
 *
 * The compiler emits host-absolute paths in `testScope.include` (the loop
 * needs them at runtime), but the artifact is meant to be diff-friendly: two
 * developers running `feat phases compile` on the same project should get
 * byte-identical JSON. Rewrite each `include` entry to a project-relative
 * POSIX path so the `/Users/<name>/...` prefix doesn't leak. Already-relative
 * or out-of-tree absolute paths are left as-is (POSIX-normalised) — there's
 * nothing to safely strip.
 */
function normalizeSubtaskForArtifact(
  subtask: RunSubtaskInput,
  projectDir: string,
): RunSubtaskInput {
  const include = subtask.testScope?.include;
  if (!include?.length) return subtask;
  const rebased = include.map((p) => {
    if (!isAbsolute(p)) return p.replaceAll('\\', '/');
    const rel = relative(projectDir, p);
    // `relative` returns '..' segments for paths outside projectDir; in that
    // case we keep the absolute form so the artifact still describes reality
    // (rather than silently lying about where the path lives).
    if (rel.startsWith('..')) return p.replaceAll('\\', '/');
    return rel.replaceAll('\\', '/');
  });
  return { ...subtask, testScope: { ...subtask.testScope, include: rebased } };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Run validation and print the report. Returns `true` when there are no
 * errors (warnings are non-blocking).
 *
 * Exposed so the `feat run` pre-flight can call into the same printing path
 * — a single source of truth for what a validation message looks like.
 */
export async function runValidationAndPrint(opts: {
  featureAbsolutePath: string;
  featureName: string;
}): Promise<boolean> {
  const { report } = await validatePhasedFeature({ featureAbsolutePath: opts.featureAbsolutePath });

  if (report.warnings.length > 0) {
    consola.warn(`Validation warnings for feature '${opts.featureName}':`);
    for (const w of report.warnings) consola.warn(`  - ${w}`);
  }

  if (report.errors.length > 0) {
    consola.error(`Validation failed for feature '${opts.featureName}':`);
    for (const e of report.errors) consola.error(`  - ${e}`);
    return false;
  }
  return true;
}

/**
 * Fail-loud placeholder used by `feat phases compile` when no `--gate-script`
 * is supplied. The compiled JSON is **review-only** — it documents what the
 * loop will see, not something to be executed via `feat run --subtasks`.
 *
 * Two concerns shape this script:
 *
 *   1. **Detectability.** {@link PLACEHOLDER_GATE_SCRIPT_MARKER} is embedded
 *      so `loadSubtasksFromFile` (and any future consumer) can detect a
 *      misused artifact and refuse it with a guiding error.
 *   2. **Fail-safe default.** The script is `exit 1`, not `exit 0`. If the
 *      detection in step 1 ever regresses or is bypassed, the gate at least
 *      fails closed — the agent's work is rejected — instead of silently
 *      passing every round (which would let bad code through every gate).
 *
 * Older Block 6 shipped this as `exit 0`. That was an "optional inputs whose
 * defaults elevate access" footgun: a user who didn't realise the artifact
 * was review-only could `--subtasks <compiled>` it and silently bypass every
 * gate. Hence the change to `exit 1` + a structured marker (constants.ts).
 */
const PLACEHOLDER_GATE_SCRIPT = [
  '#!/usr/bin/env bash',
  `# ${PLACEHOLDER_GATE_SCRIPT_MARKER}`,
  '#',
  '# This placeholder ships in the output of `saifctl feat phases compile`.',
  '# The compiled JSON is a REVIEW artifact — it documents what the loop',
  '# will see, but is NOT intended to be fed back via `feat run --subtasks`.',
  '#',
  '# `feat run` (without `--subtasks`) resolves the real gate script per',
  '# profile / CLI flag. To compile with a real gate baked in, pass',
  '# `--gate-script <path>` to `feat phases compile`.',
  '#',
  '# Failing closed (exit 1) so a misuse of the artifact never silently',
  '# bypasses gates — see PLACEHOLDER_GATE_SCRIPT_MARKER in feat-phases.ts.',
  "echo \"saifctl: refusing to gate against a phases.compiled.json placeholder. Run 'saifctl feat run' (without --subtasks) for actual execution, or pass --gate-script to 'feat phases compile' to bake a real gate.\" >&2",
  'exit 1',
  '',
].join('\n');

async function readOptionalGateScript(
  cliPath: string | undefined,
  projectDir: string,
): Promise<string> {
  const trimmed = cliPath?.trim();
  if (!trimmed) return PLACEHOLDER_GATE_SCRIPT;
  // `resolve` (not `join`) so an absolute path like `/etc/gate.sh` is honoured
  // verbatim instead of being silently rewritten to `<projectDir>/etc/gate.sh`.
  // Mirrors the behaviour of `--subtasks` in `resolveSubtasks`.
  const resolved = resolve(projectDir, trimmed);
  if (!(await pathExists(resolved))) {
    consola.error(`Error: --gate-script file not found: ${resolved}`);
    process.exit(1);
  }
  return await readUtf8(resolved);
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export const phasesCommand = defineCommand({
  meta: {
    name: 'phases',
    description: "Inspect or validate a feature's phase compilation without running it.",
  },
  subCommands: {
    compile: compileCommand,
    validate: validateCommand,
  },
});

export default phasesCommand;
