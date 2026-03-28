#!/bin/bash
# mini-SWE-agent setup script — installs mini-swe-agent via uv or pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Pinned versions (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/mini-swe-agent/ — mini-swe-agent==2.2.7
#   Requires-Python: >=3.10  →  we install with CPython 3.13 (pinned).
#
# Install docs: https://mini-swe-agent.com/latest/quickstart/

MINI_SWE_PACKAGE_VERSION='2.2.7'
MINI_SWE_PYTHON_PIN='3.13'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/mini-swe-agent] Finished mini-SWE-agent setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/mini-swe-agent] Installing mini-SWE-agent (agent-install.sh)..."

if command -v mini &>/dev/null; then
  echo "[agent-install/mini-swe-agent] mini is already installed: $(mini --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

echo "[agent-install/mini-swe-agent] Installing mini-swe-agent==${MINI_SWE_PACKAGE_VERSION} (Python ${MINI_SWE_PYTHON_PIN})..."

# Try different package managers
if command -v uv &>/dev/null; then
  # UV
  echo "[agent-install/mini-swe-agent] Installing via uv tool install..."
  uv tool install "mini-swe-agent==${MINI_SWE_PACKAGE_VERSION}" --python "${MINI_SWE_PYTHON_PIN}"
  export PATH="$HOME/.local/bin:$PATH"
else
  # pipx
  if ! command -v python3 &>/dev/null; then
    echo "[agent-install/mini-swe-agent] ERROR: python3 is not available in this image." >&2
    exit 1
  fi

  if ! command -v pipx &>/dev/null; then
    # bootstrap pipx
    echo "[agent-install/mini-swe-agent] pipx not found — installing via pip..."
    python3 -m pip install pipx
    python3 -m pipx ensurepath
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if command -v pipx &>/dev/null; then
    # interpreter for pipx --python
    if command -v "python${MINI_SWE_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/mini-swe-agent] Installing via pipx (python${MINI_SWE_PYTHON_PIN})..."
      pipx install "mini-swe-agent==${MINI_SWE_PACKAGE_VERSION}" --python "$(command -v "python${MINI_SWE_PYTHON_PIN}")"
    else
      echo "[agent-install/mini-swe-agent] ERROR: pipx needs python${MINI_SWE_PYTHON_PIN} on PATH, or install uv." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
  else
    # pip
    if command -v "python${MINI_SWE_PYTHON_PIN}" &>/dev/null; then
      echo "[agent-install/mini-swe-agent] Installing via pip (python${MINI_SWE_PYTHON_PIN})..."
      "python${MINI_SWE_PYTHON_PIN}" -m pip install --user "mini-swe-agent==${MINI_SWE_PACKAGE_VERSION}"
    else
      echo "[agent-install/mini-swe-agent] ERROR: need uv, pipx + python${MINI_SWE_PYTHON_PIN}, or python${MINI_SWE_PYTHON_PIN} for pip." >&2
      exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

echo "[agent-install/mini-swe-agent] mini installed: $(mini --version 2>/dev/null || echo 'unknown version')"
