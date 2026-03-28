#!/bin/bash
# Deep Agents CLI agent script — runs `deepagents` with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the deepagents agent profile. Selected via --agent deepagents.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# deepagents-cli is installed by agent-install.sh before the loop begins.
#
# CLI reference:   https://docs.langchain.com/oss/python/deepagents/cli
# Providers:       https://docs.langchain.com/oss/python/deepagents/cli/providers
# Source:          https://github.com/langchain-ai/deepagents
#
# === Invocation ===
#   deepagents -n "TASK"         Non-interactive (headless) mode: process the task
#                                 and exit. When stdin is not a terminal the CLI also
#                                 auto-detects non-interactive mode. -n is the
#                                 canonical headless flag.
#   --auto-approve               Auto-approve all tool calls (yolo / autonomous mode).
#                                 Disables the human-in-the-loop approval prompts that
#                                 guard file writes, shell execution, etc.
#   --shell-allow-list recommended
#                                 In non-interactive mode shell execution is disabled
#                                 by default. 'recommended' enables the common safe
#                                 subset (git, make, npm, pytest, …). Required for
#                                 coding tasks that need to run tests or build.
#
# === All relevant CLI flags ===
#   -n, --non-interactive TEXT   Run a single task non-interactively and exit.
#   --auto-approve               Skip all human-in-the-loop approval prompts.
#   --shell-allow-list LIST      Comma-separated commands to auto-approve, or
#                                 'recommended' for safe defaults. Also readable via
#                                 DEEPAGENTS_SHELL_ALLOW_LIST env var.
#   -M, --model MODEL            Model in provider:model format (e.g.
#                                 anthropic:claude-sonnet-4-5, openai:gpt-4o,
#                                 openrouter:anthropic/claude-3-5-sonnet).
#   --model-params JSON          Extra kwargs for the model constructor as JSON
#                                 (e.g. '{"temperature": 0}').
#   -a, --agent NAME             Named agent with separate memory/config directory.
#                                 Default: 'agent'. We use 'factory' so the factory
#                                 sessions don't pollute the user's default memory.
#   -q, --quiet                  Clean output for piping — only the agent's response
#                                 to stdout. Requires -n.
#   --no-stream                  Buffer the full response before writing to stdout.
#   -v, --version                Display version.
#   -h, --help                   Show help.
#
# === Authentication & API keys ===
#   deepagents-cli reads provider credentials from standard environment variables:
#     OPENAI_API_KEY     → openai provider (included by default)
#     ANTHROPIC_API_KEY  → anthropic provider
#     GOOGLE_API_KEY     → google_genai provider
#     OPENROUTER_API_KEY → openrouter provider (requires langchain-openrouter)
#     GROQ_API_KEY       → groq provider (requires langchain-groq)
#   The factory provides LLM_API_KEY as a generic credential. We map it as a
#   fallback to all common provider keys; native keys already set take precedence.
#
# === Model selection ===
#   Passed via --model in provider:model format, derived from LLM_MODEL.
#   LLM_MODEL must already be in provider:model format (e.g. "openai:gpt-4o",
#   "anthropic:claude-sonnet-4-5", "openrouter:anthropic/claude-3-5-sonnet").
#   If LLM_PROVIDER is set but LLM_MODEL has no prefix, we prepend the provider.
#   If LLM_MODEL is unset, the CLI falls back to the most-recently-used model
#   from ~/.deepagents/config.toml or auto-detects from available API keys.
#
# === Base URL / Custom endpoints ===
#   deepagents-cli does not accept a --base-url CLI flag. The only supported
#   mechanism is the config.toml `base_url` key under a provider's table:
#
#     [models.providers.openai]
#     base_url = "https://custom-endpoint/v1"
#     api_key_env = "OPENAI_API_KEY"
#
#   When LLM_BASE_URL is set, we inject a temporary TOML snippet into
#   ~/.deepagents/factory/config.toml (the agent-scoped config for the
#   factory agent) that overrides the provider's base_url. We determine the
#   provider from LLM_PROVIDER, or by stripping the prefix from LLM_MODEL.
#   If neither is available, we default to "openai" (most widely compatible).
#
# === Provider selection ===
#   LLM_PROVIDER maps to the deepagents provider prefix:
#     "openai"      → openai:MODEL
#     "anthropic"   → anthropic:MODEL
#     "openrouter"  → openrouter:MODEL
#     "groq"        → groq:MODEL
#     "google"      → google_genai:MODEL
#   Used to prefix an unprefixed LLM_MODEL and to select the API key var
#   for LLM_API_KEY mapping.

