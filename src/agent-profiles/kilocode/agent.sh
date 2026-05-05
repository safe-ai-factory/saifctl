#!/bin/bash
# Kilo Code CLI agent script — runs kilo with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the kilocode agent profile. Selected via --agent kilocode.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# Drop-privileges: see claude/agent.sh and /saifctl/saifctl-agent-helpers.sh
# for the shared scaffold (X08-P7/P8).
#
# Kilo CLI is a fork of OpenCode and inherits its config/provider model.
# CLI reference:    https://kilocode.ai/docs/cli
# Config reference: https://opencode.ai/docs/config  (shared schema)
#
# === Invocation ===
#   kilo run [message..]   Non-interactive: runs with a message and exits.
#   --auto                 Autonomous mode: disables all permission prompts. All
#                          approval requests are handled automatically based on
#                          the inline permission config (set to "allow" below).
#                          Required for headless factory use.
#
# === Permissions ===
#   Kilo uses a JSON "permission" config key rather than a CLI flag. We inject
#   {"permission":"allow"} via OPENCODE_CONFIG_CONTENT. Equivalent to --yolo.
#
# === Model / Provider / API key ===
#   Kilo uses the OpenCode provider config format. We inject the full provider
#   config via OPENCODE_CONFIG_CONTENT as JSON so no config file needs to exist
#   in the project. Provider id comes from LLM_PROVIDER, falling back to the
#   prefix of LLM_MODEL when in provider/model format.

set -euo pipefail

echo "[agent/kilocode] Starting agent kilocode in agent.sh..."

# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

# Build OPENCODE_CONFIG_CONTENT as root so we can use bash arrays / parameter
# expansion comfortably; forward as a single env var into the runuser shell.
if [ -n "${LLM_PROVIDER:-}" ]; then
  _provider="$LLM_PROVIDER"
elif [ -n "${LLM_MODEL:-}" ] && [[ "$LLM_MODEL" == */* ]]; then
  _provider="${LLM_MODEL%%/*}"
else
  _provider=""
fi

# Build provider config block only when we have a provider to configure.
# Sets apiKey from LLM_API_KEY and optionally baseURL from LLM_BASE_URL.
if [ -n "$_provider" ]; then
  _base_url_fragment=""
  if [ -n "${LLM_BASE_URL:-}" ]; then
    _base_url_fragment=",\"baseURL\":\"${LLM_BASE_URL}\""
  fi
  _provider_block="\"provider\":{\"${_provider}\":{\"options\":{\"apiKey\":\"${LLM_API_KEY}\"${_base_url_fragment}}}}"
else
  # No provider could be determined; skip provider config. Kilo will use
  # whatever credentials are already configured in the user's global config.
  if [ -n "${LLM_API_KEY:-}" ]; then
    echo "[agent/kilocode] WARNING: LLM_API_KEY is set but no provider could be determined." >&2
    echo "[agent/kilocode]   Set --provider (e.g. --provider anthropic) to enable API key forwarding." >&2
  fi
  _provider_block=""
fi

# Build the model fragment if LLM_MODEL is set.
if [ -n "${LLM_MODEL:-}" ]; then
  _model_fragment="\"model\":\"${LLM_MODEL}\","
else
  _model_fragment=""
fi

# Assemble the inline config and inject via OPENCODE_CONFIG_CONTENT.
# permission:"allow" sets all tools to auto-allow (no prompts).
# autoupdate:false suppresses self-update attempts during factory runs.
_provider_sep=""
[ -n "$_provider_block" ] && _provider_sep=","

export OPENCODE_CONFIG_CONTENT="{${_model_fragment}\"permission\":\"allow\",\"autoupdate\":false${_provider_sep}${_provider_block}}"

_SAIFCTL_TASK_SNIP="$(cat "$SAIFCTL_TASK_PATH" 2>/dev/null || true)"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
_kilo_cfg_redacted="$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed 's/"apiKey":"[^"]*"/"apiKey":"****"/g; s/"baseURL":"[^"]*"/"baseURL":"****"/g')"
echo "[agent/kilocode] About to run (as ${SAIFCTL_UNPRIV_USER}): OPENCODE_CONFIG_CONTENT='${_kilo_cfg_redacted}' kilo run --auto \"${_SAIFCTL_TASK_SNIP}\""

# Forward the constructed config alongside the standard whitelist.
_agent_exit=0
runuser -l "$SAIFCTL_UNPRIV_USER" \
  --whitelist-environment="$(saifctl_unpriv_env_whitelist),OPENCODE_CONFIG_CONTENT" \
  -c '
    set -euo pipefail
    export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
    cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"  # see cwd gotcha in /saifctl/saifctl-agent-helpers.sh
    kilo run \
      --auto \
      "$(cat "$SAIFCTL_TASK_PATH")"
  ' < /dev/null || _agent_exit=$?

echo "[agent/kilocode] Finished agent kilocode in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
