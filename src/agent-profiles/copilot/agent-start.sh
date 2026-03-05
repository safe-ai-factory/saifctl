#!/bin/bash
# Copilot CLI agent setup script.
#
# Copilot CLI is installed via npm if not already present.
# This script ensures it is available and exits with a clear error if npm is missing.
#
# Installation docs: https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-in-the-cli

set -euo pipefail

if command -v copilot &>/dev/null; then
  echo "[agent-start/copilot] copilot CLI is already installed: $(copilot --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

if ! command -v npm &>/dev/null; then
  echo "[agent-start/copilot] ERROR: npm is not available in this image." >&2
  echo "[agent-start/copilot] Install Node.js 22+ or supply --agent-script with a pre-installed copilot binary." >&2
  exit 1
fi

echo "[agent-start/copilot] Installing @github/copilot via npm..."
npm install -g @github/copilot
echo "[agent-start/copilot] copilot CLI installed: $(copilot --version 2>/dev/null || echo 'unknown version')"
