#!/bin/bash
# Aider agent setup script — installs Aider via uv or pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Pinned versions (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/aider-chat/ — aider-chat==0.86.2
#   Requires-Python: <3.13,>=3.10  →  cannot use Python 3.13 with latest release; use 3.12.
#   `uv tool install ... --python 3.12` downloads 3.12 if the image lacks it.
#
# Installation order: uv → pipx (python3.12) → pip (python3.12).
AIDER_PACKAGE_VERSION='0.86.2'
AIDER_PYTHON_PIN='3.12'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/aider] Finished Aider setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/aider] Installing Aider (agent-install.sh)..."

if command -v aider &>/dev/null; then
  echo "[agent-install/aider] Aider is already installed: $(aider --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

echo "[agent-install/aider] Installing aider-chat==${AIDER_PACKAGE_VERSION} (Python ${AIDER_PYTHON_PIN}; PyPI excludes 3.13 for this release)..."

# Try different package managers
if command -v uv &>/dev/null; then
  # UV
  echo "[agent-install/aider] Installing via uv tool install..."
  uv tool install "aider-chat==${AIDER_PACKAGE_VERSION}" --python "${AIDER_PYTHON_PIN}"
  export PATH="$HOME/.local/bin:$PATH"
  # symlink — coder-start may not have ~/.local/bin on PATH
  ln -sf "$(readlink -f "$HOME/.local/bin/aider")" /usr/local/bin/aider
else
  # pipx
  if ! command -v pipx &>/dev/null; then
    # bootstrap pipx
    if ! command -v python3 &>/dev/null; then
      echo "[agent-install/aider] ERROR: python3 is not available to bootstrap pipx." >&2
      exit 1
    fi
    echo "[agent-install/aider] pipx not found — installing via pip..."
    python3 -m pip install pipx
    python3 -m pipx ensurepath
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if command -v pipx &>/dev/null; then
    # interpreter for pipx --python (<3.13 for this package)
    if command -v "python${AIDER_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/aider] Installing via pipx (python${AIDER_PYTHON_PIN})..."
      pipx install "aider-chat==${AIDER_PACKAGE_VERSION}" --python "$(command -v "python${AIDER_PYTHON_PIN}")"
    else
      echo "[agent-install/aider] ERROR: pipx needs python${AIDER_PYTHON_PIN} on PATH, or install uv." >&2
      echo "[agent-install/aider] PyPI aider-chat==${AIDER_PACKAGE_VERSION} requires Python <3.13." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
    ln -sf "$(readlink -f "$HOME/.local/bin/aider")" /usr/local/bin/aider
  else
    # pip
    if command -v "python${AIDER_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/aider] Installing via pip (python${AIDER_PYTHON_PIN})..."
      "python${AIDER_PYTHON_PIN}" -m pip install --user "aider-chat==${AIDER_PACKAGE_VERSION}"
    else
      echo "[agent-install/aider] ERROR: need uv, pipx + python${AIDER_PYTHON_PIN}, or python${AIDER_PYTHON_PIN} for pip." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
    # symlink (best-effort if /usr/local/bin not writable)
    ln -sf "$(readlink -f "$HOME/.local/bin/aider")" /usr/local/bin/aider 2>/dev/null || true
  fi
fi

echo "[agent-install/aider] Aider installed: $(aider --version 2>/dev/null || echo 'unknown version')"
