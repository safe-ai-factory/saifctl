import type { SandboxProfile } from '../types.js';

export const rustPythonProfile: SandboxProfile = {
  id: 'rust-python',
  displayName: 'Rust + Python',
  coderImageTag: 'factory-coder-rust-python:latest',
  stageImageTag: 'factory-stage-rust-python:latest',
};
