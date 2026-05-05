/**
 * Read template files shipped under `src/test-profiles/<profileId>/templates/`.
 *
 * Used by both:
 *   - {@link generateTests} (per-feature scaffolding via `saifctl feat design-tests`)
 *   - {@link scaffoldGlobalTests} (project-level scaffolding via `saifctl init` /
 *     `saifctl init tests`).
 *
 * Lifted out of `src/design-tests/write.ts` so the scaffolding for the
 * project-level always-immutable suite (saifctl/tests/) reuses the same
 * file-resolution path. See specification.md §10 (X08-P6).
 */
import { join } from 'node:path';

import { getSaifctlRoot } from '../constants.js';
import { readUtf8 } from '../utils/io.js';

const _profilesDir = join(getSaifctlRoot(), 'src', 'test-profiles');

/** Reads a template file from `src/test-profiles/<profileId>/templates/<filename>`. */
export async function readProfileTemplate(profileId: string, filename: string): Promise<string> {
  return readUtf8(join(_profilesDir, profileId, 'templates', filename));
}
