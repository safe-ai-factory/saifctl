import type { AgentProfile } from '../types.js';

/** Agent profile for the GitHub Copilot CLI. */
export const copilotProfile: AgentProfile = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  stdoutStrategy: null,
};
