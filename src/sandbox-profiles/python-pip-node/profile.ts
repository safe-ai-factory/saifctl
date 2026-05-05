import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python (pip) + Node.js projects. */
export const pythonPipNodeProfile: SandboxProfile = {
  id: 'python-pip-node',
  displayName: 'Python + pip + Node.js',
  coderImageTag: 'saifctl-coder-python-pip-node:latest',
};
