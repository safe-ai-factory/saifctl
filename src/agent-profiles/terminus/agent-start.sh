#!/bin/bash
# Terminus agent setup script — installs terminus-ai via pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# Requirements:
#   - Python 3.12+  (Terminus requires >=3.12; earlier versions are not supported)
#   - tmux           (required for terminal session management; Terminus manages
#                     all agent interactions through an interactive tmux session)
#   - pipx
#
# Install docs: https://pypi.org/project/terminus-ai/
# Harbor docs:  https://harborframework.com/docs/agents/terminus-2

set -euo pipefail

if ! command -v python3 &>/dev/null; then
  echo "[agent-start/terminus] ERROR: python3 is not available in this image." >&2
  echo "[agent-start/terminus] Use a Python 3.12+-capable coder image or supply --agent-script with a pre-installed terminus binary." >&2
  exit 1
fi

# Terminus requires Python 3.12+. Fail early with a clear message if the version
# is too old rather than letting a confusing installation error occur later.
_py_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
_py_major="$(echo "$_py_version" | cut -d. -f1)"
_py_minor="$(echo "$_py_version" | cut -d. -f2)"
if [ "$_py_major" -lt 3 ] || { [ "$_py_major" -eq 3 ] && [ "$_py_minor" -lt 12 ]; }; then
  echo "[agent-start/terminus] ERROR: Terminus requires Python 3.12+, found Python ${_py_version}." >&2
  exit 1
fi

# tmux is a hard requirement — Terminus uses it as its sole interaction tool with
# the environment. Without it the agent cannot execute any commands.
if ! command -v tmux &>/dev/null; then
  echo "[agent-start/terminus] tmux not found — attempting to install..." >&2
  if command -v apt-get &>/dev/null; then
    apt-get install -y tmux
  elif command -v dnf &>/dev/null; then
    dnf install -y tmux
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm tmux
  else
    echo "[agent-start/terminus] ERROR: Cannot install tmux automatically. Please install tmux manually." >&2
    exit 1
  fi
fi
echo "[agent-start/terminus] tmux is available: $(tmux -V)"

if ! command -v pipx &>/dev/null; then
  echo "[agent-start/terminus] pipx not found — installing via pip..."
  python3 -m pip install pipx
  python3 -m pipx ensurepath
  export PATH="$HOME/.local/bin:$PATH"
fi

if command -v terminus &>/dev/null; then
  echo "[agent-start/terminus] terminus is already installed: $(terminus --version 2>/dev/null || echo 'unknown version')"
else
  echo "[agent-start/terminus] Installing terminus-ai via pipx..."
  pipx install terminus-ai
  export PATH="$HOME/.local/bin:$PATH"
  echo "[agent-start/terminus] terminus installed: $(terminus --version 2>/dev/null || echo 'unknown version')"
fi
