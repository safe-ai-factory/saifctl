/**
 * Filesystem discovery + cross-validation for phases & critics.
 *
 * - `discoverPhases(featureDir)` — scans `phases/<id>/` dirs, returns ids in
 *   lexicographic order. Validates each id against the phase-id charset.
 * - `discoverCritics(featureDir)` — scans `critics/<id>.md` files, returns ids.
 * - `validatePhaseGraph(...)` — runs every cross-file check we can do without
 *   actually running anything: referenced critic ids exist, referenced phase ids
 *   exist, mutually-exclusive subtask sources don't coexist, etc.
 *
 * No execution — purely structural. CLI surface (`feat phases validate`) lives
 * in Block 6 and calls into here.
 */

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { pathExists } from '../../utils/io.js';
import { type CriticEntry, type FeatureConfig, type PhaseConfig } from './schema.js';

/** Phase id charset (mirrors schema.ts). Reject route-group syntax. */
const PHASE_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

/** Critic file extension (only `.md` for v1). */
const CRITIC_FILE_EXT = '.md';

/** A phase directory found on disk. */
export interface DiscoveredPhase {
  id: string;
  /** Absolute path to the phase dir. */
  absolutePath: string;
}

/** A critic prompt template found on disk. */
export interface DiscoveredCritic {
  id: string;
  /** Absolute path to the critic .md file. */
  absolutePath: string;
}

/**
 * Discover phases under `<featureDir>/phases/`.
 *
 * Returns the discovered phases in lexicographic order by id. Skips files
 * (only directories count) and dirs whose name starts with `_` (reserved for
 * examples / documentation, mirroring our convention for feature dirs).
 *
 * Dirs with names that don't match the phase-id charset are NOT silently
 * skipped — they're returned in `invalidIds` and surfaced as **errors** by
 * `validatePhaseGraph`. The validator treats invalid filesystem names as
 * fatal so typos can't quietly drop a phase from a run.
 *
 * Returns `[]` (and no error) when `phases/` doesn't exist — callers use that
 * absence to detect "non-phased feature."
 */
export async function discoverPhases(featureDir: string): Promise<{
  phases: DiscoveredPhase[];
  invalidIds: string[];
}> {
  const phasesDir = join(featureDir, 'phases');
  if (!(await pathExists(phasesDir))) {
    return { phases: [], invalidIds: [] };
  }

  const entries = await readdir(phasesDir, { withFileTypes: true });
  const phases: DiscoveredPhase[] = [];
  const invalidIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    if (!PHASE_ID_REGEX.test(entry.name) || entry.name.startsWith('(')) {
      invalidIds.push(entry.name);
      continue;
    }
    phases.push({
      id: entry.name,
      absolutePath: join(phasesDir, entry.name),
    });
  }
  phases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { phases, invalidIds };
}

/**
 * Discover critics under `<featureDir>/critics/*.md`.
 *
 * Returns `[]` when `critics/` doesn't exist. Files not ending in `.md` are
 * silently ignored. Files whose name (or id, sans `.md`) starts with `_` are
 * also silently ignored — reserved for documentation that lives next to the
 * critics (e.g. `_README.md`, `_template.md`). This mirrors the `_`-prefix
 * convention used by phase-dir discovery.
 *
 * Files whose id (filename minus `.md`) doesn't match the critic-id charset
 * are NOT silently skipped — they're returned in `invalidIds` (as bare ids,
 * not full filenames; the validator reformats with the `.md` suffix in error
 * messages) and surfaced as **errors** by `validatePhaseGraph`.
 */
export async function discoverCritics(featureDir: string): Promise<{
  critics: DiscoveredCritic[];
  invalidIds: string[];
}> {
  const criticsDir = join(featureDir, 'critics');
  if (!(await pathExists(criticsDir))) {
    return { critics: [], invalidIds: [] };
  }

  const entries = await readdir(criticsDir, { withFileTypes: true });
  const critics: DiscoveredCritic[] = [];
  const invalidIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(CRITIC_FILE_EXT)) continue;
    if (entry.name.startsWith('_')) continue;
    const id = entry.name.slice(0, -CRITIC_FILE_EXT.length);
    if (!PHASE_ID_REGEX.test(id)) {
      invalidIds.push(id);
      continue;
    }
    critics.push({
      id,
      absolutePath: join(criticsDir, entry.name),
    });
  }
  critics.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { critics, invalidIds };
}

