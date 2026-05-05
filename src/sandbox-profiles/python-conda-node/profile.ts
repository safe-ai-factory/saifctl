import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python (Conda) + Node.js projects. */
export const pythonCondaNodeProfile: SandboxProfile = {
  id: 'python-conda-node',
  displayName: 'Python + Conda + Node.js',
  coderImageTag: 'saifctl-coder-python-conda-node:latest',
};
