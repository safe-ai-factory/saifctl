import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Rust-only projects. */
export const rustProfile: SandboxProfile = {
  id: 'rust',
  displayName: 'Rust',
  coderImageTag: 'saifctl-coder-rust:latest',
};
