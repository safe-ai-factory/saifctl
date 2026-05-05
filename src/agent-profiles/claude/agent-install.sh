#!/bin/bash
# Claude Code agent setup script.
#
# Claude Code 2.x refuses `--dangerously-skip-permissions` when running as
# root for security reasons. Saifctl coder containers default to root (Leash
# bootstrap requires it), so we install Claude Code into a non-root user's
# npm-global prefix and the agent.sh wrapper drops privileges to that user
# before invoking claude. The user (`$SAIFCTL_UNPRIV_USER`) and prefix
# (`$SAIFCTL_UNPRIV_NPM_PREFIX`) are pre-created in every Dockerfile.coder
# under src/sandbox-profiles/. The shared helpers at
# /saifctl/saifctl-agent-helpers.sh take care of asserting these env vars
# are set and realigning the user's UID for Linux strict bind-mount mapping
# (release-readiness/X-08-P7/P8).
#
# Pinned version (checked npm 2026-03-21): https://www.npmjs.com/package/@anthropic-ai/claude-code

CLAUDE_CLI_VERSION='2.1.81'

set -euo pipefail
trap 'ec=$?; echo "[agent-install/claude] Finished Claude Code setup (agent-install.sh, exit code ${ec})."' EXIT

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

echo "[agent-install/claude] Installing Claude Code (agent-install.sh)..."

if ! command -v npm &>/dev/null; then
  echo "[agent-install/claude] ERROR: npm is not available in this image." >&2
  echo "[agent-install/claude] Use a sandbox profile with Node.js (e.g. node-pnpm-python) or a *-node profile, or bake @anthropic-ai/claude-code into a custom --coder-image." >&2
  exit 1
fi

# Probe the unprivileged user's PATH for an existing claude binary. Keep the
# probe tolerant: a missing/older `runuser` build (busybox-based images) falls
# back to `su -`. Fast-path skips reinstall when the pinned version is already
# present.
_claude_probe() {
  runuser -l "$SAIFCTL_UNPRIV_USER" -c 'command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null' \
    || su - "$SAIFCTL_UNPRIV_USER" -c 'command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null' \
    || true
}

_existing="$(_claude_probe)"
if [[ -n "$_existing" ]]; then
  echo "[agent-install/claude] claude is already available for ${SAIFCTL_UNPRIV_USER}: ${_existing}"
  exit 0
fi

echo "[agent-install/claude] Installing @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} into ${SAIFCTL_UNPRIV_NPM_PREFIX} (as ${SAIFCTL_UNPRIV_USER})..."
# Whitelist = central helper output (TLS env, factory plumbing, provider keys)
# + NPM_CONFIG_PREFIX so the install lands in the user's writable tree
# regardless of any inherited npmrc. The TLS subset is non-negotiable: Leash
# proxies registry.npmjs.org through its MITM CA, and without
# NODE_EXTRA_CA_CERTS in the unprivileged shell, npm bails with
# `SELF_SIGNED_CERT_IN_CHAIN`.
NPM_CONFIG_PREFIX="${SAIFCTL_UNPRIV_NPM_PREFIX}" \
  runuser -l "$SAIFCTL_UNPRIV_USER" \
    --whitelist-environment="$(saifctl_unpriv_env_whitelist),NPM_CONFIG_PREFIX" \
    -c "npm install -g '@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}'"

_after="$(_claude_probe)"
echo "[agent-install/claude] claude is available for ${SAIFCTL_UNPRIV_USER}: ${_after:-unknown version}"
