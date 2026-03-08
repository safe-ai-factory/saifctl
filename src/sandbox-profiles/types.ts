/**
 * SandboxProfile — describes the project's tech stack (language + package manager).
 *
 * Controls the default coder image, staging image, startup script, and stage
 * script used by the orchestrator. Each setting can be overridden individually
 * via the corresponding CLI flag.
 *
 * Supported profiles: go, go-node, go-node-python, go-python, node-bun, node-bun-python, node-npm, node-npm-python, node-pnpm, node-pnpm-python, node-yarn, node-yarn-python, python-conda, python-conda-node, python-pip, python-pip-node, python-poetry, python-poetry-node, python-uv, python-uv-node, rust, rust-node, rust-node-python, rust-python
 */

export interface SandboxProfile {
  /**
   * Profile identifier used in the --profile CLI flag.
   * One of the SUPPORTED_SANDBOX_PROFILE_IDS.
   */
  id: SupportedSandboxProfileId;

  /** Human-readable display name (e.g. "Node.js + pnpm"). */
  displayName: string;

  /**
   * Default Docker image tag for the coder (Leash) container.
   * Built from this profile's Dockerfile.coder.
   * Override with --coder-image.
   */
  coderImageTag: string;

  /**
   * Default Docker image tag for the staging container.
   * Built from this profile's Dockerfile.stage.
   * Override with --stage-image.
   */
  stageImageTag: string;
}

export const SUPPORTED_SANDBOX_PROFILE_IDS = [
  'go',
  'go-node',
  'go-node-python',
  'go-python',
  'node-bun',
  'node-bun-python',
  'node-npm',
  'node-npm-python',
  'node-pnpm',
  'node-pnpm-python',
  'node-yarn',
  'node-yarn-python',
  'python-conda',
  'python-conda-node',
  'python-pip',
  'python-pip-node',
  'python-poetry',
  'python-poetry-node',
  'python-uv',
  'python-uv-node',
  'rust',
  'rust-node',
  'rust-node-python',
  'rust-python',
] as const;
export type SupportedSandboxProfileId = (typeof SUPPORTED_SANDBOX_PROFILE_IDS)[number];
