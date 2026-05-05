#!/bin/bash
# Copilot CLI agent script — runs GitHub Copilot CLI with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the copilot agent profile. Selected via --agent copilot.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8). Copilot runs as $SAIFCTL_UNPRIV_USER.
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
#   LLM_MODEL_ID is forwarded via --model if set. The value must be a model name from
#   GitHub's Copilot model list (e.g. "claude-sonnet-4.5", "gpt-4.1", "gemini-3-pro").
#   These are NOT arbitrary provider/model strings — they are GitHub-managed identifiers.
#   If LLM_MODEL_ID is unset, Copilot uses its default (currently Claude Sonnet 4.5).
#
# Key flags:
#   --prompt / -p              Non-interactive (programmatic) mode.
#   --allow-all                Approve all file/shell/network tool use without prompts.
#                              Safe here because Leash sandboxes the container.
#   --no-ask-user              Disable the ask_user tool so Copilot doesn't pause.
#   --no-auto-update           Suppress automatic CLI self-update during a run.
#   --autopilot                Enable autonomous multi-step continuation.

set -euo pipefail

echo "[agent/copilot] Starting agent copilot in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/copilot] About to run (as ${SAIFCTL_UNPRIV_USER}): copilot --prompt \"${_SAIFCTL_TASK_SNIP}\" ${LLM_MODEL_ID:+--model \"${LLM_MODEL_ID}\" }--allow-all --no-ask-user --no-auto-update --autopilot (token from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-${LLM_API_KEY:-}}}}"
    _model_flag=()
    if [ -n "${LLM_MODEL_ID:-}" ]; then
      _model_flag=(--model "$LLM_MODEL_ID")
    fi
    copilot \
      --prompt "$(cat "$SAIFCTL_TASK_PATH")" \
      "${_model_flag[@]}" \
      --allow-all \
      --no-ask-user \
      --no-auto-update \
      --autopilot
  ' || _agent_exit=$?

echo "[agent/copilot] Finished agent copilot in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
