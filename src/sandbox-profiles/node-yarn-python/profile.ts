import type { SandboxProfile } from '../types.js';

export const nodeYarnPythonProfile: SandboxProfile = {
  id: 'node-yarn-python',
  displayName: 'Node.js + Yarn + Python',
  coderImageTag: 'factory-coder-node-yarn-python:latest',
  stageImageTag: 'factory-stage-node-yarn-python:latest',
};
