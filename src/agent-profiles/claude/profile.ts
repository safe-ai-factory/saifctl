import type { AgentProfile } from '../types.js';

/** Agent profile for Anthropic's Claude Code CLI. */
export const claudeProfile: AgentProfile = {
  id: 'claude',
  displayName: 'Claude Code',
  stdoutStrategy: null,
};
