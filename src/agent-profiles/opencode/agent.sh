#!/bin/bash
# OpenCode agent script — runs OpenCode with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the opencode agent profile. Selected via --agent opencode.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference:   https://opencode.ai/docs/cli/
# Config ref:      https://opencode.ai/docs/config/
# Providers ref:   https://opencode.ai/docs/providers/
#
# Model and API key:
#   OpenCode reads standard provider API keys from the environment automatically
#   (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.). The factory
#   provides LLM_API_KEY (generic) and LLM_MODEL. We export LLM_API_KEY as a
#   fallback for the most common provider keys so users only need to set LLM_API_KEY.
#   If a native key is already set, it takes precedence.
#
#   LLM_MODEL is passed via --model. OpenCode accepts both bare model names (e.g. claude-sonnet-4-5)
#   and provider-prefixed names (e.g. anthropic/claude-sonnet-4-5). The format is the user's
#   responsibility — it must match what OpenCode expects for the chosen provider.
#
#   LLM_BASE_URL: OpenCode supports a baseURL override per provider, but only via
#   config (not a global env var). We inject it via OPENCODE_CONFIG_CONTENT, scoped to
#   the provider ID. The provider ID is read from LLM_PROVIDER (set by the factory via
#   --provider). If LLM_PROVIDER is not set, we fall back to the prefix of LLM_MODEL
#   (works when the model is in provider/model format, e.g. anthropic/claude-sonnet-4-5,
#   which is NOT always the case — set --provider explicitly when in doubt).
#   If neither yields a provider and LLM_BASE_URL is set, a warning is emitted and
#   the base URL is not forwarded.
#   Docs: https://opencode.ai/docs/config/#env-vars
#
# Permissions:
#   OpenCode has no --yolo CLI flag. Tool approval is controlled via the "permission"
#   config. We inline the full-allow config via OPENCODE_PERMISSION (env var) so that
#   no opencode.json file needs to exist in the project.
#   Setting permission="allow" is equivalent to --dangerously-skip-permissions in
#   claude or --yolo in codex/gemini.
#
# Key flags:
#   run [message..]            Non-interactive subcommand: run with a prompt and exit.
#   --model / -m               Model in provider/model format (e.g. anthropic/claude-sonnet-4-5).
#   --format json              Emit raw JSON events; compatible with the factory's log
#                              parsing and lets the loop stream progress.
#
# Note: OpenCode has no ephemeral/no-persist flag. Sessions are retained according to
# the global config (default: pruned automatically). This is acceptable for the factory
# use case.
#
# No turn limit is set, so OpenCode runs until it naturally finishes the task.

set -euo pipefail

echo "[agent/opencode] Starting agent opencode in agent.sh..."

# Export common provider API keys as fallbacks from the factory's generic LLM_API_KEY.
# OpenCode auto-detects these from the environment. Native keys take precedence.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"

# If LLM_BASE_URL is set, inject a provider-scoped baseURL override via inline config.
# Prefer the explicit LLM_PROVIDER; fall back to the prefix of LLM_MODEL (only works
# when LLM_MODEL is in provider/model format, which is not guaranteed).
if [ -n "${LLM_BASE_URL:-}" ]; then
  if [ -n "${LLM_PROVIDER:-}" ]; then
    _provider="$LLM_PROVIDER"
  elif [[ "$LLM_MODEL" == */* ]]; then
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
echo "[agent/opencode] About to run: OPENCODE_PERMISSION='{\"*\":\"allow\"}' OPENCODE_CONFIG_CONTENT='${_opencode_cfg_redacted}' opencode run --model \"${LLM_MODEL}\" --format json \"${_SAIFCTL_TASK_SNIP}\""

_agent_exit=0
OPENCODE_PERMISSION='{"*":"allow"}' \
opencode run \
  --model "$LLM_MODEL" \
  --format json \
  "$(cat "$SAIFCTL_TASK_PATH")" || _agent_exit=$?

echo "[agent/opencode] Finished agent opencode in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
