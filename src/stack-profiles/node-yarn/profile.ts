import type { StackProfile } from '../types.js';

export const nodeYarnProfile: StackProfile = {
  id: 'node-yarn',
  displayName: 'Node.js + Yarn',
  coderImageTag: 'factory-coder-node-yarn:latest',
  stageImageTag: 'factory-stage-node-yarn:latest',
};
