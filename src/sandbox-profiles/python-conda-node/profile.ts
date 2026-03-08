import type { SandboxProfile } from '../types.js';

export const pythonCondaNodeProfile: SandboxProfile = {
  id: 'python-conda-node',
  displayName: 'Python + Conda + Node.js',
  coderImageTag: 'factory-coder-python-conda-node:latest',
  stageImageTag: 'factory-stage-python-conda-node:latest',
};
