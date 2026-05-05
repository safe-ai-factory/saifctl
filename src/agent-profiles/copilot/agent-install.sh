#!/bin/bash
# GitHub Copilot CLI agent setup script.
#
# Installs @github/copilot via npm into the saifctl unprivileged user's
# npm-global prefix. See release-readiness/X-08-P7/P8 + the shared
# helpers at /saifctl/saifctl-agent-helpers.sh for context.
#
# Pinned version (checked npm 2026-03-21): https://www.npmjs.com/package/@github/copilot

COPILOT_CLI_VERSION='1.0.10'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/copilot] Finished Copilot CLI setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/copilot] Installing Copilot CLI (agent-install.sh)..."

if ! command -v npm &>/dev/null; then
  echo "[agent-install/copilot] ERROR: npm is not available in this image." >&2
  echo "[agent-install/copilot] Use a sandbox profile with Node.js or a *-node profile, or bake @github/copilot into a custom --coder-image." >&2
  exit 1
fi

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c "PATH='${SAIFCTL_UNPRIV_NPM_PREFIX}/bin:\$PATH' command -v copilot >/dev/null 2>&1 && copilot --version 2>/dev/null" || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/copilot] copilot already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

echo "[agent-install/copilot] Installing @github/copilot@${COPILOT_CLI_VERSION} into ${SAIFCTL_UNPRIV_NPM_PREFIX} (as ${SAIFCTL_UNPRIV_USER})..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "NPM_CONFIG_PREFIX='${SAIFCTL_UNPRIV_NPM_PREFIX}' npm install -g '@github/copilot@${COPILOT_CLI_VERSION}'"

_after="$(_probe)"
echo "[agent-install/copilot] copilot installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
