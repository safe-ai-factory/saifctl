import type { AgentProfile } from '../types.js';

/** Agent profile for Google's Gemini CLI. */
export const geminiProfile: AgentProfile = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  stdoutStrategy: null,
};
