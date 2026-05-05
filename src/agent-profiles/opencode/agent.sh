#!/bin/bash
# OpenCode agent script — runs OpenCode with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the opencode agent profile. Selected via --agent opencode.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (X08-P7/P8).
#
# CLI reference:   https://opencode.ai/docs/cli/
# Config ref:      https://opencode.ai/docs/config/
# Providers ref:   https://opencode.ai/docs/providers/
#
# Model and API key:
#   OpenCode reads standard provider keys from the env automatically (ANTHROPIC_API_KEY,
#   OPENAI_API_KEY, GEMINI_API_KEY, etc.). The factory provides LLM_API_KEY (generic).
#   We export it as fallback for the most common provider keys inside the runuser
#   shell. If a native key is already set, it takes precedence.
#
#   LLM_BASE_URL: provider-scoped baseURL override is injected via
#   OPENCODE_CONFIG_CONTENT. Provider id comes from LLM_PROVIDER, falling back to
#   the prefix of LLM_MODEL.
#
# Permissions:
#   OpenCode has no --yolo CLI flag. We set OPENCODE_PERMISSION='{"*":"allow"}'
#   to auto-allow all tools — equivalent to --dangerously-skip-permissions in claude.

set -euo pipefail

echo "[agent/opencode] Starting agent opencode in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

# Build OPENCODE_CONFIG_CONTENT (only when LLM_BASE_URL is set + provider known)
# as root, then forward into the runuser shell.
if [ -n "${LLM_BASE_URL:-}" ]; then
  if [ -n "${LLM_PROVIDER:-}" ]; then
    _provider="$LLM_PROVIDER"
  elif [[ "${LLM_MODEL:-}" == */* ]]; then
    _provider="${LLM_MODEL%%/*}"
  else
    echo "[agent/opencode] WARNING: LLM_BASE_URL is set but no provider could be determined." >&2
    echo "[agent/opencode]   Set --provider (e.g. --provider anthropic) to enable base URL forwarding." >&2
    _provider=""
  fi
  if [ -n "$_provider" ]; then
    export OPENCODE_CONFIG_CONTENT="{\"provider\":{\"${_provider}\":{\"options\":{\"baseURL\":\"${LLM_BASE_URL}\"}}}}"
  fi
fi

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
_opencode_cfg_redacted=""
if [ -n "${OPENCODE_CONFIG_CONTENT:-}" ]; then
  _opencode_cfg_redacted="$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed 's/"baseURL":"[^"]*"/"baseURL":"****"/g')"
fi
echo "[agent/opencode] About to run (as ${SAIFCTL_UNPRIV_USER}): OPENCODE_PERMISSION='{\"*\":\"allow\"}' OPENCODE_CONFIG_CONTENT='${_opencode_cfg_redacted}' opencode run --model \"${LLM_MODEL}\" --format json \"${_SAIFCTL_TASK_SNIP}\""

_agent_exit=0
OPENCODE_PERMISSION='{"*":"allow"}' \
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),OPENCODE_CONFIG_CONTENT,OPENCODE_PERMISSION" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export GEMINI_API_KEY="${GEMINI_API_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
    opencode run \
      --model "$LLM_MODEL" \
      --format json \
      "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/opencode] Finished agent opencode in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
