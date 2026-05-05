/**
 * AgentProfile — describes a coding agent and its runtime requirements.
 *
 * Supported profiles: openhands | aider | claude | codex | gemini | qwen | opencode | copilot | kilocode | mini-swe-agent | terminus | forge | deepagents | cursor | debug
 *
 * The profile is mainly used by:
 *   - sandbox.ts                  → writes agent.sh + agent-install.sh to sandbox
 *   - coder-start.sh             → runs agent-install.sh before the loop
 *
 * **Re-used for critics.** Critic discover/fix subtasks (Block 4 of
 * TODO_phases_and_critics) run on the same agent script with the same profile
 * — saifctl spawns a fresh LLM context per critic round and distinguishes
 * implementer vs critic only by the rendered prompt template
 * (`critics/<id>.md`). There is no separate "critic profile"; if a project
 * wants critics on a different model, that's done via per-subtask LLM
 * overrides on the compiled critic subtasks, not via a new profile id here.
 *
 * ## Adding a new agent profile
 *
 * Every new profile dir under `src/agent-profiles/<id>/` must ship at least:
 *   - `profile.ts`         — registers the profile (id, displayName, stdoutStrategy)
 *   - `agent-install.sh`   — runs once at container start; install the CLI
 *   - `agent.sh`           — runs per round; reads `$SAIFCTL_TASK_PATH` and emits a patch
 *
 * **Drop-privileges classification (mandatory).** Each agent must declare
 * whether its `agent.sh` runs as root (default for the container) or drops
 * to the unprivileged `saifctl` user via `runuser`. The decision is enforced
 * at unit-test time by `drop-privileges-contract.test.ts`:
 *
 *   - **Drops privileges** — required when the agent CLI refuses to run as
 *     root (Claude Code 2.x with `--dangerously-skip-permissions` is the
 *     load-bearing case). Add the id to `DROPS_PRIVILEGES` in the contract
 *     test, copy the `runuser -l "$SAIFCTL_UNPRIV_USER"` invocation **and**
 *     the Linux UID-realignment block from `claude/agent.sh`. Both pieces
 *     are required (`runuser` alone breaks on Linux strict UID mapping).
 *
 *   - **Runs as root** — fine for now if the agent CLI works as root and
 *     you're not introducing new least-privilege guarantees in this PR.
 *     Add the id to `ROOT_OK_ALLOWLIST` in the contract test. Adding to
 *     this list is an explicit decision, not a default — the test will
 *     fail with a pointer to this paragraph if a new profile dir lacks
 *     classification.
 *
 * **Symmetric drop-privileges for every agent** is the desired end state
 * (least-privilege default; a bug or prompt-injection in any agent
 * shouldn't have root over `/workspace`). It's tracked as **X08-P8** in
 * `saifctl/features/release-readiness/specification.md` §4.1, deferred
 * until X-01's smoke matrix exercises every agent end-to-end so each can
 * be migrated and validated together.
 *
 * The Dockerfile-side contract (`SAIFCTL_UNPRIV_USER`,
 * `SAIFCTL_UNPRIV_NPM_PREFIX`) is enforced separately by
 * `src/sandbox-profiles/scaffold-contract.test.ts`. Every Dockerfile.coder
 * already exposes the unprivileged user, so any agent can opt in without
 * waiting for sandbox-profile changes.
 */

import type { AgentStdoutStrategy } from '../orchestrator/logs.js';

export interface AgentProfile {
  /**
   * Profile identifier used in --agent CLI flag.
   * One of the SUPPORTED_AGENT_PROFILE_IDS.
   */
  id: SupportedAgentProfileId;

  /** Human-readable display name (e.g. "OpenHands", "Aider"). */
  displayName: string;

  /**
   * Structured stdout handling inside the `[SAIFCTL:AGENT_*]` window (segment split + per-segment CLI formatting).
   * Use `null` when the agent emits plain line-oriented output (line-wise events + `[prefix]` formatting).
   */
  stdoutStrategy: AgentStdoutStrategy | null;
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
  'cursor',
  'debug',
] as const;
export type SupportedAgentProfileId = (typeof SUPPORTED_AGENT_PROFILE_IDS)[number];
