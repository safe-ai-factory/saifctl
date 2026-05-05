/**
 * Scaffold the project-level tests directory at `<saifctlDir>/tests/`.
 *
 * Mirrors `src/config/scaffold.ts`'s shape (idempotent template-write into a
 * known location). Mirrors `src/design-tests/write.ts`'s template-resolution
 * path (read profile-shipped templates, skip when target file exists, force
 * to overwrite).
 *
 * Used by:
 *   - `saifctl init` (full bootstrap — config + project-level tests)
 *   - `saifctl init tests` (re-scaffold project-level tests only)
 *
 * Why this exists: every feature run has its `testScope.include` extended
 * with `<projectDir>/<saifctlDir>/tests` (see
 * `src/orchestrator/resolve-subtasks.ts`). Without scaffolded helpers/infra/
 * example, that path stays empty in real projects and the project-level
 * always-immutable suite (per release-readiness/D-07 / release-readiness/X-08) has no on-ramp. Scaffolding from
 * the same per-profile templates the feature dir uses keeps the two scopes
 * symmetrical.
 *
 * **Profile-switch handling (content-based detection).** Several profile
 * pairs share filenames (e.g. node-vitest and node-playwright both use
 * `helpers.ts` and `example.spec.ts`). The scaffolder reads each existing
 * file's contents and compares against every profile's shipped templates:
 *   - exact match for the requested profile → skip (true noop)
 *   - exact match for some *other* profile → silently swap to the requested
 *     profile's template (action `'switched'`); user has not edited it
 *   - no template match → user-edited; preserve unless `--force`
 * This prevents a stale node-vitest example.spec.ts from sticking around
 * after `init tests --test-profile=node-playwright` while still respecting
 * any handcrafted edits.
 *
 * See release-readiness/X-08-P6.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';
import { SUPPORTED_PROFILES, type TestProfile } from './index.js';
import { readProfileTemplate } from './templates.js';
import { SUPPORTED_PROFILE_IDS, type SupportedProfileId } from './types.js';

/** Options for {@link scaffoldGlobalTests}. */
export interface ScaffoldGlobalTestsOpts {
  saifctlDir: string;
  projectDir: string;
  testProfile: TestProfile;
  /**
   * Overwrite existing helpers / infra / example files instead of skipping
   * them. Required when the existing files have been edited (no template
   * match) and the user wants the requested profile's canonical content.
   * Also required to switch past the cross-language guard.
   */
  force: boolean;
}

/** Per-file outcome of a {@link scaffoldGlobalTests} run. */
export interface ScaffoldedFile {
  /** Absolute path of the file. */
  path: string;
  /** What the scaffolder did with this file on this run. */
  action: 'created' | 'overwritten' | 'skipped' | 'switched';
  /**
   * When `action === 'switched'`, the profile id whose template we replaced
   * (i.e. the existing file matched that profile's shipped template). When
   * `action === 'skipped'` and the file exists with no template match, this
   * is undefined and indicates user-edited content was preserved.
   */
  switchedFrom?: SupportedProfileId;
}

/** Result returned by {@link scaffoldGlobalTests}. */
export interface ScaffoldGlobalTestsResult {
  /** Absolute path to `<projectDir>/<saifctlDir>/tests/`. */
  testsDir: string;
  /** Files the scaffolder considered. Order: helpers → infra → example. */
  files: ScaffoldedFile[];
}

/** Detail payload for {@link CrossLanguageScaffoldError}. */
export interface CrossLanguageScaffoldErrorDetail {
  testsDir: string;
  conflictingFile: string;
  detectedProfileId: string;
  requestedProfileId: string;
}

/** Thrown when a tests dir already contains another profile's helpers (cross-language guard). */
export class CrossLanguageScaffoldError extends Error {
  public readonly testsDir: string;
  public readonly conflictingFile: string;
  public readonly detectedProfileId: string;
  public readonly requestedProfileId: string;

  constructor(detail: CrossLanguageScaffoldErrorDetail) {
    super(
      `Tests dir "${detail.testsDir}" already scaffolded for the "${detail.detectedProfileId}" profile ` +
        `("${detail.conflictingFile}" present). Pass --force to switch to "${detail.requestedProfileId}", ` +
        `or remove the existing files first.`,
    );
    this.name = 'CrossLanguageScaffoldError';
    this.testsDir = detail.testsDir;
    this.conflictingFile = detail.conflictingFile;
    this.detectedProfileId = detail.detectedProfileId;
    this.requestedProfileId = detail.requestedProfileId;
  }
}

/**
 * Scaffolds `<projectDir>/<saifctlDir>/tests/` with `helpersFilename`,
 * `infraFilename`, and `exampleFilename` from the given test profile's
 * templates.
 *
 * Idempotency uses content matching, not just existence:
 *   - file matches requested profile's template → `'skipped'` (true noop)
 *   - file matches another profile's template (unmodified) → `'switched'`
 *   - file has no template match (user-edited) → preserved as `'skipped'`
 *     unless `force: true`, then `'overwritten'`
 *   - file missing → `'created'`
 *
 * Cross-language guard: if any *other* test profile's `helpersFilename` is
 * already present in `<saifctlDir>/tests/` (e.g. `helpers.py` when the
 * caller asked for `node-vitest`), throws {@link CrossLanguageScaffoldError}
 * unless `force` is true. Prevents the silent footgun of mixed-language
 * test dirs that vitest/pytest/cargo/etc. would refuse to run as a unit.
 */
