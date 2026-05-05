/**
 * Zod schemas for `feature.yml` and `phase.yml`.
 *
 * See safe-ai-factory/TODO_phases_and_critics.md §5 for the full spec.
 *
 * Schemas validate shape only. Inheritance resolution and cross-file validation
 * (e.g. referenced critic id exists) live in load.ts and discover.ts.
 *
 * Notes on intentional design:
 * - `critics` is left optional with no default — `undefined` is meaningful: it
 *   triggers the "run all critics found in critics/" fallback at resolve time.
 *   `[]` (explicit empty list) means "run no critics."
 * - `tests.mutable`, `tests.fail2pass`, `tests.enforce` are NOT defaulted in
 *   the schema; the resolver applies built-in defaults so we can detect
 *   "explicitly set" vs "inherited" if needed.
 * - `tests.enforce: 'read-only'` parses successfully here so users can
 *   future-proof their config files. The cross-validator (`validatePhaseGraph`)
 *   rejects it as "not implemented in this release" until v2 lands.
 */

import { z } from 'zod';

/** Phase ids: lowercase kebab/snake, must not start with `(` (route-group reserved). */
const PHASE_ID_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

const phaseIdSchema = z
  .string()
  .min(1, 'phase id must be non-empty')
  .regex(
    PHASE_ID_REGEX,
    'phase id must match /^[a-z0-9][a-z0-9_-]*$/ (lowercase, digits, hyphens, underscores)',
  )
  .refine((s) => !s.startsWith('('), {
    message: 'phase id must not start with `(` (reserved for Next.js-style route groups)',
  });

/** Critic ids: same charset rules as phase ids. */
const criticIdSchema = z
  .string()
  .min(1, 'critic id must be non-empty')
  .regex(
    PHASE_ID_REGEX,
    'critic id must match /^[a-z0-9][a-z0-9_-]*$/ (lowercase, digits, hyphens, underscores)',
  );

/**
 * One critic invocation entry. `rounds` defaults to 1 (one subtask) per §9.
 *
 * `id` matches a filename (sans `.md`) under `critics/`. Cross-checked at
 * validate-time in discover.ts.
 */
export const criticEntrySchema = z
  .object({
    id: criticIdSchema,
    rounds: z.number().int().min(1).default(1),
  })
  .strict();

export type CriticEntry = z.infer<typeof criticEntrySchema>;

/**
 * Test mutability + fail2pass + enforcement config. Applies at feature scope and
 * phase scope; resolution rules per §5.3 / §5.6.
 *
 * `immutable-files` are globs relative to the feature directory. Globs containing
 * `..` segments or absolute paths are rejected for safety.
 */
export const testsConfigSchema = z
  .object({
    mutable: z.boolean().optional(),
    fail2pass: z.boolean().optional(),
    enforce: z.enum(['diff-inspection', 'read-only']).optional(),
    'immutable-files': z
      .array(
        z
          .string()
          .min(1)
          .refine((g) => !g.includes('..') && !g.startsWith('/'), {
            message:
              'immutable-files globs must be relative to the feature dir; no `..` segments, no absolute paths',
          }),
      )
      .optional(),
  })
  .strict();

export type TestsConfig = z.infer<typeof testsConfigSchema>;

/**
 * Per-phase configuration. Same shape used by:
 *   - `phases/<id>/phase.yml` (file)
 *   - `feature.yml.phases.defaults` (block)
 *   - `feature.yml.phases.phases.<id>` (inline override per §10.3)
 *
 * `critics:` declared here REPLACES inherited list entirely (no key-level merge).
 *
 * `spec` is a path relative to the phase directory; defaults to `spec.md` at
 * resolve time.
 */
export const phaseConfigSchema = z
  .object({
    critics: z.array(criticEntrySchema).optional(),
    spec: z
      .string()
      .min(1)
      .refine((s) => !s.includes('..') && !s.startsWith('/'), {
        message:
          'spec must be a path relative to the phase dir; no `..` segments, no absolute paths',
      })
      .optional(),
    tests: testsConfigSchema.optional(),
  })
  .strict();

export type PhaseConfig = z.infer<typeof phaseConfigSchema>;

/**
 * The `phases:` block inside `feature.yml`. Only meaningful when a `phases/` dir
 * exists; absence-of-dir is checked in discover.ts.
 *
 * - `order`: optional explicit ordering (overrides lexicographic default).
 *   Each entry must be a valid phase id.
 * - `defaults`: per-phase config inherited by every phase that doesn't override.
 * - `phases`: inline per-phase config map. Per-phase `phase.yml` files win
 *   when both exist. Map keys must be valid phase ids.
 */
const featurePhasesBlockSchema = z
  .object({
    order: z.array(phaseIdSchema).optional(),
    defaults: phaseConfigSchema.optional(),
    phases: z.record(phaseIdSchema, phaseConfigSchema).optional(),
  })
  .strict();

/**
 * Schema for `feature.yml`.
 *
 * - `critics` at this scope: default critic selection (used in no-phases mode,
 *   or as fallback in phased mode if neither `phases.defaults.critics` nor
 *   `phase.yml.critics` is set). Same "undefined = run all" rule applies.
 * - `tests` at this scope: feature-level mutability config. Applies to
 *   `features/<feat>/tests/`.
 * - `phases`: meaningful only when a `phases/` dir exists.
 */
export const featureConfigSchema = z
  .object({
    critics: z.array(criticEntrySchema).optional(),
    tests: testsConfigSchema.optional(),
    phases: featurePhasesBlockSchema.optional(),
  })
  .strict();

export type FeatureConfig = z.infer<typeof featureConfigSchema>;
