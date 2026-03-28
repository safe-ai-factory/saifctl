#!/bin/bash
# mini-SWE-agent script — runs `mini` with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the mini-swe-agent profile. Selected via --agent mini-swe-agent.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference:    https://mini-swe-agent.com/latest/usage/mini/
# Global config:    https://mini-swe-agent.com/latest/advanced/global_configuration/
# Models:           https://mini-swe-agent.com/latest/models/quickstart/
# Local/custom:     https://mini-swe-agent.com/latest/models/local_models/
#
# === Invocation ===
#   mini -t TASK          Non-interactive mode: provide the task as a flag and run.
#   -y / --yolo           Start in yolo mode: execute LM-proposed bash commands
#                         immediately without prompting the user. Required for
#                         headless factory use (default mode is "confirm").
#   --exit-immediately    Exit as soon as the agent issues its completion signal
#                         (echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT) rather than
#                         prompting the user for a follow-up task. Essential for
#                         single-shot factory rounds.
#
# === Model ===
#   -m / --model          Model name in litellm format (provider/model). Passed from
#                         LLM_MODEL. If unset, mini falls back to the MSWEA_MODEL_NAME
#                         env var, then to whatever was configured via mini-extra setup.
#                         Examples: "anthropic/claude-sonnet-4-5-20250929", "openai/gpt-5",
#                         "openrouter/anthropic/claude-3-5-sonnet".
#
# === API keys ===
#   mini-SWE-agent uses litellm, which reads the standard provider env vars directly
#   (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, etc.).
#   The factory provides LLM_API_KEY as a generic credential. We map it as a fallback
#   to the most common provider keys. Native keys already set take precedence.
#   All litellm key names (50+) are supported — set them directly if needed.
#
# === Base URL ===
#   LLM_BASE_URL is forwarded via a per-session YAML config injected through
#   MSWEA_MINI_CONFIG_PATH. litellm accepts `api_base` inside `model_kwargs`,
#   which is the only supported mechanism for a custom endpoint. We also set
#   `custom_llm_provider` to the provider inferred from LLM_PROVIDER or LLM_MODEL
#   prefix so litellm routes correctly when a base URL override is present.
#
# === Cost tracking ===
#   For custom/local models litellm may not have pricing data and will abort with a
#   cost-tracking error. We set MSWEA_COST_TRACKING=ignore_errors to skip this
#   when a custom endpoint or unrecognised model name is used. For known hosted
#   models cost tracking works normally.
#
# No --cost-limit is set, so mini runs until it naturally finishes the task.
# The default step_limit in mini.yaml is 0 (unlimited).

set -euo pipefail

echo "[agent/mini-swe-agent] Starting agent mini-swe-agent in agent.sh..."

# ---------------------------------------------------------------------------
# API keys — map LLM_API_KEY as a fallback for all common provider key vars.
# Native provider keys take precedence if already set.
# ---------------------------------------------------------------------------
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"
export OR_API_KEY="${OR_API_KEY:-$LLM_API_KEY}"

# ---------------------------------------------------------------------------
# Model flag — pass LLM_MODEL to -m only when set.
# ---------------------------------------------------------------------------
_model_flag=()
if [ -n "${LLM_MODEL:-}" ]; then
  _model_flag=(-m "$LLM_MODEL")
fi

# ---------------------------------------------------------------------------
# Base URL — inject via a temporary YAML config when LLM_BASE_URL is set.
# mini reads model_kwargs directly via litellm.completion(**model_kwargs).
# We also set custom_llm_provider so litellm routes to the correct backend.
# ---------------------------------------------------------------------------
_config_flag=()
if [ -n "${LLM_BASE_URL:-}" ]; then
  # Determine provider for custom_llm_provider.
  if [ -n "${LLM_PROVIDER:-}" ]; then
    _provider="$LLM_PROVIDER"
  elif [ -n "${LLM_MODEL:-}" ] && [[ "$LLM_MODEL" == */* ]]; then
    _provider="${LLM_MODEL%%/*}"
  else
    echo "[agent/mini-swe-agent] WARNING: LLM_BASE_URL is set but no provider could be determined." >&2
    echo "[agent/mini-swe-agent]   Set --provider (e.g. --provider openai) to enable base URL forwarding." >&2
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
    # mini merges -c specs in order; pass default config first, then our overlay.
    _config_flag=(-c mini.yaml -c "$_tmp_config")
    # Clean up the temp file when the script exits.
    trap 'rm -f "$_tmp_config"' EXIT
  fi
fi

# When no base URL override, still disable cost tracking errors for unknown models
# (e.g. custom model names). Known hosted models have pricing data in litellm.
export MSWEA_COST_TRACKING="${MSWEA_COST_TRACKING:-ignore_errors}"

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
_mini_model_echo=""
if [ "${#_model_flag[@]}" -gt 0 ]; then
  _mini_model_echo="-m \"${_model_flag[1]}\" "
fi
_mini_cfg_echo=""
if [ "${#_config_flag[@]}" -gt 0 ]; then
  _mini_cfg_echo="-c mini.yaml -c \"${_tmp_config}\" (overlay may contain api_base ****) "
fi
echo "[agent/mini-swe-agent] About to run: mini -t \"${_SAIFCTL_TASK_SNIP}\" --yolo --exit-immediately ${_mini_model_echo}${_mini_cfg_echo}(API keys from env, masked as ****)"

_agent_exit=0
mini \
  -t "$(cat "$SAIFCTL_TASK_PATH")" \
  --yolo \
  --exit-immediately \
  "${_model_flag[@]}" \
  "${_config_flag[@]}" || _agent_exit=$?

echo "[agent/mini-swe-agent] Finished agent mini-swe-agent in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
