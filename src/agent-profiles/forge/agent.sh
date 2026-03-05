#!/bin/bash
# Forge Code agent script — runs forge with the task read from $FACTORY_TASK_PATH.
#
# Part of the forge agent profile. Selected via --agent forge.
# coder-start.sh writes the current task to $FACTORY_TASK_PATH before each invocation.
#
# Forge is a compiled Rust binary that runs fully headlessly with no interactive prompts required.
#
# CLI reference:   https://forgecode.dev/docs/cli-reference/
# Env config:      https://forgecode.dev/docs/environment-configuration/
# Providers:       https://forgecode.dev/docs/custom-providers/
#
# === Invocation ===
#   forge -p "TASK"    Non-interactive mode: process the prompt and exit. Mutually
#                      exclusive with piping. This is the correct headless mode.
#
# === All relevant CLI flags ===
#   -p, --prompt TEXT  Pass a prompt directly; forge processes it and exits.
#                      This is the primary headless interface for the factory.
#   --agent AGENT_ID   Agent to use for this session. Forge has two built-in agents:
#                      "forge" (full read-write execution — what we want for coding
#                      tasks) and "muse" (read-only planning). Defaults to "forge".
#                      Explicitly passing --agent forge makes the mode unambiguous.
#   --verbose          Enable verbose output. Useful for factory log inspection.
#   -C, --directory    Set working directory before starting. Not needed here as the
#                      factory already runs agent.sh in the project root.
#   --sandbox          Create an isolated git worktree. Not used — the factory
#                      manages its own sandboxing via Leash.
#   -r, --restricted   Use restricted bash shell. Not used — the factory container
#                      is already sandboxed by Leash.
#
# === Authentication & API keys ===
#   Forge reads API keys directly from environment variables. The priority order is:
#     1. FORGE_KEY          (Antinomy's own provider, OpenAI-compatible)
#     2. OPENROUTER_API_KEY (OpenRouter — recommended; provides 300+ models)
#     3. OPENAI_API_KEY     (Official OpenAI)
#     4. ANTHROPIC_API_KEY  (Official Anthropic)
#   The factory provides LLM_API_KEY as a generic credential. We map it as a
#   fallback to all four in the order above. Native keys already set take precedence.
#
# === Model selection ===
#   Forge selects models interactively via /model or persistently via
#   `forge config set model MODEL`. There is no --model CLI flag.
#   We set the model via `forge config set model` before running the prompt when
#   LLM_MODEL is provided. The config is stored in Forge's own config file.
#
# === Base URL / Custom endpoints ===
#   Forge supports custom provider URLs via two env vars:
#     OPENAI_URL      — Custom base URL for any OpenAI-compatible endpoint
#                       (including OpenRouter alternatives, Azure, vLLM, Ollama, etc.)
#     ANTHROPIC_URL   — Custom base URL for an Anthropic-compatible endpoint
#   LLM_BASE_URL is forwarded to OPENAI_URL as the general-purpose override
#   (OpenAI-compatible format is the most widely supported). If the endpoint
#   is Anthropic-compatible, users should set ANTHROPIC_URL directly.
#
# === Provider selection ===
#   LLM_PROVIDER is used to choose which API key to surface as the primary one.
#   For the most common cases:
#     "openrouter"  → OPENROUTER_API_KEY
#     "openai"      → OPENAI_API_KEY
#     "anthropic"   → ANTHROPIC_API_KEY
#   When unset, the factory falls back to the priority order above.

set -euo pipefail

# ---------------------------------------------------------------------------
# API keys — map LLM_API_KEY as a fallback for all provider key vars.
# Native provider keys take precedence if already set.
# ---------------------------------------------------------------------------
export FORGE_KEY="${FORGE_KEY:-$LLM_API_KEY}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$LLM_API_KEY}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$LLM_API_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$LLM_API_KEY}"

# ---------------------------------------------------------------------------
# Base URL — forward LLM_BASE_URL to OPENAI_URL (OpenAI-compatible format).
# OPENAI_URL is respected by Forge for any OpenAI-compatible provider.
# ---------------------------------------------------------------------------
if [ -n "${LLM_BASE_URL:-}" ]; then
  export OPENAI_URL="${OPENAI_URL:-$LLM_BASE_URL}"
fi

# ---------------------------------------------------------------------------
# Model — Forge has no --model CLI flag. Set the model via config before
# running the prompt so the setting persists for this invocation.
# ---------------------------------------------------------------------------
if [ -n "${LLM_MODEL:-}" ]; then
  forge config set model "$LLM_MODEL" 2>/dev/null || true
fi

forge \
  --agent forge \
  --verbose \
  -p "$(cat "$FACTORY_TASK_PATH")"
