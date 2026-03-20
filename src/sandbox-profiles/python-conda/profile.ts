import type { SandboxProfile } from '../types.js';

export const pythonCondaProfile: SandboxProfile = {
  id: 'python-conda',
  displayName: 'Python + Conda',
  coderImageTag: 'saifac-coder-python-conda:latest',
  stageImageTag: 'saifac-stage-python-conda:latest',
};
