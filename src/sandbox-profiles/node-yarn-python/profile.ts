import type { SandboxProfile } from '../types.js';

export const nodeYarnPythonProfile: SandboxProfile = {
  id: 'node-yarn-python',
  displayName: 'Node.js + Yarn + Python',
  coderImageTag: 'saifac-coder-node-yarn-python:latest',
  stageImageTag: 'saifac-stage-node-yarn-python:latest',
};
