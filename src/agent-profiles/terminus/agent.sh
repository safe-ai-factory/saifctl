#!/bin/bash
# Terminus agent script — runs Terminus with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the terminus agent profile. Selected via --agent terminus.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# Architecture: Terminus uses a single tmux session as its only tool — sends
# keystrokes and reads back the screen. No tools other than bash + tmux.
#
# Invocation:
#   terminus TASK             First positional arg. Fully autonomous (no yolo flag).
#   --model MODEL             litellm provider/model format (required).
#   --api-base URL            Custom LLM API base URL.
#   --parser FORMAT           Response format ("json" or "xml"; default "json").
#   --temperature FLOAT       Sampling temperature (default: 0.7).
#
# API keys: Terminus uses litellm. Native keys take precedence; we export
# LLM_API_KEY as fallback for the most common provider vars in the runuser shell.

set -euo pipefail

echo "[agent/terminus] Starting agent terminus in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

if [ -z "${LLM_MODEL:-}" ]; then
  echo "[agent/terminus] ERROR: LLM_MODEL is not set. Terminus requires a model name." >&2
  exit 1
fi

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/terminus] About to run (as ${SAIFCTL_UNPRIV_USER}): terminus \"${_SAIFCTL_TASK_SNIP}\" --model \"${LLM_MODEL}\" ${LLM_BASE_URL:+--api-base **** }--parser json --temperature 0.7 (api keys from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export GEMINI_API_KEY="${GEMINI_API_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
    export OR_API_KEY="${OR_API_KEY:-${LLM_API_KEY:-}}"

    _api_base_flag=()
    if [ -n "${LLM_BASE_URL:-}" ]; then
      _api_base_flag=(--api-base "$LLM_BASE_URL")
    fi

    terminus \
      "$(cat "$SAIFCTL_TASK_PATH")" \
      --model "$LLM_MODEL" \
      "${_api_base_flag[@]}" \
      --parser json \
      --temperature 0.7
  ' < /dev/null || _agent_exit=$?

echo "[agent/terminus] Finished agent terminus in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
