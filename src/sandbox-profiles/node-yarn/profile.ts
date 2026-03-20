import type { SandboxProfile } from '../types.js';

export const nodeYarnProfile: SandboxProfile = {
  id: 'node-yarn',
  displayName: 'Node.js + Yarn',
  coderImageTag: 'saifac-coder-node-yarn:latest',
  stageImageTag: 'saifac-stage-node-yarn:latest',
};