set -euo pipefail

echo "[agent/deepagents] Starting agent deepagents in agent.sh..."

# ---------------------------------------------------------------------------
# API keys — map LLM_API_KEY as a fallback for all common provider key vars.
# Native provider keys already set in the environment take precedence.
# ---------------------------------------------------------------------------
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"
export GOOGLE_API_KEY="${GOOGLE_API_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"
export GROQ_API_KEY="${GROQ_API_KEY:-$LLM_API_KEY}"

# ---------------------------------------------------------------------------
# Model — resolve into provider:model format for --model flag.
# deepagents expects "provider:model" (e.g. "openai:gpt-4o").
# ---------------------------------------------------------------------------
_model_flag=()
if [ -n "${LLM_MODEL:-}" ]; then
  _resolved_model="$LLM_MODEL"

  # If LLM_MODEL has no provider prefix but LLM_PROVIDER is given, prepend it.
  if [[ "$_resolved_model" != *:* ]] && [ -n "${LLM_PROVIDER:-}" ]; then
    _resolved_model="${LLM_PROVIDER}:${_resolved_model}"
  fi

  _model_flag=(--model "$_resolved_model")
fi

# ---------------------------------------------------------------------------
# Base URL — inject via a per-session config.toml when LLM_BASE_URL is set.
# The factory uses agent name 'factory' so config lives at
# ~/.deepagents/factory/config.toml and doesn't pollute the user's default.
# ---------------------------------------------------------------------------
_factory_agent_dir="$HOME/.deepagents/factory"
_factory_config="$_factory_agent_dir/config.toml"

if [ -n "${LLM_BASE_URL:-}" ]; then
  # Determine the provider name for the config.toml table key.
  if [ -n "${LLM_PROVIDER:-}" ]; then
    _provider="$LLM_PROVIDER"
  elif [ -n "${LLM_MODEL:-}" ] && [[ "$LLM_MODEL" == *:* ]]; then
    _provider="${LLM_MODEL%%:*}"
  else
    _provider="openai"
  fi

  mkdir -p "$_factory_agent_dir"

  # Write (or overwrite) the provider base_url into the factory config.
  # We preserve any existing non-provider-URL content by reading first, then
  # rewriting only the target provider table's base_url entry.
  # For simplicity in a factory context we write a clean minimal config.
  cat > "$_factory_config" <<EOF
[models.providers.${_provider}]
base_url = "${LLM_BASE_URL}"
EOF
  echo "[agent/deepagents] Base URL override written to ${_factory_config} (provider: ${_provider})"
fi

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
_deepagents_model_echo=""
if [ "${#_model_flag[@]}" -gt 0 ]; then
  _deepagents_model_echo="--model \"${_model_flag[1]}\" "
fi
_config_note=""
if [ -n "${LLM_BASE_URL:-}" ]; then
  _config_note=" (base URL written to ${_factory_config}, value masked as ****)"
fi
echo "[agent/deepagents] About to run: deepagents --agent factory -n \"${_SAIFCTL_TASK_SNIP}\" --auto-approve --shell-allow-list recommended ${_deepagents_model_echo}(API keys from env, masked as ****)${_config_note}"

_agent_exit=0
deepagents \
  --agent factory \
  -n "$(cat "$SAIFCTL_TASK_PATH")" \
  --auto-approve \
  --shell-allow-list recommended \
  "${_model_flag[@]}" || _agent_exit=$?

echo "[agent/deepagents] Finished agent deepagents in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
