#!/bin/bash
# Deep Agents CLI setup script — installs deepagents-cli via uv tool.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Pinned versions (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/deepagents-cli/ — deepagents-cli==0.0.34
#   Requires-Python: >=3.11,<4  →  we install with CPython 3.13 (pinned).
#
# uv is the preferred installer (`--python 3.13` downloads 3.13 if missing).
# pipx / pip fallbacks require python3.13 on PATH unless uv is used.
#
# The CLI binary is `deepagents`.
#
# Install docs:   https://docs.langchain.com/oss/python/deepagents/cli
# CLI reference:  https://docs.langchain.com/oss/python/deepagents/cli
# Providers:      https://docs.langchain.com/oss/python/deepagents/cli/providers

DEEPAGENTS_PACKAGE_VERSION='0.0.34'
DEEPAGENTS_PYTHON_PIN='3.13'
DEEPAGENTS_SPEC="deepagents-cli[anthropic,groq,openrouter]==${DEEPAGENTS_PACKAGE_VERSION}"

set -euo pipefail
trap 'ec=$?; echo "[agent-install/deepagents] Finished deepagents setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/deepagents] Installing deepagents (agent-install.sh)..."

if command -v deepagents &>/dev/null; then
  echo "[agent-install/deepagents] deepagents is already installed: $(deepagents --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

# Try different package managers (uv → pipx → pip)
if command -v uv &>/dev/null; then
  # UV
  echo "[agent-install/deepagents] Installing ${DEEPAGENTS_SPEC} via uv tool install (Python ${DEEPAGENTS_PYTHON_PIN})..."
  uv tool install "${DEEPAGENTS_SPEC}" --python "${DEEPAGENTS_PYTHON_PIN}"
  export PATH="$HOME/.local/bin:$PATH"
elif command -v pipx &>/dev/null; then
  # pipx
  if command -v "python${DEEPAGENTS_PYTHON_PIN}" &>/dev/null; then
    echo "[agent-install/deepagents] Installing via pipx (python${DEEPAGENTS_PYTHON_PIN})..."
    pipx install "${DEEPAGENTS_SPEC}" --python "$(command -v "python${DEEPAGENTS_PYTHON_PIN}")"
  else
    echo "[agent-install/deepagents] ERROR: pipx needs python${DEEPAGENTS_PYTHON_PIN} on PATH, or install uv." >&2
    exit 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
elif command -v "python${DEEPAGENTS_PYTHON_PIN}" &>/dev/null; then
  # pip
  echo "[agent-install/deepagents] uv/pipx not found — installing via pip (python${DEEPAGENTS_PYTHON_PIN})..."
  "python${DEEPAGENTS_PYTHON_PIN}" -m pip install --user "${DEEPAGENTS_SPEC}"
  export PATH="$HOME/.local/bin:$PATH"
else
  echo "[agent-install/deepagents] ERROR: Need uv, pipx + python${DEEPAGENTS_PYTHON_PIN}, or python${DEEPAGENTS_PYTHON_PIN} for pip." >&2
  exit 1
fi

echo "[agent-install/deepagents] deepagents installed: $(deepagents --version 2>/dev/null || echo 'unknown version')"
