#!/bin/bash
# Kilo Code CLI agent setup script.
#
# Installs @kilocode/cli via npm into the saifctl unprivileged user's
# npm-global prefix. See release-readiness/X-08-P7/P8 + the shared
# helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Requires Node.js 20.18.1+ (LTS) — the project's .nvmrc minimum.
# Docs: https://kilocode.ai/docs/cli
#
# On older CPUs without AVX support (Intel Xeon Nehalem, AMD Bulldozer, etc.)
# the standard npm package will crash with "Illegal instruction". In that case,
# download the -baseline variant from GitHub releases manually.
#
# Pinned version (checked npm 2026-03-21): https://www.npmjs.com/package/@kilocode/cli
KILOCODE_CLI_VERSION='7.1.0'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/kilocode] Finished Kilo Code CLI setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/kilocode] Installing Kilo Code CLI (agent-install.sh)..."

if ! command -v npm &>/dev/null; then
  echo "[agent-install/kilocode] ERROR: npm is not available in this image." >&2
  echo "[agent-install/kilocode] Install Node.js 20.18.1+ or supply --agent-script with a pre-installed kilo binary." >&2
  exit 1
fi

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c "PATH='${SAIFCTL_UNPRIV_NPM_PREFIX}/bin:\$PATH' command -v kilo >/dev/null 2>&1 && kilo --version 2>/dev/null" || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/kilocode] kilo already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

echo "[agent-install/kilocode] Installing @kilocode/cli@${KILOCODE_CLI_VERSION} into ${SAIFCTL_UNPRIV_NPM_PREFIX} (as ${SAIFCTL_UNPRIV_USER})..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "NPM_CONFIG_PREFIX='${SAIFCTL_UNPRIV_NPM_PREFIX}' npm install -g '@kilocode/cli@${KILOCODE_CLI_VERSION}'"

_after="$(_probe)"
echo "[agent-install/kilocode] kilo installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