/**
 * Result of validating one feature's phase/critic graph against its config.
 *
 * Errors must be fixed before running. Warnings are advisory — they do NOT
 * block compilation, but `feat phases validate` and the `feat run` pre-flight
 * print them so the user sees them. v1 has no warning sources yet (the
 * documented future use is glob-expansion empty-match warnings); the field
 * is still required on every report so callers can iterate it without
 * branching.
 */
export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export interface ValidationInput {
  /** Absolute feature dir; the basename is prepended to every error message. */
  featureDir: string;
  featureConfig: FeatureConfig | null;
  /** Map of phaseId → loaded phase.yml (or null when no file). */
  phaseConfigs: Map<string, PhaseConfig | null>;
  discoveredPhases: DiscoveredPhase[];
  discoveredCritics: DiscoveredCritic[];
  /** Invalid phase / critic ids surfaced by discovery (re-emitted as errors). */
  invalidPhaseIds: string[];
  invalidCriticIds: string[];
  /**
   * Whether `subtasks.json` is also present alongside `phases/` (mutual-exclusion check).
   * Caller computes this; we don't re-stat the filesystem here.
   */
  subtasksJsonPresent: boolean;
}

/**
 * Run every cross-file structural check. Returns a report; never throws.
 *
 * Errors:
 * - Phase id with invalid charset on disk.
 * - Critic id with invalid charset on disk.
 * - `feature.yml.phases.order` references an unknown phase.
 * - `feature.yml.phases.phases.<id>` keys an unknown phase.
 * - Any `critics: [{id}]` references an unknown critic.
 * - `feature.yml.phases` set but no `phases/` dir present.
 * - `phases/` dir present AND `subtasks.json` present (mutually exclusive).
 * - `tests.enforce: 'read-only'` set anywhere — schema parses it (so users can
 *   future-proof their config) but Block 7 ships only `diff-inspection`.
 */
