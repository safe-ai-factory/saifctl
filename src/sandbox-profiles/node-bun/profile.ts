import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js projects using the Bun package manager. */
export const nodeBunProfile: SandboxProfile = {
  id: 'node-bun',
  displayName: 'Node.js + Bun',
  coderImageTag: 'saifctl-coder-node-bun:latest',
};
