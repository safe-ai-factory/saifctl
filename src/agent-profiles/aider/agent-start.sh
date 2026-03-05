#!/bin/bash
# Aider agent setup script — installs Aider via pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# Requirements: Python 3 and pipx must be available in the coder image.
# If they are not present (e.g. a Node-only image), this script will fail with
# a clear error — use a Python-capable coder image or install aider manually.

set -euo pipefail

if ! command -v python3 &>/dev/null; then
  echo "[agent-start/aider] ERROR: python3 is not available in this image." >&2
  echo "[agent-start/aider] Use a Python-capable coder image or supply --agent-script with a pre-installed aider." >&2
  exit 1
fi

if ! command -v pipx &>/dev/null; then
  echo "[agent-start/aider] pipx not found — installing via pip..."
  python3 -m pip install pipx
  python3 -m pipx ensurepath
  export PATH="$HOME/.local/bin:$PATH"
fi

if command -v aider &>/dev/null; then
  echo "[agent-start/aider] Aider is already installed: $(aider --version 2>/dev/null || echo 'unknown version')"
else
  echo "[agent-start/aider] Installing aider-chat via pipx..."
  pipx install aider-chat
  export PATH="$HOME/.local/bin:$PATH"
  ln -sf "$(readlink -f "$HOME/.local/bin/aider")" /usr/local/bin/aider
  echo "[agent-start/aider] Aider installed: $(aider --version)"
fi
