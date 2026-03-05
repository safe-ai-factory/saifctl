import type { StackProfile } from '../types.js';

export const pythonCondaProfile: StackProfile = {
  id: 'python-conda',
  displayName: 'Python + Conda',
  coderImageTag: 'factory-coder-python-conda:latest',
  stageImageTag: 'factory-stage-python-conda:latest',
};
