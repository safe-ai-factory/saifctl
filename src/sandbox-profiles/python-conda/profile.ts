import type { SandboxProfile } from '../types.js';

export const pythonCondaProfile: SandboxProfile = {
  id: 'python-conda',
  displayName: 'Python + Conda',
  coderImageTag: 'factory-coder-python-conda:latest',
  stageImageTag: 'factory-stage-python-conda:latest',
};
