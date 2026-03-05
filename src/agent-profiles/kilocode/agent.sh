#!/bin/bash
# Kilo Code CLI agent script — runs kilo with the task read from $FACTORY_TASK_PATH.
#
# Part of the kilocode agent profile. Selected via --agent kilocode.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# Kilo CLI is a fork of OpenCode and inherits its config/provider model.
# CLI reference:    https://kilocode.ai/docs/cli
# Config reference: https://opencode.ai/docs/config  (shared schema)
#
# === Invocation ===
#   kilo run [message..]   Non-interactive subcommand: runs with a message and exits.
#   --auto                 Autonomous mode: disables all permission prompts. All
#                          approval requests are handled automatically based on the
#                          inline permission config (set to "allow" below). The agent
#                          also auto-responds to any follow-up questions rather than
#                          blocking. Required for headless factory use.
#
# === Permissions ===
#   Kilo uses a JSON "permission" config key rather than a CLI flag. We inject
#   {"permission":"allow"} via OPENCODE_CONFIG_CONTENT, which sets all tools to
#   allow without prompts. This is equivalent to --yolo in codex or
#   --dangerously-skip-permissions in claude. Safe here because the factory
#   container is already sandboxed by Leash.
#   Docs: https://kilocode.ai/docs/cli#permissions
#
# === Model / Provider / API key ===
#   Kilo uses the OpenCode provider config format. The factory provides:
#     LLM_API_KEY   — generic API key (mapped to the active provider below)
#     LLM_MODEL     — model in provider/model format (e.g. "anthropic/claude-sonnet-4-5",
#                     "openai/gpt-4o", "openrouter/anthropic/claude-sonnet-4-5")
#     LLM_BASE_URL  — optional custom base URL for the provider (e.g. for OpenRouter,
#                     local Ollama, or any OpenAI-compatible endpoint)
#     LLM_PROVIDER  — optional explicit provider ID (e.g. "anthropic", "openai",
#                     "openrouter"). When set, used as the config key for apiKey and
#                     baseURL. When unset, the provider is inferred from the LLM_MODEL
#                     prefix (e.g. "anthropic" from "anthropic/claude-sonnet-4-5").
#
#   We inject the full provider config via OPENCODE_CONFIG_CONTENT as JSON so that
#   no config file needs to exist in the project. The {env:VAR} syntax used in
#   kilo config files is only parsed from files, not from the env var — so we
#   construct the JSON directly in the shell.
#
#   KILO_PROVIDER / KILO_API_KEY env vars are also documented for the kilocode
#   provider integration, but OPENCODE_CONFIG_CONTENT gives us full control and
#   works across all providers uniformly.
#
# === Auto-update ===
#   autoupdate is set to false in the injected config to prevent kilo from trying
#   to self-update during a factory run.
#
# No turn limit is set, so kilo runs until it naturally finishes the task.

set -euo pipefail

# Determine the active provider ID.
# Prefer the explicit LLM_PROVIDER; fall back to the prefix of LLM_MODEL when
# it is in provider/model format (e.g. "anthropic/claude-sonnet-4-5").
if [ -n "${LLM_PROVIDER:-}" ]; then
  _provider="$LLM_PROVIDER"
elif [ -n "${LLM_MODEL:-}" ] && [[ "$LLM_MODEL" == */* ]]; then
  _provider="${LLM_MODEL%%/*}"
else
  _provider=""
fi

# Build provider config block only when we have a provider to configure.
# Sets apiKey from LLM_API_KEY and optionally baseURL from LLM_BASE_URL.
if [ -n "$_provider" ]; then
  _base_url_fragment=""
  if [ -n "${LLM_BASE_URL:-}" ]; then
    _base_url_fragment=",\"baseURL\":\"${LLM_BASE_URL}\""
  fi
  _provider_block="\"provider\":{\"${_provider}\":{\"options\":{\"apiKey\":\"${LLM_API_KEY}\"${_base_url_fragment}}}}"
else
  # No provider could be determined; skip provider config. Kilo will use
  # whatever credentials are already configured in the user's global config.
  if [ -n "${LLM_API_KEY:-}" ]; then
    echo "[agent/kilocode] WARNING: LLM_API_KEY is set but no provider could be determined." >&2
    echo "[agent/kilocode]   Set --provider (e.g. --provider anthropic) to enable API key forwarding." >&2
  fi
  _provider_block=""
fi

# Build the model fragment if LLM_MODEL is set.
if [ -n "${LLM_MODEL:-}" ]; then
  _model_fragment="\"model\":\"${LLM_MODEL}\","
else
  _model_fragment=""
fi

# Assemble the inline config and inject via OPENCODE_CONFIG_CONTENT.
# permission:"allow" sets all tools to auto-allow (no prompts).
# autoupdate:false suppresses self-update attempts during factory runs.
_provider_sep=""
[ -n "$_provider_block" ] && _provider_sep=","

export OPENCODE_CONFIG_CONTENT="{${_model_fragment}\"permission\":\"allow\",\"autoupdate\":false${_provider_sep}${_provider_block}}"

kilo run \
  --auto \
  "$(cat "$FACTORY_TASK_PATH")"
