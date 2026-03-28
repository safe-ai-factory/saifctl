#!/bin/bash
# Copilot CLI agent script — runs GitHub Copilot CLI with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the copilot agent profile. Selected via --agent copilot.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli
#
# Authentication:
#   Copilot CLI uses a GitHub token for auth. It checks the following environment
#   variables in order of precedence: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN.
#   The factory provides LLM_API_KEY as the generic credential. We map it to
#   GITHUB_TOKEN as a fallback so users only need to set LLM_API_KEY (or any of
#   the native token vars, which take precedence).
#
#   Note: Copilot CLI routes all requests through GitHub's API — it does NOT support
#   a custom LLM_BASE_URL. There is no way to point it at a custom endpoint.
#
#   LLM_MODEL is forwarded via --model if set. The value must be a model name from
#   GitHub's Copilot model list (e.g. "claude-sonnet-4.5", "gpt-4.1", "gemini-3-pro").
#   These are NOT arbitrary provider/model strings — they are GitHub-managed identifiers.
#   If LLM_MODEL is unset, Copilot uses its default (currently Claude Sonnet 4.5).
#   Also accepted via the COPILOT_MODEL env var.
#
# Key flags:
#   --prompt / -p              Non-interactive (programmatic) mode: pass the prompt
#                              on the command line, run the task, and exit.
#   --allow-all                Shorthand for --allow-all-tools + --allow-all-paths +
#                              --allow-all-urls. Approves all file, shell, and network
#                              tool use without prompts. Safe here because the factory
#                              container is already sandboxed by Leash.
#                              (env: COPILOT_ALLOW_ALL)
#   --no-ask-user              Disables the ask_user tool so Copilot never pauses to ask
#                              clarifying questions mid-task. Essential for headless use.
#   --no-auto-update           Suppress automatic CLI self-update during a factory run.
#   --autopilot                Enable autonomous continuation so Copilot keeps working
#                              through multi-step tasks without stopping after one turn.
#
# Note: Copilot CLI does not expose --no-auto-commits. If Copilot commits during the
# session the factory will still detect changes via git log (the factory checks both
# git diff and recent commits).
#
# No --max-autopilot-continues is set, so Copilot runs until it naturally finishes.

set -euo pipefail

echo "[agent/copilot] Starting agent copilot in agent.sh..."

# Map the factory's generic credential to the token vars Copilot CLI checks.
# Native token vars take precedence if already set in the environment.
export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-$LLM_API_KEY}}}"

# Build the model flag only when LLM_MODEL is explicitly set.
# Copilot CLI model names are GitHub-managed (e.g. "claude-sonnet-4.5", "gpt-4.1").
# LLM_BASE_URL is not supported — Copilot always routes through GitHub's API.
_model_flag=()
if [ -n "${LLM_MODEL:-}" ]; then
  _model_flag=(--model "$LLM_MODEL")
fi

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
_copilot_model_echo=""
if [ "${#_model_flag[@]}" -gt 0 ]; then
  _copilot_model_echo="--model \"${LLM_MODEL}\" "
fi
echo "[agent/copilot] About to run: copilot --prompt \"${_SAIFCTL_TASK_SNIP}\" ${_copilot_model_echo}--allow-all --no-ask-user --no-auto-update --autopilot (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN from env, masked as ****)"

_agent_exit=0
copilot \
  --prompt "$(cat "$SAIFCTL_TASK_PATH")" \
  "${_model_flag[@]}" \
  --allow-all \
  --no-ask-user \
  --no-auto-update \
  --autopilot || _agent_exit=$?

echo "[agent/copilot] Finished agent copilot in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
