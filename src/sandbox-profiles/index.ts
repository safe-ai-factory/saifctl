/**
 * SandboxProfile — describes the project's tech stack (language + package manager).
 *
 * Supported profiles: go, go-node, go-node-python, go-python, node-bun, node-bun-python, node-npm, node-npm-python, node-pnpm, node-pnpm-python, node-yarn, node-yarn-python, python-conda, python-conda-node, python-pip, python-pip-node, python-poetry, python-poetry-node, python-uv, python-uv-node, rust, rust-node, rust-node-python, rust-python
 *
 * Each profile directory contains:
 *   - profile.ts        → SandboxProfile metadata (id, displayName, image tag)
 *   - Dockerfile.coder  → image used for both the coder and staging containers
 *   - startup.sh        → installs workspace deps (used by both coder and staging containers)
 *   - stage.sh          → starts the app (or keeps the container alive for CLI-only projects)
 *   - gate.sh           → validates the workspace after each agent round (language-specific checks)
 */

import { join } from 'node:path';

import { getSaifctlRoot } from '../constants.js';
import { pathExists, readUtf8 } from '../utils/io.js';
import { goProfile } from './go/profile.js';
import { goNodeProfile } from './go-node/profile.js';
import { goNodePythonProfile } from './go-node-python/profile.js';
import { goPythonProfile } from './go-python/profile.js';
import { nodeBunProfile } from './node-bun/profile.js';
import { nodeBunPythonProfile } from './node-bun-python/profile.js';
import { nodeNpmProfile } from './node-npm/profile.js';
import { nodeNpmPythonProfile } from './node-npm-python/profile.js';
import { nodePnpmProfile } from './node-pnpm/profile.js';
import { nodePnpmPythonProfile } from './node-pnpm-python/profile.js';
import { nodeYarnProfile } from './node-yarn/profile.js';
import { nodeYarnPythonProfile } from './node-yarn-python/profile.js';
import { pythonCondaProfile } from './python-conda/profile.js';
import { pythonCondaNodeProfile } from './python-conda-node/profile.js';
import { pythonPipProfile } from './python-pip/profile.js';
import { pythonPipNodeProfile } from './python-pip-node/profile.js';
import { pythonPoetryProfile } from './python-poetry/profile.js';
import { pythonPoetryNodeProfile } from './python-poetry-node/profile.js';
import { pythonUvProfile } from './python-uv/profile.js';
import { pythonUvNodeProfile } from './python-uv-node/profile.js';
import { rustProfile } from './rust/profile.js';
import { rustNodeProfile } from './rust-node/profile.js';
import { rustNodePythonProfile } from './rust-node-python/profile.js';
import { rustPythonProfile } from './rust-python/profile.js';
import {
  type SandboxProfile,
  SUPPORTED_SANDBOX_PROFILE_IDS,
  type SupportedSandboxProfileId,
} from './types.js';

export { type SandboxProfile, type SupportedSandboxProfileId } from './types.js';

export const SUPPORTED_SANDBOX_PROFILES = {
  go: goProfile,
  'go-node': goNodeProfile,
  'go-node-python': goNodePythonProfile,
  'go-python': goPythonProfile,
  'node-bun': nodeBunProfile,
  'node-bun-python': nodeBunPythonProfile,
  'node-npm': nodeNpmProfile,
  'node-npm-python': nodeNpmPythonProfile,
  'node-pnpm': nodePnpmProfile,
  'node-pnpm-python': nodePnpmPythonProfile,
  'node-yarn': nodeYarnProfile,
  'node-yarn-python': nodeYarnPythonProfile,
  'python-conda': pythonCondaProfile,
  'python-conda-node': pythonCondaNodeProfile,
  'python-pip': pythonPipProfile,
  'python-pip-node': pythonPipNodeProfile,
  'python-poetry': pythonPoetryProfile,
  'python-poetry-node': pythonPoetryNodeProfile,
  'python-uv': pythonUvProfile,
  'python-uv-node': pythonUvNodeProfile,
  rust: rustProfile,
  'rust-node': rustNodeProfile,
  'rust-node-python': rustNodePythonProfile,
  'rust-python': rustPythonProfile,
} satisfies Record<SupportedSandboxProfileId, SandboxProfile>;

/** Default sandbox profile (node-pnpm-python). */
export const DEFAULT_SANDBOX_PROFILE: SandboxProfile =
  SUPPORTED_SANDBOX_PROFILES['node-pnpm-python'];

const _sandboxProfilesDir = join(getSaifctlRoot(), 'src', 'sandbox-profiles');

/** Returns the absolute path to Dockerfile.coder for the given profile id. */
export function resolveSandboxCoderDockerfilePath(profileId: SupportedSandboxProfileId): string {
  return join(_sandboxProfilesDir, profileId, 'Dockerfile.coder');
}

/** Absolute path to startup.sh for the given sandbox profile. */
export function resolveSandboxStartupScriptPath(profileId: SupportedSandboxProfileId): string {
  return join(_sandboxProfilesDir, profileId, 'startup.sh');
}

/** Absolute path to stage.sh for the given sandbox profile. */
export function resolveSandboxStageScriptPath(profileId: SupportedSandboxProfileId): string {
  return join(_sandboxProfilesDir, profileId, 'stage.sh');
}

/** Absolute path to gate.sh for the given sandbox profile. */
export function resolveSandboxGateScriptPath(profileId: SupportedSandboxProfileId): string {
  return join(_sandboxProfilesDir, profileId, 'gate.sh');
}

/** Reads and returns the content of startup.sh for the given profile id. */
export async function readSandboxStartupScript(
  profileId: SupportedSandboxProfileId,
): Promise<string> {
  const filepath = resolveSandboxStartupScriptPath(profileId);
  if (!(await pathExists(filepath))) {
    throw new Error(`Startup script not found for profile ${profileId}: ${filepath}`);
  }
  return readUtf8(filepath);
}

/** Reads and returns the content of stage.sh for the given profile id. */
export async function readSandboxStageScript(
  profileId: SupportedSandboxProfileId,
): Promise<string> {
  const filepath = resolveSandboxStageScriptPath(profileId);
  if (!(await pathExists(filepath))) {
    throw new Error(`Stage script not found for profile ${profileId}: ${filepath}`);
  }
  return readUtf8(filepath);
}

/** Reads and returns the content of gate.sh for the given profile id. */
export async function readSandboxGateScript(profileId: SupportedSandboxProfileId): Promise<string> {
  const filepath = resolveSandboxGateScriptPath(profileId);
  if (!(await pathExists(filepath))) {
    throw new Error(`Gate script not found for profile ${profileId}: ${filepath}`);
  }
  return readUtf8(filepath);
}

/**
 * Looks up a sandbox profile by id. Throws a user-facing error for unsupported ids.
 */
export function resolveSandboxProfile(id: string): SandboxProfile {
  if (SUPPORTED_SANDBOX_PROFILE_IDS.includes(id as SupportedSandboxProfileId)) {
    return SUPPORTED_SANDBOX_PROFILES[id as SupportedSandboxProfileId];
  }
  throw new Error(
    `Unsupported sandbox profile "${id}". Supported profiles: ${SUPPORTED_SANDBOX_PROFILE_IDS.join(', ')}.\n` +
      `To use a custom sandbox, supply --startup-script, --stage-script, and --coder-image instead.`,
  );
}
