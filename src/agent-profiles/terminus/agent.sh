#!/bin/bash
# Terminus agent script — runs Terminus with the task read from $FACTORY_TASK_PATH.
#
# Part of the terminus agent profile. Selected via --agent terminus.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# PyPI:           https://pypi.org/project/terminus-ai/
# Harbor docs:    https://harborframework.com/docs/agents/terminus-2
#
# === Architecture note ===
#   Terminus is fundamentally different from other agents: it uses a single tmux
#   session as its only tool. It sends keystrokes to the terminal and reads back
#   the screen state after each step. This means it works with any CLI application
#   naturally and requires NO tools other than bash. The agent logic runs in the
#   same process as the task environment (no separate container required when using
#   the CLI directly, which is what the factory expects).
#
# === Invocation ===
#   terminus TASK             The task is passed as the first positional argument.
#                             Terminus is fully autonomous by design — it never asks
#                             the user for confirmation or input. There is no separate
#                             "yolo" flag; autonomy-first is the only mode the CLI
#                             provides.
#
# === All CLI flags ===
#   --model        MODEL      LLM model in litellm provider/model format (required).
#                             e.g. "anthropic/claude-sonnet-4-5", "openai/gpt-5".
#   --api-base     URL        Custom LLM API base URL. Used when LLM_BASE_URL is set
#                             (e.g. for vLLM, Ollama, or any OpenAI-compatible proxy).
#   --parser       FORMAT     Response format: "json" or "xml" (default: "json").
#   --temperature  FLOAT      Sampling temperature (default: 0.7).
#   --max-turns    INT        Max agent turns before stopping (default: 1000000,
#                             effectively unlimited).
#   --logs-dir     PATH       Directory for trajectory + log files. We suppress this
#                             so logs go to the factory's own log handling.
#   --enable-summarize        Enable intelligent context summarization when the
#                             context window approaches its limit. Uses a 3-step
#                             subagent (summary → questions → answers) to compress
#                             history while preserving critical information.
#                             (default: True — always enabled, omitted from CLI call)
#   --collect-rollout-details Collect token-level logprobs and IDs (for RL training).
#                             Not needed for the factory; omitted.
#
# === API keys ===
#   Terminus uses litellm, which reads standard provider env vars directly
#   (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, etc.).
#   The factory provides LLM_API_KEY as a generic credential. We map it as a
#   fallback to the most common provider keys; native keys already set take precedence.
#
# === Model ===
#   LLM_MODEL is passed via --model (required by Terminus). Must be in litellm's
#   provider/model format (e.g. "anthropic/claude-sonnet-4-5", "openai/gpt-5",
#   "openrouter/anthropic/claude-3-5-sonnet"). There is no built-in default model —
#   the factory MUST provide LLM_MODEL.
#
# === Base URL ===
#   LLM_BASE_URL is forwarded via --api-base. This supports OpenAI-compatible
#   endpoints (vLLM, LiteLLM proxy, Ollama, Azure, etc.).
#   LLM_PROVIDER is used alongside LLM_BASE_URL to set litellm's OPENAI_API_KEY
#   family of keys when routing to a non-standard endpoint. For OpenAI-compatible
#   servers the OPENAI_API_KEY is the right credential even if the provider is
#   not OpenAI, so we export LLM_API_KEY as OPENAI_API_KEY when LLM_BASE_URL is set
#   and no native OPENAI_API_KEY is already present.

set -euo pipefail

# ---------------------------------------------------------------------------
# Validate LLM_MODEL — Terminus requires it; there is no default.
# ---------------------------------------------------------------------------
if [ -z "${LLM_MODEL:-}" ]; then
  echo "[agent/terminus] ERROR: LLM_MODEL is not set. Terminus requires a model name." >&2
  echo "[agent/terminus]   Set LLM_MODEL to a litellm provider/model string, e.g. 'anthropic/claude-sonnet-4-5'." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# API keys — map LLM_API_KEY as a fallback for the most common provider vars.
# Native provider keys take precedence if already set.
# ---------------------------------------------------------------------------
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"
export OR_API_KEY="${OR_API_KEY:-$LLM_API_KEY}"

# When a custom base URL is in use the endpoint is typically OpenAI-compatible;
# ensure the API key is also exported as OPENAI_API_KEY for litellm routing.
if [ -n "${LLM_BASE_URL:-}" ]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
fi

# ---------------------------------------------------------------------------
# Build optional flags.
# ---------------------------------------------------------------------------
_api_base_flag=()
if [ -n "${LLM_BASE_URL:-}" ]; then
  _api_base_flag=(--api-base "$LLM_BASE_URL")
fi

terminus \
  "$(cat "$FACTORY_TASK_PATH")" \
  --model "$LLM_MODEL" \
  "${_api_base_flag[@]}" \
  --parser json \
  --temperature 0.7
