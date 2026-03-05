#!/bin/bash
# mini-SWE-agent setup script — installs mini-swe-agent via pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# Requirements: Python 3 and pipx must be available in the coder image.
# If they are not present (e.g. a Node-only image), this script will fail with
# a clear error — use a Python-capable coder image.
#
# Install docs: https://mini-swe-agent.com/latest/quickstart/

set -euo pipefail

if ! command -v python3 &>/dev/null; then
  echo "[agent-start/mini-swe-agent] ERROR: python3 is not available in this image." >&2
  echo "[agent-start/mini-swe-agent] Use a Python-capable coder image or supply --agent-script with a pre-installed mini binary." >&2
  exit 1
fi

if ! command -v pipx &>/dev/null; then
  echo "[agent-start/mini-swe-agent] pipx not found — installing via pip..."
  python3 -m pip install pipx
  python3 -m pipx ensurepath
  export PATH="$HOME/.local/bin:$PATH"
fi

if command -v mini &>/dev/null; then
  echo "[agent-start/mini-swe-agent] mini is already installed: $(mini --version 2>/dev/null || echo 'unknown version')"
else
  echo "[agent-start/mini-swe-agent] Installing mini-swe-agent via pipx..."
  pipx install mini-swe-agent
  export PATH="$HOME/.local/bin:$PATH"
  echo "[agent-start/mini-swe-agent] mini installed: $(mini --version 2>/dev/null || echo 'unknown version')"
fi
