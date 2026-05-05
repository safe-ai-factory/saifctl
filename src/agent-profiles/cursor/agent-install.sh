#!/bin/bash
# Cursor CLI agent setup script — installs the Cursor `agent` binary as the
# saifctl unprivileged user. See release-readiness/X-08-P7/P8 + the shared
# helpers at /saifctl/saifctl-agent-helpers.sh.
#
# The official installer drops the binary at $HOME/.local/bin/agent and prints
# instructions to extend PATH. We run it as saifctl so the install lands in
# saifctl's writable home rather than root's.
#
# Installation docs: https://cursor.com/docs/cli/installation

set -euo pipefail
trap 'ec=$?; echo "[agent-install/cursor] Finished Cursor CLI setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/cursor] Installing Cursor CLI (agent-install.sh)..."

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v agent >/dev/null 2>&1 && agent --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/cursor] cursor agent already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v curl &>/dev/null; then
  echo "[agent-install/cursor] ERROR: curl is not available in this image." >&2
  echo "[agent-install/cursor] Install curl or bake the cursor agent binary into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/cursor] Downloading and running Cursor CLI installer (as ${SAIFCTL_UNPRIV_USER})..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c 'curl https://cursor.com/install -fsS | bash'

_after="$(_probe)"
if [[ -z "$_after" ]]; then
  echo "[agent-install/cursor] ERROR: cursor agent binary not found after install." >&2
  echo "[agent-install/cursor]   Expected at /home/${SAIFCTL_UNPRIV_USER}/.local/bin/agent." >&2
  exit 1
fi
echo "[agent-install/cursor] cursor agent installed for ${SAIFCTL_UNPRIV_USER}: ${_after}"
