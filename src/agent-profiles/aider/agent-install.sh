#!/bin/bash
# Aider agent setup script — installs Aider via uv tool install as the
# saifctl unprivileged user. See specification.md §4.1 X08-P7/P8 + the
# shared helpers at /saifctl/saifctl-agent-helpers.sh for context.
#
# Pinned version (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/aider-chat/ — aider-chat==0.86.2
#   Requires-Python: <3.13,>=3.10  →  use Python 3.12; uv downloads it on demand.

AIDER_PACKAGE_VERSION='0.86.2'
AIDER_PYTHON_PIN='3.12'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/aider] Finished Aider setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/aider] Installing Aider (agent-install.sh)..."

# Probe as the unprivileged user — `uv tool install` lands binaries under
# $HOME/.local/bin which `runuser -l` puts on PATH via `.profile` only on
# some distros. Set PATH explicitly to remove that ambiguity.
_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v aider >/dev/null 2>&1 && aider --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/aider] aider already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v uv &>/dev/null; then
  echo "[agent-install/aider] ERROR: uv is not available in this image." >&2
  echo "[agent-install/aider] Use a uv-capable sandbox profile (python-uv*) or bake aider-chat into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/aider] Installing aider-chat==${AIDER_PACKAGE_VERSION} via uv (Python ${AIDER_PYTHON_PIN}) as ${SAIFCTL_UNPRIV_USER}..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "uv tool install 'aider-chat==${AIDER_PACKAGE_VERSION}' --python '${AIDER_PYTHON_PIN}'"

_after="$(_probe)"
echo "[agent-install/aider] aider installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
