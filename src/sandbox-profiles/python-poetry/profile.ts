import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Python projects using the Poetry package manager. */
export const pythonPoetryProfile: SandboxProfile = {
  id: 'python-poetry',
  displayName: 'Python + Poetry',
  coderImageTag: 'saifctl-coder-python-poetry:latest',
};
