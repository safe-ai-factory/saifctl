/**
 * AgentProfile — describes a coding agent and its runtime requirements.
 *
 * Supported profiles: openhands | aider | claude | codex | gemini | qwen | opencode | copilot | kilocode | mini-swe-agent | terminus | forge | deepagents | cursor | debug
 *
 * Each profile directory contains:
 *   - profile.ts        → AgentProfile metadata (id, displayName, stdoutStrategy — strategy or `null`)
 *   - agent.sh          → script invoked by coder-start.sh on each inner round
 *   - agent-install.sh  → one-time install script run after project startup, before the loop
 */

import { join } from 'node:path';

import { getSaifctlRoot } from '../constants.js';
import { aiderProfile } from './aider/profile.js';
import { claudeProfile } from './claude/profile.js';
import { codexProfile } from './codex/profile.js';
import { copilotProfile } from './copilot/profile.js';
import { cursorProfile } from './cursor/profile.js';
import { debugProfile } from './debug/profile.js';
import { deepagentsProfile } from './deepagents/profile.js';
import { forgeProfile } from './forge/profile.js';
import { geminiProfile } from './gemini/profile.js';
import { kilocodeProfile } from './kilocode/profile.js';
import { miniSweAgentProfile } from './mini-swe-agent/profile.js';
import { opencodeProfile } from './opencode/profile.js';
import { openhandsProfile } from './openhands/profile.js';
import { qwenProfile } from './qwen/profile.js';
import { terminusProfile } from './terminus/profile.js';
import {
  type AgentProfile,
  SUPPORTED_AGENT_PROFILE_IDS,
  type SupportedAgentProfileId,
} from './types.js';

export {
  type AgentProfile,
  SUPPORTED_AGENT_PROFILE_IDS,
  type SupportedAgentProfileId,
} from './types.js';

export const SUPPORTED_AGENT_PROFILES = {
  openhands: openhandsProfile,
  aider: aiderProfile,
  claude: claudeProfile,
  codex: codexProfile,
  gemini: geminiProfile,
  qwen: qwenProfile,
  opencode: opencodeProfile,
  copilot: copilotProfile,
  kilocode: kilocodeProfile,
  'mini-swe-agent': miniSweAgentProfile,
  terminus: terminusProfile,
  forge: forgeProfile,
  deepagents: deepagentsProfile,
  cursor: cursorProfile,
  debug: debugProfile,
} satisfies Record<SupportedAgentProfileId, AgentProfile>;

/** Returns the default agent profile (openhands). */
export const DEFAULT_AGENT_PROFILE: AgentProfile = SUPPORTED_AGENT_PROFILES['openhands'];

const _agentProfilesDir = join(getSaifctlRoot(), 'src', 'agent-profiles');

/**
 * Returns the absolute path to the agent.sh script for the given profile id.
 * Used by the saifctl CLI (`loadAgentScriptsFromPicks`) as the default `--agent-script` when no override is provided.
 */
export function resolveAgentScriptPath(profileId: SupportedAgentProfileId): string {
  return join(_agentProfilesDir, profileId, 'agent.sh');
}

/**
 * Returns the absolute path to the agent-install.sh script for the given profile id.
 * Used by the saifctl CLI (`loadAgentScriptsFromPicks`) as the default `--agent-install-script` when no override is provided.
 */
export function resolveAgentInstallScriptPath(profileId: SupportedAgentProfileId): string {
  return join(_agentProfilesDir, profileId, 'agent-install.sh');
}

/**
 * Looks up an agent profile by id. Throws a user-facing error for unsupported ids.
 */
export function resolveAgentProfile(id: string): AgentProfile {
  if (SUPPORTED_AGENT_PROFILE_IDS.includes(id as SupportedAgentProfileId)) {
    return SUPPORTED_AGENT_PROFILES[id as SupportedAgentProfileId];
  }
  throw new Error(
    `Unsupported agent profile "${id}". Supported agents: ${SUPPORTED_AGENT_PROFILE_IDS.join(', ')}.\n` +
      `To use a custom agent, supply --agent-script (and optionally --agent-install-script) instead.`,
  );
}
