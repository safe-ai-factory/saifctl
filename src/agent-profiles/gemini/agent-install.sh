#!/bin/bash
# Gemini CLI agent setup script.
#
# Installs @google/gemini-cli via npm into the saifctl unprivileged user's
# npm-global prefix. See release-readiness/X-08-P7/P8 + the shared
# helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked npm 2026-03-21): https://www.npmjs.com/package/@google/gemini-cli

GEMINI_CLI_VERSION='0.34.0'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/gemini] Finished Gemini CLI setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/gemini] Installing Gemini CLI (agent-install.sh)..."

if ! command -v npm &>/dev/null; then
  echo "[agent-install/gemini] ERROR: npm is not available in this image." >&2
  echo "[agent-install/gemini] Use a sandbox profile with Node.js or a *-node profile, or bake @google/gemini-cli into a custom --coder-image." >&2
  exit 1
fi

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c "PATH='${SAIFCTL_UNPRIV_NPM_PREFIX}/bin:\$PATH' command -v gemini >/dev/null 2>&1 && gemini --version 2>/dev/null" || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/gemini] gemini already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

echo "[agent-install/gemini] Installing @google/gemini-cli@${GEMINI_CLI_VERSION} into ${SAIFCTL_UNPRIV_NPM_PREFIX} (as ${SAIFCTL_UNPRIV_USER})..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "NPM_CONFIG_PREFIX='${SAIFCTL_UNPRIV_NPM_PREFIX}' npm install -g '@google/gemini-cli@${GEMINI_CLI_VERSION}'"

_after="$(_probe)"
echo "[agent-install/gemini] gemini installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
