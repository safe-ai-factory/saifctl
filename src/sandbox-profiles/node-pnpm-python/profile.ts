import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js (pnpm) + Python projects. */
export const nodePnpmPythonProfile: SandboxProfile = {
  id: 'node-pnpm-python',
  displayName: 'Node.js + pnpm + Python',
  coderImageTag: 'saifctl-coder-node-pnpm-python:latest',
};
