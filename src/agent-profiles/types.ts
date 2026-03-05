/**
 * AgentProfile — describes a coding agent and its runtime requirements.
 *
 * Supported profiles: openhands | aider | claude | codex | gemini | qwen | opencode | copilot | kilocode | mini-swe-agent | terminus | forge | deepagents
 *
 * The profile is mainly used by:
 *   - sandbox.ts                  → writes agent.sh + agent-start.sh to sandbox
 *   - coder-start.sh             → runs agent-start.sh before the loop
 */

export interface AgentProfile {
  /**
   * Profile identifier used in --agent CLI flag.
   * One of the SUPPORTED_AGENT_PROFILE_IDS.
   */
  id: SupportedAgentProfileId;

  /** Human-readable display name (e.g. "OpenHands", "Aider"). */
  displayName: string;

  /**
   * Default log format for the agent's stdout.
   * - `'openhands'` — parse OpenHands --json event stream (pretty-printed)
   * - `'raw'`       — stream lines as-is with an [agent] prefix
   */
  defaultLogFormat: 'openhands' | 'raw';
}

export const SUPPORTED_AGENT_PROFILE_IDS = [
  'openhands',
  'aider',
  'claude',
  'codex',
  'gemini',
  'qwen',
  'opencode',
  'copilot',
  'kilocode',
  'mini-swe-agent',
  'terminus',
  'forge',
  'deepagents',
] as const;
export type SupportedAgentProfileId = (typeof SUPPORTED_AGENT_PROFILE_IDS)[number];
