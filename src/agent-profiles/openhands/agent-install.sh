#!/bin/bash
# OpenHands agent setup script — installs openhands via uv or pipx.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Pinned versions (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/openhands/ — openhands==1.13.1
#   Requires-Python: ==3.12.*  →  CPython 3.12 only (not 3.13; PyPI rejects it).
#   `uv tool install ... --python 3.12` downloads 3.12 if the image lacks it.
#
# Requirements:
#   - Idempotent: if `openhands` is already on PATH, install is skipped
#   - uv (preferred) or pipx + python3.12, or python3.12 for pip fallback
#
# Install docs: https://pypi.org/project/openhands/
# All Hands:    https://github.com/All-Hands-AI/OpenHands

OPENHANDS_PACKAGE_VERSION='1.13.1'
OPENHANDS_PYTHON_PIN='3.12'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/openhands] Finished OpenHands setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/openhands] Installing OpenHands (agent-install.sh)..."

if command -v openhands &>/dev/null; then
  echo "[agent-install/openhands] OpenHands already installed: $(openhands --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

echo "[agent-install/openhands] openhands not found — installing openhands==${OPENHANDS_PACKAGE_VERSION} (Python ${OPENHANDS_PYTHON_PIN})..."

# Log toolchain on stdout (host logs / branch visibility)
_uv_path="$(command -v uv 2>/dev/null || true)"
_pipx_path="$(command -v pipx 2>/dev/null || true)"
_py_path="$(command -v "python${OPENHANDS_PYTHON_PIN}" 2>/dev/null || true)"
echo "[agent-install/openhands] Install toolchain: uv=${_uv_path:-<not on PATH>}, pipx=${_pipx_path:-<not on PATH>}, python${OPENHANDS_PYTHON_PIN}=${_py_path:-<not on PATH>}"
echo "[agent-install/openhands] PATH(head)=${PATH:0:200}..."

# After install, CLI is often under ~/.local/bin; symlink so coder-start always finds it
_saifctl_link_openhands() {
  export PATH="$HOME/.local/bin:$PATH"

  # ~/.local/bin first, else PATH
  local bin="${HOME}/.local/bin/openhands"
  if [ ! -x "$bin" ]; then
    bin="$(command -v openhands 2>/dev/null || true)"
  fi

  if [ -z "$bin" ] || [ ! -x "$bin" ]; then
    echo "[agent-install/openhands] ERROR: openhands binary missing after install (looked for ~/.local/bin/openhands and PATH)."
    return 1
  fi

  # readlink -f when GNU; else raw path
  local real
  real="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
  ln -sf "$real" /usr/local/bin/openhands
  echo "[agent-install/openhands] Linked openhands → /usr/local/bin/openhands (from $bin)"
}

# Try different package managers
if [ -n "$_uv_path" ]; then
  # UV
  echo "[agent-install/openhands] Installing via uv tool install..."
  if ! uv tool install "openhands==${OPENHANDS_PACKAGE_VERSION}" --python "${OPENHANDS_PYTHON_PIN}"; then
    echo "[agent-install/openhands] ERROR: uv tool install failed (see messages above)."
    exit 1
  fi
  _saifctl_link_openhands

elif [ -n "$_pipx_path" ]; then
  # pipx
  if [ -n "$_py_path" ]; then
    echo "[agent-install/openhands] Installing via pipx (interpreter: ${_py_path})..."
    if ! pipx install "openhands==${OPENHANDS_PACKAGE_VERSION}" --python "$_py_path"; then
      echo "[agent-install/openhands] ERROR: pipx install failed (see messages above)."
      exit 1
    fi
    _saifctl_link_openhands
  else
    echo "[agent-install/openhands] ERROR: pipx is available but python${OPENHANDS_PYTHON_PIN} is not on PATH (need uv or that interpreter). PyPI requires ==3.12.*." >&2
    echo "[agent-install/openhands] Hint: image should expose uv or install python${OPENHANDS_PYTHON_PIN} for pipx --python." >&2
    exit 1
  fi

else
  # pip
  if [ -n "$_py_path" ]; then
    echo "[agent-install/openhands] Installing via pip (interpreter: ${_py_path})..."
    if ! "$_py_path" -m pip install --user "openhands==${OPENHANDS_PACKAGE_VERSION}"; then
      echo "[agent-install/openhands] ERROR: pip install failed (see messages above)."
      exit 1
    fi
    _saifctl_link_openhands
  else
    echo "[agent-install/openhands] ERROR: need uv, pipx + python${OPENHANDS_PYTHON_PIN}, or python${OPENHANDS_PYTHON_PIN} for pip." >&2
    exit 1
  fi
fi

echo "[agent-install/openhands] OpenHands installed: $(openhands --version 2>/dev/null || echo 'version check skipped')"
