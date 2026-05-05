#!/bin/bash
# mini-SWE-agent script — runs `mini` with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the mini-swe-agent profile. Selected via --agent mini-swe-agent.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (release-readiness/X-08-P7/P8).
#
# CLI reference: https://mini-swe-agent.com/latest/usage/mini/
#
# Invocation:
#   mini -t TASK          Non-interactive mode.
#   -y / --yolo           Execute LM-proposed bash commands without prompting.
#   --exit-immediately    Exit on agent's COMPLETE_TASK signal.
#   -m / --model          litellm provider/model format.
#
# API keys: mini uses litellm. Native provider keys take precedence; we export
# LLM_API_KEY as fallback inside the runuser shell.
#
# Base URL: injected via a per-session YAML config (mktemp) merged with mini.yaml,
# along with custom_llm_provider so litellm routes correctly.

set -euo pipefail

echo "[agent/mini-swe-agent] Starting agent mini-swe-agent in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/mini-swe-agent] About to run (as ${SAIFCTL_UNPRIV_USER}): mini -t \"${_SAIFCTL_TASK_SNIP}\" --yolo --exit-immediately ${LLM_MODEL:+-m ${LLM_MODEL} }(api keys/base-url from env, masked as ****)"

_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),MSWEA_COST_TRACKING" \
  -c '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${LLM_API_KEY:-}}"
    export GEMINI_API_KEY="${GEMINI_API_KEY:-${LLM_API_KEY:-}}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-${LLM_API_KEY:-}}"
    export OR_API_KEY="${OR_API_KEY:-${LLM_API_KEY:-}}"
    export MSWEA_COST_TRACKING="${MSWEA_COST_TRACKING:-ignore_errors}"

    _model_flag=()
    if [ -n "${LLM_MODEL:-}" ]; then
      _model_flag=(-m "$LLM_MODEL")
    fi

    _config_flag=()
    if [ -n "${LLM_BASE_URL:-}" ]; then
      if [ -n "${LLM_PROVIDER:-}" ]; then
        _provider="$LLM_PROVIDER"
      elif [ -n "${LLM_MODEL:-}" ] && [[ "$LLM_MODEL" == */* ]]; then
        _provider="${LLM_MODEL%%/*}"
      else
        _provider=""
      fi
      if [ -n "$_provider" ]; then
        _tmp_config="$(mktemp /tmp/mini-swe-agent-config-XXXXXX.yaml)"
        cat > "$_tmp_config" <<EOF
model:
  model_kwargs:
    api_base: "${LLM_BASE_URL}"
    custom_llm_provider: "${_provider}"
  cost_tracking: "ignore_errors"
EOF
        _config_flag=(-c mini.yaml -c "$_tmp_config")
        trap "rm -f $_tmp_config" EXIT
      fi
    fi

    mini \
      -t "$(cat "$SAIFCTL_TASK_PATH")" \
      --yolo \
      --exit-immediately \
      "${_model_flag[@]}" \
      "${_config_flag[@]}"
  ' < /dev/null || _agent_exit=$?

echo "[agent/mini-swe-agent] Finished agent mini-swe-agent in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
