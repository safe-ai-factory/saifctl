import type { SandboxProfile } from '../types.js';

/** Sandbox profile for Go-only projects. */
export const goProfile: SandboxProfile = {
  id: 'go',
  displayName: 'Go',
  coderImageTag: 'saifctl-coder-go:latest',
};
