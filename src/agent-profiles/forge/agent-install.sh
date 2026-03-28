#!/bin/bash
# Forge Code agent setup script — installs the forge binary via the official install script.
#
# Runs once inside the coder container after the project startup script
# and before the agent loop begins (SAIFCTL_AGENT_INSTALL_SCRIPT in coder-start.sh).
#
# Forge is a compiled Rust binary distributed via a curl install script.
# No Node.js, Python, or other runtime is required.
#
# Install docs:   https://forgecode.dev/docs
# CLI reference:  https://forgecode.dev/docs/cli-reference/
# Env config:     https://forgecode.dev/docs/environment-configuration/
#
# Pinned release (checked GitHub 2026-03-21): https://github.com/antinomyhq/forge/releases
# The upstream install script accepts a version argument:  curl … | sh -s -- vX.Y.Z
FORGE_RELEASE_VERSION='v2.1.0'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/forge] Finished forge setup (agent-install.sh, exit code ${ec})."' EXIT
echo "[agent-install/forge] Installing forge (agent-install.sh)..."

if command -v forge &>/dev/null; then
  echo "[agent-install/forge] forge is already installed: $(forge --version 2>/dev/null || echo 'unknown version')"
  exit 0
fi

if ! command -v curl &>/dev/null; then
  echo "[agent-install/forge] ERROR: curl is not available in this image." >&2
  echo "[agent-install/forge] Install curl or supply --agent-script with a pre-installed forge binary." >&2
  exit 1
fi

echo "[agent-install/forge] Installing forge ${FORGE_RELEASE_VERSION} via official install script..."
curl -fsSL https://forgecode.dev/cli | sh -s -- "${FORGE_RELEASE_VERSION}"

# The install script drops the binary into ~/.local/bin or /usr/local/bin.
# Ensure PATH includes both common locations.
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

echo "[agent-install/forge] forge installed: $(forge --version 2>/dev/null || echo 'unknown version')"
