#!/bin/bash
# Forge Code agent setup script — installs the forge binary as the saifctl
# unprivileged user via the official curl install script. See
# release-readiness/X-08-P7/P8 + /saifctl/saifctl-agent-helpers.sh.
#
# Pinned release (checked GitHub 2026-03-21): https://github.com/antinomyhq/forge/releases
# The upstream install script accepts a version argument:  curl … | sh -s -- vX.Y.Z

FORGE_RELEASE_VERSION='v2.1.0'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/forge] Finished forge setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/forge] Installing forge (agent-install.sh)..."

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"; command -v forge >/dev/null 2>&1 && forge --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/forge] forge already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v curl &>/dev/null; then
  echo "[agent-install/forge] ERROR: curl is not available in this image." >&2
  echo "[agent-install/forge] Install curl or supply --agent-script with a pre-installed forge binary." >&2
  exit 1
fi

echo "[agent-install/forge] Installing forge ${FORGE_RELEASE_VERSION} via official install script (as ${SAIFCTL_UNPRIV_USER})..."
# Forge's install script may try /usr/local/bin first (root only) and fall back
# to ~/.local/bin. As saifctl, /usr/local writes will fail and the fallback
# kicks in — landing the binary at $HOME/.local/bin/forge.
runuser -l "$SAIFCTL_UNPRIV_USER" -c "curl -fsSL https://forgecode.dev/cli | sh -s -- '${FORGE_RELEASE_VERSION}'"

_after="$(_probe)"
if [[ -z "$_after" ]]; then
  echo "[agent-install/forge] ERROR: forge binary not found after install." >&2
  echo "[agent-install/forge]   Expected at /home/${SAIFCTL_UNPRIV_USER}/.local/bin/forge." >&2
  exit 1
fi
echo "[agent-install/forge] forge installed for ${SAIFCTL_UNPRIV_USER}: ${_after}"
