import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python projects using the Conda package manager. */
export const pythonCondaProfile: SandboxProfile = {
  id: 'python-conda',
  displayName: 'Python + Conda',
  coderImageTag: 'saifctl-coder-python-conda:latest',
};
