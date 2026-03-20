/**
 * TestProfile — describes the test language and framework used by the Test Runner container.
 *
 * Supported profiles: node-vitest | node-playwright | python-pytest | python-playwright | go-gotest | go-playwright | rust-rusttest | rust-playwright
 *
 * The profile is used by:
 *   - tests-catalog agent   → generates entrypoint paths with correct extension + naming
 *   - tests-coder agent     → generates test code in the correct language/framework
 *   - generateTests → copies the correct helpers/infra template files
 *   - parseTestScript (src/cli/utils.ts) → loads the profile's test.sh as the default test script
 */

import { join } from 'node:path';

import { getSaifRoot } from '../constants.js';
import { gotestProfile } from './go-gotest/profile.js';
import { goPlaywrightProfile } from './go-playwright/profile.js';
import { nodePlaywrightProfile } from './node-playwright/profile.js';
import { nodeVitestProfile } from './node-vitest/profile.js';
import { pythonPlaywrightProfile } from './python-playwright/profile.js';
import { pytestProfile } from './python-pytest/profile.js';
import { rustPlaywrightProfile } from './rust-playwright/profile.js';
import { rusttestProfile } from './rust-rusttest/profile.js';
import { SUPPORTED_PROFILE_IDS, type SupportedProfileId, type TestProfile } from './types.js';

export { type SupportedProfileId, type TestProfile } from './types.js';

export const SUPPORTED_PROFILES = {
  'node-vitest': nodeVitestProfile,
  'node-playwright': nodePlaywrightProfile,
  'python-pytest': pytestProfile,
  'python-playwright': pythonPlaywrightProfile,
  'go-gotest': gotestProfile,
  'go-playwright': goPlaywrightProfile,
  'rust-rusttest': rusttestProfile,
  'rust-playwright': rustPlaywrightProfile,
} satisfies Record<SupportedProfileId, TestProfile>;

/** Returns the default profile (node-vitest). */
export const DEFAULT_PROFILE: TestProfile = SUPPORTED_PROFILES['node-vitest'];

const _profilesDir = join(getSaifRoot(), 'src', 'test-profiles');

/**
 * Returns the absolute path to the test.sh script for the given profile id.
 * Used by the saifac CLI (`parseTestScript`) as the default `--test-script` when no override is provided.
 */
export function resolveTestScriptPath(profileId: SupportedProfileId): string {
  return join(_profilesDir, profileId, 'test.sh');
}

/**
 * Returns the absolute path to the Dockerfile for the given profile id.
 * Used when resolving the test-runner image / Dockerfile for a profile (see `parseTestImage` in CLI).
 */
export function resolveTestDockerfilePath(profileId: SupportedProfileId): string {
  return join(_profilesDir, profileId, 'Dockerfile');
}

/**
 * Looks up a profile by id. Throws a user-facing error for unsupported ids.
 */
export function resolveTestProfile(id: string): TestProfile {
  if (SUPPORTED_PROFILE_IDS.includes(id as SupportedProfileId)) {
    return SUPPORTED_PROFILES[id as keyof typeof SUPPORTED_PROFILES];
  }
  throw new Error(
    `Unsupported test profile "${id}". Supported profiles: ${SUPPORTED_PROFILE_IDS.join(', ')}.\n` +
      `To add a new language, open a PR adding templates under src/test-profiles/<id>/templates/.`,
  );
}
