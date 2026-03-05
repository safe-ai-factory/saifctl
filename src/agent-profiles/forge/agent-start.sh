#!/bin/bash
# Forge Code agent setup script — installs the forge binary via the official install script.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (FACTORY_AGENT_START_SCRIPT in coder-start.sh).
#
# Forge is a compiled Rust binary distributed via a curl install script.
# No Node.js, Python, or other runtime is required.
#
# Install docs:   https://forgecode.dev/docs
# CLI reference:  https://forgecode.dev/docs/cli-reference/
# Env config:     https://forgecode.dev/docs/environment-configuration/

set -euo pipefail

if command -v forge &>/dev/null; then
  echo "[agent-start/forge] forge is already installed: $(forge --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

if ! command -v curl &>/dev/null; then
  echo "[agent-start/forge] ERROR: curl is not available in this image." >&2
  echo "[agent-start/forge] Install curl or supply --agent-script with a pre-installed forge binary." >&2
  exit 1
fi

echo "[agent-start/forge] Installing forge via official install script..."
curl -fsSL https://forgecode.dev/cli | sh

# The install script drops the binary into ~/.local/bin or /usr/local/bin.
# Ensure PATH includes both common locations.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

echo "[agent-start/forge] forge installed: $(forge --version 2>/dev/null || echo 'unknown version')"
