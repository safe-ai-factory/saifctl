import type { AgentProfile } from '../types.js';

/** Agent profile for the OpenAI Codex CLI. */
export const codexProfile: AgentProfile = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  stdoutStrategy: null,
};
