#!/bin/bash
# Terminus agent setup script — installs terminus-ai via uv or pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Pinned versions (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/terminus-ai/ — terminus-ai==2.0.4
#   Requires-Python: >=3.12  →  we install with CPython 3.13 (pinned).
#
# Requirements:
#   - tmux (required for terminal session management)
#   - uv (preferred) or pipx + python3.13, or python3.13 for pip fallback
#
# Install docs: https://pypi.org/project/terminus-ai/
# Harbor docs:  https://harborframework.com/docs/agents/terminus-2

TERMINUS_PACKAGE_VERSION='2.0.4'
TERMINUS_PYTHON_PIN='3.13'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/terminus] Finished Terminus setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/terminus] Installing Terminus (agent-install.sh)..."

if ! command -v python3 &>/dev/null; then
  echo "[agent-install/terminus] ERROR: python3 is not available in this image." >&2
  echo "[agent-install/terminus] Use a Python-capable coder image or supply --agent-script with a pre-installed terminus binary." >&2
  exit 1
fi

# PyPI requires >=3.12; uv/pipx below use pinned 3.13
_py_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
_py_major="$(echo "$_py_version" | cut -d. -f1)"
_py_minor="$(echo "$_py_version" | cut -d. -f2)"
if [ "$_py_major" -lt 3 ] || { [ "$_py_major" -eq 3 ] && [ "$_py_minor" -lt 12 ]; }; then
  echo "[agent-install/terminus] ERROR: Terminus requires Python 3.12+, found Python ${_py_version}." >&2
  exit 1
fi

# tmux is a hard requirement — Terminus uses it as its sole interaction tool with
# the environment. Without it the agent cannot execute any commands.
if ! command -v tmux &>/dev/null; then
  echo "[agent-install/terminus] tmux not found — attempting to install..." >&2
  # apt / dnf / pacman
  if command -v apt-get &>/dev/null; then
    apt-get install -y tmux
  elif command -v dnf &>/dev/null; then
    dnf install -y tmux
  elif command -v pacman &>/dev/null; then
    pacman -S --noconfirm tmux
  else
    echo "[agent-install/terminus] ERROR: Cannot install tmux automatically. Please install tmux manually." >&2
    exit 1
  fi
fi
echo "[agent-install/terminus] tmux is available: $(tmux -V)"

if command -v terminus &>/dev/null; then
  echo "[agent-install/terminus] terminus is already installed: $(terminus --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

echo "[agent-install/terminus] Installing terminus-ai==${TERMINUS_PACKAGE_VERSION} (Python ${TERMINUS_PYTHON_PIN})..."

# Try different package managers
if command -v uv &>/dev/null; then
  # UV
  echo "[agent-install/terminus] Installing via uv tool install..."
  uv tool install "terminus-ai==${TERMINUS_PACKAGE_VERSION}" --python "${TERMINUS_PYTHON_PIN}"
  export PATH="$HOME/.local/bin:$PATH"
else
  # pipx
  if ! command -v pipx &>/dev/null; then
    # bootstrap pipx
    echo "[agent-install/terminus] pipx not found — installing via pip..."
    python3 -m pip install pipx
    python3 -m pipx ensurepath
    export PATH="$HOME/.local/bin:$PATH"
  fi

  # pipx
  if command -v pipx &>/dev/null; then
    # interpreter for pipx --python
    if command -v "python${TERMINUS_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/terminus] Installing via pipx (python${TERMINUS_PYTHON_PIN})..."
      pipx install "terminus-ai==${TERMINUS_PACKAGE_VERSION}" --python "$(command -v "python${TERMINUS_PYTHON_PIN}")"
    else
      echo "[agent-install/terminus] ERROR: pipx needs python${TERMINUS_PYTHON_PIN} on PATH, or install uv." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
  else
    # pip
    if command -v "python${TERMINUS_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/terminus] Installing via pip (python${TERMINUS_PYTHON_PIN})..."
      "python${TERMINUS_PYTHON_PIN}" -m pip install --user "terminus-ai==${TERMINUS_PACKAGE_VERSION}"
    else
      echo "[agent-install/terminus] ERROR: need uv, pipx + python${TERMINUS_PYTHON_PIN}, or python${TERMINUS_PYTHON_PIN} for pip." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

echo "[agent-install/terminus] terminus installed: $(terminus --version 2>/dev/null || echo 'unknown version')"
