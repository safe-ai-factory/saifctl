import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js projects using the npm package manager. */
export const nodeNpmProfile: SandboxProfile = {
  id: 'node-npm',
  displayName: 'Node.js + npm',
  coderImageTag: 'saifctl-coder-node-npm:latest',
};
