import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js projects using the pnpm package manager. */
export const nodePnpmProfile: SandboxProfile = {
  id: 'node-pnpm',
  displayName: 'Node.js + pnpm',
  coderImageTag: 'saifctl-coder-node-pnpm:latest',
};
