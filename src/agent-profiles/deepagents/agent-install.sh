#!/bin/bash
# Deep Agents CLI setup script — installs deepagents-cli via uv tool install as
# the saifctl unprivileged user. See specification.md §4.1 X08-P7/P8 + the
# shared helpers at /saifctl/saifctl-agent-helpers.sh.
#
# Pinned version (checked PyPI 2026-03-21):
#   https://pypi.org/pypi/deepagents-cli/ — deepagents-cli==0.0.34
#   Requires-Python: >=3.11,<4  →  install with CPython 3.13 (pinned).

DEEPAGENTS_PACKAGE_VERSION='0.0.34'
DEEPAGENTS_PYTHON_PIN='3.13'
DEEPAGENTS_SPEC="deepagents-cli[anthropic,groq,openrouter]==${DEEPAGENTS_PACKAGE_VERSION}"

set -euo pipefail
trap 'ec=$?; echo "[agent-install/deepagents] Finished deepagents setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/deepagents] Installing deepagents (agent-install.sh)..."

_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'export PATH="$HOME/.local/bin:$PATH"; command -v deepagents >/dev/null 2>&1 && deepagents --version 2>/dev/null' || true
}

_existing="$(_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/deepagents] deepagents already installed for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

if ! command -v uv &>/dev/null; then
  echo "[agent-install/deepagents] ERROR: uv is not available in this image." >&2
  echo "[agent-install/deepagents] Use a uv-capable sandbox profile (python-uv*) or bake deepagents-cli into a custom --coder-image." >&2
  exit 1
fi

echo "[agent-install/deepagents] Installing ${DEEPAGENTS_SPEC} via uv (Python ${DEEPAGENTS_PYTHON_PIN}) as ${SAIFCTL_UNPRIV_USER}..."
runuser -l "$SAIFCTL_UNPRIV_USER" -c "uv tool install '${DEEPAGENTS_SPEC}' --python '${DEEPAGENTS_PYTHON_PIN}'"

_after="$(_probe)"
echo "[agent-install/deepagents] deepagents installed for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
