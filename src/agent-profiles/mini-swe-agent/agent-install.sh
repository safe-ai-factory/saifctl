#!/bin/bash
# mini-SWE-agent setup script — installs mini-swe-agent via uv tool install as
# the saifctl unprivileged user. See release-readiness/X-08-P7/P8 + the
# shared helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/mini-swe-agent/ — mini-swe-agent==2.2.7
#   Requires-Python: >=3.10  →  install with CPython 3.13 (pinned).

MINI_SWE_PACKAGE_VERSION='2.2.7'
MINI_SWE_PYTHON_PIN='3.13'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/mini-swe-agent] Finished mini-SWE-agent setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/mini-swe-agent] Installing mini-SWE-agent (agent-install.sh)..."

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v mini >/dev/null 2>&1 && mini --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/mini-swe-agent] mini already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v uv &>/dev/null; then
  echo "[agent-install/mini-swe-agent] ERROR: uv is not available in this image." >&2
  echo "[agent-install/mini-swe-agent] Use a uv-capable sandbox profile (python-uv*) or bake mini-swe-agent into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/mini-swe-agent] Installing mini-swe-agent==${MINI_SWE_PACKAGE_VERSION} via uv (Python ${MINI_SWE_PYTHON_PIN}) as ${SAIFCTL_UNPRIV_USER}..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "uv tool install 'mini-swe-agent==${MINI_SWE_PACKAGE_VERSION}' --python '${MINI_SWE_PYTHON_PIN}'"

_after="$(_probe)"
echo "[agent-install/mini-swe-agent] mini installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