export async function scaffoldGlobalTests(
  opts: ScaffoldGlobalTestsOpts,
): Promise<ScaffoldGlobalTestsResult> {
  const { saifctlDir, projectDir, testProfile, force } = opts;
  const testsDir = resolve(projectDir, saifctlDir, 'tests');

  if (!force) {
    const conflict = await detectCrossLanguageConflict({ testsDir, requested: testProfile });
    if (conflict) {
      throw new CrossLanguageScaffoldError({
        testsDir,
        conflictingFile: conflict.filename,
        detectedProfileId: conflict.profileId,
        requestedProfileId: testProfile.id,
      });
    }
  }

  await mkdir(testsDir, { recursive: true });

  const files: ScaffoldedFile[] = [];
  files.push(
    await writeFromTemplate({
      profileId: testProfile.id,
      filename: testProfile.helpersFilename,
      testsDir,
      force,
    }),
  );
  if (testProfile.infraFilename) {
    files.push(
      await writeFromTemplate({
        profileId: testProfile.id,
        filename: testProfile.infraFilename,
        testsDir,
        force,
      }),
    );
  }
  files.push(
    await writeFromTemplate({
      profileId: testProfile.id,
      filename: testProfile.exampleFilename,
      testsDir,
      force,
    }),
  );

  return { testsDir, files };
}

interface WriteFromTemplateOpts {
  profileId: SupportedProfileId;
  filename: string;
  testsDir: string;
  force: boolean;
}

async function writeFromTemplate(opts: WriteFromTemplateOpts): Promise<ScaffoldedFile> {
  const filePath = resolve(opts.testsDir, opts.filename);
  const exists = await pathExists(filePath);
  const requestedTemplate = await readProfileTemplate(opts.profileId, opts.filename);

  if (!exists) {
    await writeUtf8(filePath, requestedTemplate);
    return { path: filePath, action: 'created' };
  }

  const existingContent = await readUtf8(filePath);

  if (existingContent === requestedTemplate) {
    return { path: filePath, action: 'skipped' };
  }

  if (opts.force) {
    await writeUtf8(filePath, requestedTemplate);
    return { path: filePath, action: 'overwritten' };
  }

  // Not the requested profile's template, no force. Is it some other
  // profile's unmodified template? If so, the user hasn't edited it and a
  // silent swap is the right call (e.g. node-vitest example.spec.ts → the
  // requested node-playwright variant).
  const originProfile = await detectTemplateOriginProfile({
    filename: opts.filename,
    content: existingContent,
    excludeProfile: opts.profileId,
  });
  if (originProfile !== null) {
    await writeUtf8(filePath, requestedTemplate);
    return { path: filePath, action: 'switched', switchedFrom: originProfile };
  }

  // User-edited content (no template match). Preserve.
  return { path: filePath, action: 'skipped' };
}

/**
 * Returns the supported profile id whose shipped template for `filename`
 * exactly matches `content`, or `null` if no profile's template matches.
 *
 * Used to detect "this file is an unmodified template from profile X" so the
 * scaffolder can safely overwrite it when switching to a different profile
 * that ships the same filename. `excludeProfile` skips the requested profile
 * (its template equality is checked separately by the caller).
 */
async function detectTemplateOriginProfile(opts: {
  filename: string;
  content: string;
  excludeProfile: SupportedProfileId;
}): Promise<SupportedProfileId | null> {
  for (const id of SUPPORTED_PROFILE_IDS) {
    if (id === opts.excludeProfile) continue;
    const profile = SUPPORTED_PROFILES[id];
    const profileFiles = [
      profile.helpersFilename,
      profile.infraFilename,
      profile.exampleFilename,
    ].filter((f): f is string => f !== null);
    if (!profileFiles.includes(opts.filename)) continue;
    try {
      const template = await readProfileTemplate(id, opts.filename);
      if (template === opts.content) return id;
    } catch {
      // Profile may not ship this filename — skip.
    }
  }
  return null;
}

interface CrossLanguageConflict {
  filename: string;
  profileId: string;
}

/**
 * Returns a conflict descriptor when a file matching another profile's
 * `helpersFilename` is present in the tests dir, or `null` if no conflict.
 *
 * Uses `helpersFilename` as the canonical fingerprint because it's the only
 * file every profile guarantees (`infraFilename` is nullable). When two
 * profiles share the same helpers filename (e.g. node-vitest +
 * node-playwright both use `helpers.ts`), the dir is treated as compatible
 * for either — the user can switch between same-filename profiles freely
 * (and `writeFromTemplate` handles the per-file content swap).
 */
async function detectCrossLanguageConflict(opts: {
  testsDir: string;
  requested: TestProfile;
}): Promise<CrossLanguageConflict | null> {
  for (const id of SUPPORTED_PROFILE_IDS) {
    const candidate = SUPPORTED_PROFILES[id];
    if (candidate.helpersFilename === opts.requested.helpersFilename) continue;
    const candidatePath = resolve(opts.testsDir, candidate.helpersFilename);
    if (await pathExists(candidatePath)) {
      return { filename: candidate.helpersFilename, profileId: candidate.id };
    }
  }
  return null;
}
