import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Node.js (Yarn) + Python projects. */
export const nodeYarnPythonProfile: SandboxProfile = {
  id: 'node-yarn-python',
  displayName: 'Node.js + Yarn + Python',
  coderImageTag: 'saifctl-coder-node-yarn-python:latest',
};
