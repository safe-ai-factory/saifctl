import type { AgentProfile } from '../types.js';

/** Agent profile for the debug agent (no LLM); used in tests and dry runs. */
export const debugProfile: AgentProfile = {
  id: 'debug',
  displayName: 'Debug (no LLM)',
  stdoutStrategy: null,
};
