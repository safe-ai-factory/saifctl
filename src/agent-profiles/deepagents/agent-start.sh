#!/bin/bash
# Deep Agents CLI setup script — installs deepagents-cli via uv tool.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# deepagents-cli is a Python package distributed via PyPI.
# uv is the preferred installer; pip/pipx are used as fallbacks.
#
# The CLI binary is `deepagents`.
#
# Install docs:   https://docs.langchain.com/oss/python/deepagents/cli
# CLI reference:  https://docs.langchain.com/oss/python/deepagents/cli
# Providers:      https://docs.langchain.com/oss/python/deepagents/cli/providers

set -euo pipefail

if command -v deepagents &>/dev/null; then
  echo "[agent-start/deepagents] deepagents is already installed: $(deepagents --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

# ---------------------------------------------------------------------------
# Prefer uv (fastest, hermetic). Fall back to pipx, then pip.
# ---------------------------------------------------------------------------
if command -v uv &>/dev/null; then
  echo "[agent-start/deepagents] Installing deepagents-cli via uv tool install..."
  # Include the most common provider extras so the CLI works out of the box.
  # openai is included by default; anthropic and groq cover the next most common cases.
  uv tool install 'deepagents-cli[anthropic,groq,openrouter]'
  export PATH="$HOME/.local/bin:$PATH"
elif command -v pipx &>/dev/null; then
  echo "[agent-start/deepagents] Installing deepagents-cli via pipx..."
  pipx install 'deepagents-cli[anthropic,groq,openrouter]'
  export PATH="$HOME/.local/bin:$PATH"
elif command -v python3 &>/dev/null; then
  echo "[agent-start/deepagents] uv/pipx not found — installing via pip..."
  python3 -m pip install --user 'deepagents-cli[anthropic,groq,openrouter]'
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[agent-start/deepagents] ERROR: Neither uv, pipx, nor python3 is available in this image." >&2
  echo "[agent-start/deepagents] Use a Python-capable coder image or supply --agent-script with a pre-installed deepagents binary." >&2
  exit 1
fi

echo "[agent-start/deepagents] deepagents installed: $(deepagents --version 2>/dev/null || echo 'unknown version')"
