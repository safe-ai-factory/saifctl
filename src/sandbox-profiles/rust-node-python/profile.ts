import type { SandboxProfile } from '../types.js';

export const rustNodePythonProfile: SandboxProfile = {
  id: 'rust-node-python',
  displayName: 'Rust + Node.js + Python',
  coderImageTag: 'factory-coder-rust-node-python:latest',
  stageImageTag: 'factory-stage-rust-node-python:latest',
};