export function validatePhaseGraph(input: ValidationInput): ValidationReport {
  const errors: string[] = [];
  // Block 6: warnings are surfaced by `feat phases validate` but never block
  // compilation. No source emits warnings in v1 — kept here so the array is
  // always present on the report.
  const warnings: string[] = [];
  const {
    featureDir,
    featureConfig,
    phaseConfigs,
    discoveredPhases,
    discoveredCritics,
    invalidPhaseIds,
    invalidCriticIds,
    subtasksJsonPresent,
  } = input;

  const featureLabel = `[feature '${basename(featureDir)}']`;
  const push = (msg: string): void => {
    errors.push(`${featureLabel} ${msg}`);
  };

  for (const id of invalidPhaseIds) {
    push(
      `Invalid phase dir name '${id}' under phases/ — must match /^[a-z0-9][a-z0-9_-]*$/ (lowercase, digits, hyphens, underscores) and not start with '('`,
    );
  }
  for (const id of invalidCriticIds) {
    push(
      `Invalid critic file name '${id}.md' under critics/ — id (filename minus .md) must match /^[a-z0-9][a-z0-9_-]*$/`,
    );
  }

  const phaseIdSet = new Set(discoveredPhases.map((p) => p.id));
  const criticIdSet = new Set(discoveredCritics.map((c) => c.id));

  // Mutual exclusion: phases/ XOR subtasks.json (XOR plain plan-only).
  if (discoveredPhases.length > 0 && subtasksJsonPresent) {
    push(
      'Both phases/ and subtasks.json are present in the feature dir; these are mutually exclusive — pick one.',
    );
  }

  // feature.yml.phases set but no phases/ dir.
  if (featureConfig?.phases !== undefined && discoveredPhases.length === 0) {
    push(
      'feature.yml has a `phases:` section but no phases/ directory exists — either remove the section or create phases/<id>/ directories.',
    );
  }

  // feature.yml.phases.order references unknown phases.
  const explicitOrder = featureConfig?.phases?.order;
  for (const id of explicitOrder ?? []) {
    if (!phaseIdSet.has(id)) {
      push(`feature.yml.phases.order references unknown phase '${id}' (not found under phases/)`);
    }
  }

  // Symmetric check: when an explicit `order` is set, every discovered phase
  // must appear in it. Otherwise the missing phase is silently dropped from
  // the run — exactly the "skipped/dropped nuance" footgun callers care about.
  if (explicitOrder && explicitOrder.length > 0) {
    const orderSet = new Set(explicitOrder);
    const dropped = discoveredPhases.map((p) => p.id).filter((id) => !orderSet.has(id));
    if (dropped.length > 0) {
      push(
        `feature.yml.phases.order omits discovered phase(s) ${dropped
          .map((id) => `'${id}'`)
          .join(', ')} — every dir under phases/ must appear in order, or be removed from disk.`,
      );
    }
  }

  // feature.yml.phases.phases.<id> references unknown phases.
  for (const id of Object.keys(featureConfig?.phases?.phases ?? {})) {
    if (!phaseIdSet.has(id)) {
      push(
        `feature.yml.phases.phases.${id} references unknown phase '${id}' (not found under phases/)`,
      );
    }
  }

  // Critic references — collected from all config layers.
  const criticRefs: { from: string; entries: CriticEntry[] }[] = [];
  if (featureConfig?.critics) {
    criticRefs.push({ from: 'feature.yml.critics', entries: featureConfig.critics });
  }
  if (featureConfig?.phases?.defaults?.critics) {
    criticRefs.push({
      from: 'feature.yml.phases.defaults.critics',
      entries: featureConfig.phases.defaults.critics,
    });
  }
  for (const [pid, pc] of Object.entries(featureConfig?.phases?.phases ?? {})) {
    if (pc?.critics) {
      criticRefs.push({ from: `feature.yml.phases.phases.${pid}.critics`, entries: pc.critics });
    }
  }
  for (const [pid, pc] of phaseConfigs) {
    if (pc?.critics) {
      criticRefs.push({ from: `phases/${pid}/phase.yml#critics`, entries: pc.critics });
    }
  }
  for (const ref of criticRefs) {
    const seen = new Set<string>();
    for (const c of ref.entries) {
      if (!criticIdSet.has(c.id)) {
        push(`${ref.from} references unknown critic '${c.id}' (no critics/${c.id}.md found)`);
      }
      // Duplicate id within the same critics list. Each critic entry has its
      // own `rounds` field, so a duplicate is almost always a copy-paste bug;
      // collapse vs. concatenate is ambiguous, so reject and let the user
      // pick a single intended `rounds` value.
      if (seen.has(c.id)) {
        push(`${ref.from} lists critic '${c.id}' more than once — set \`rounds\` instead.`);
      }
      seen.add(c.id);
    }
  }

  // tests.enforce: 'read-only' is parsed by the schema (for future-proofing)
  // but rejected here — Block 7 only ships diff-inspection in v1.
  const enforceRefs: { from: string; enforce: string | undefined }[] = [
    { from: 'feature.yml.tests.enforce', enforce: featureConfig?.tests?.enforce },
    {
      from: 'feature.yml.phases.defaults.tests.enforce',
      enforce: featureConfig?.phases?.defaults?.tests?.enforce,
    },
  ];
  for (const [pid, pc] of Object.entries(featureConfig?.phases?.phases ?? {})) {
    enforceRefs.push({
      from: `feature.yml.phases.phases.${pid}.tests.enforce`,
      enforce: pc?.tests?.enforce,
    });
  }
  for (const [pid, pc] of phaseConfigs) {
    enforceRefs.push({
      from: `phases/${pid}/phase.yml#tests.enforce`,
      enforce: pc?.tests?.enforce,
    });
  }
  for (const ref of enforceRefs) {
    if (ref.enforce === 'read-only') {
      push(
        `${ref.from}: 'read-only' is documented for v2 but not yet implemented; use 'diff-inspection'`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Effective phase order: explicit `feature.yml.phases.order` if set, otherwise
 * the lexicographic order of `discoveredPhases`. Missing / extra ids are
 * caught by `validatePhaseGraph` — this function trusts its inputs.
 *
 * `discoverPhases` already returns lex-sorted, but we re-sort the fallback
 * defensively so future callers that build `discoveredPhases` by some other
 * route can't accidentally produce a non-deterministic order.
 */
export function effectivePhaseOrder(opts: {
  featureConfig: FeatureConfig | null;
  discoveredPhases: DiscoveredPhase[];
}): string[] {
  const explicit = opts.featureConfig?.phases?.order;
  if (explicit && explicit.length > 0) return [...explicit];
  const ids = opts.discoveredPhases.map((p) => p.id);
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids;
}
