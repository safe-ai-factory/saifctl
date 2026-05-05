#!/bin/bash
# OpenHands agent setup script — installs openhands via uv tool install as the
# saifctl unprivileged user. See release-readiness/X-08-P7/P8 + the shared
# helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/openhands/ — openhands==1.13.1
#   Requires-Python: ==3.12.*  →  uv downloads 3.12 on demand.

OPENHANDS_PACKAGE_VERSION='1.13.1'
OPENHANDS_PYTHON_PIN='3.12'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/openhands] Finished OpenHands setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/openhands] Installing OpenHands (agent-install.sh)..."

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v openhands >/dev/null 2>&1 && openhands --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/openhands] openhands already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v uv &>/dev/null; then
  echo "[agent-install/openhands] ERROR: uv is not available in this image." >&2
  echo "[agent-install/openhands] Use a uv-capable sandbox profile (python-uv*) or bake openhands into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/openhands] Installing openhands==${OPENHANDS_PACKAGE_VERSION} via uv (Python ${OPENHANDS_PYTHON_PIN}) as ${SAIFCTL_UNPRIV_USER}..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "uv tool install 'openhands==${OPENHANDS_PACKAGE_VERSION}' --python '${OPENHANDS_PYTHON_PIN}'"

_after="$(_probe)"
echo "[agent-install/openhands] openhands installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
