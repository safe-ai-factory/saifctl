#!/bin/bash
# OpenHands agent setup script — installs OpenHands if not already present.
#
# Runs once inside the coder container after the project startup script and
# before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# Installation order (first tool found wins):
#   1. uv tool install openhands   — preferred: fast, isolated, reproducible
#   2. pipx install openhands      — good isolation, needs pipx
#   3. pip install openhands       — fallback: global install
#
# Requirements: Python 3 must be available in the coder image.
# If Python is absent (e.g. a Node-only image), this script will fail with a
# clear error — use a Python-capable coder image or supply --agent-script with
# a pre-installed openhands binary.
#
# Idempotent: if the `openhands` binary is already on PATH, the install step
# is skipped entirely.

set -euo pipefail

if command -v openhands &>/dev/null; then
  echo "[agent-start/openhands] OpenHands already installed: $(openhands --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

if ! command -v python3 &>/dev/null; then
  echo "[agent-start/openhands] ERROR: python3 is not available in this image." >&2
  echo "[agent-start/openhands] Use a Python-capable coder image or supply --agent-script with a pre-installed openhands." >&2
  exit 1
fi

echo "[agent-start/openhands] openhands not found — installing..."

if command -v uv &>/dev/null; then
  echo "[agent-start/openhands] Installing via uv tool install..."
  uv tool install openhands --python python3
  # uv tool binaries land in ~/.local/bin; ensure it is on PATH.
  export PATH="$HOME/.local/bin:$PATH"
  # Symlink into /usr/local/bin so it is reachable from any shell context.
  ln -sf "$(readlink -f "$HOME/.local/bin/openhands")" /usr/local/bin/openhands
elif command -v pipx &>/dev/null; then
  echo "[agent-start/openhands] Installing via pipx..."
  pipx install openhands
  export PATH="$HOME/.local/bin:$PATH"
  ln -sf "$(readlink -f "$HOME/.local/bin/openhands")" /usr/local/bin/openhands
else
  echo "[agent-start/openhands] Installing via pip..."
  python3 -m pip install openhands
fi

echo "[agent-start/openhands] OpenHands installed: $(openhands --version)"
