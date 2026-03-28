#!/bin/bash
# Claude Code agent script — runs Claude with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the claude agent profile. Selected via --agent claude.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://code.claude.com/docs/en/cli-reference
#
# Model and API key:
#   Claude expects ANTHROPIC_API_KEY. The factory provides LLM_API_KEY (generic) and
#   LLM_MODEL. We fall back to LLM_API_KEY when ANTHROPIC_API_KEY is not set, and
#   pass LLM_MODEL via --model to override Claude's default.
#
#   Note: Claude Code does not support a generic base URL override. Custom endpoints
#   are only available for specific integrations (Azure Foundry: ANTHROPIC_FOUNDRY_BASE_URL,
#   AWS Bedrock: AWS_BEARER_TOKEN_BEDROCK, etc.). LLM_BASE_URL is not forwarded here.
#
# Key flags:
#   -p / --print               Non-interactive (headless) mode: process prompt and exit.
#   --model                    Override the model for this session.
#   --dangerously-skip-permissions
#                              Skip all permission prompts (required for headless use).
#   --output-format stream-json
#                              Emit newline-delimited JSON events; compatible with the
#                              factory's log parsing and lets the loop stream progress.
#   --verbose                  Show full turn-by-turn output in the log.
#   --no-session-persistence   Do not save this session to disk; each factory round is
#                              independent and sessions should not accumulate.
#   --disable-slash-commands   Prevent task text from being interpreted as Claude Code
#                              slash commands.
#
# No --max-turns is set, so Claude runs until it naturally finishes the task.

set -euo pipefail

echo "[agent/claude] Starting agent claude in agent.sh..."

export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/claude] About to run: claude -p \"${_SAIFCTL_TASK_SNIP}\" --model \"${LLM_MODEL}\" --dangerously-skip-permissions --output-format stream-json --verbose --no-session-persistence --disable-slash-commands"

_agent_exit=0
claude \
  -p "$(cat "$SAIFCTL_TASK_PATH")" \
  --model "$LLM_MODEL" \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  --no-session-persistence \
  --disable-slash-commands || _agent_exit=$?

echo "[agent/claude] Finished agent claude in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
