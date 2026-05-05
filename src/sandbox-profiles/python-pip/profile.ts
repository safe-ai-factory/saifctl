import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python projects using the pip package manager. */
export const pythonPipProfile: SandboxProfile = {
  id: 'python-pip',
  displayName: 'Python + pip',
  coderImageTag: 'saifctl-coder-python-pip:latest',
};
