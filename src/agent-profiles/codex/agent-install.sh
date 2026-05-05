#!/bin/bash
# Codex agent setup script.
#
# Installs @openai/codex via npm into the saifctl unprivileged user's
# npm-global prefix. See release-readiness/X-08-P7/P8 for why every
# agent runs unprivileged; the shared scaffold lives at
# /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked npm 2026-03-21): https://www.npmjs.com/package/@openai/codex

CODEX_CLI_VERSION='0.116.0'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/codex] Finished Codex setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/codex] Installing Codex (agent-install.sh)..."

if ! command -v npm &>/dev/null; then
  echo "[agent-install/codex] ERROR: npm is not available in this image." >&2
  echo "[agent-install/codex] Use a sandbox profile with Node.js (e.g. node-pnpm-python) or a *-node profile, or bake @openai/codex into a custom --coder-image." >&2
  exit 1
fi

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c "PATH='${SAIFCTL_UNPRIV_NPM_PREFIX}/bin:\$PATH' command -v codex >/dev/null 2>&1 && codex --version 2>/dev/null" || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/codex] codex already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

echo "[agent-install/codex] Installing @openai/codex@${CODEX_CLI_VERSION} into ${SAIFCTL_UNPRIV_NPM_PREFIX} (as ${SAIFCTL_UNPRIV_USER})..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "NPM_CONFIG_PREFIX='${SAIFCTL_UNPRIV_NPM_PREFIX}' npm install -g '@openai/codex@${CODEX_CLI_VERSION}'"

_after="$(_probe)"
echo "[agent-install/codex] codex installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
