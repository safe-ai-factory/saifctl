import type { SandboxProfile } from '../types.js';

export const nodeYarnProfile: SandboxProfile = {
  id: 'node-yarn',
  displayName: 'Node.js + Yarn',
  coderImageTag: 'factory-coder-node-yarn:latest',
  stageImageTag: 'factory-stage-node-yarn:latest',
};
