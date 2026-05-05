import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python projects using the uv package manager. */
export const pythonUvProfile: SandboxProfile = {
  id: 'python-uv',
  displayName: 'Python + uv',
  coderImageTag: 'saifctl-coder-python-uv:latest',
};
