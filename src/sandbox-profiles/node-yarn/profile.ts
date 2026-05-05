import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js projects using the Yarn package manager. */
export const nodeYarnProfile: SandboxProfile = {
  id: 'node-yarn',
  displayName: 'Node.js + Yarn',
  coderImageTag: 'saifctl-coder-node-yarn:latest',
};
