#!/bin/bash
# Claude Code agent script — runs Claude with the task read from $SAIFCTL_TASK_PATH.
#
# Part of the claude agent profile. Selected via --agent claude.
# coder-start.sh writes the current task to $SAIFCTL_TASK_PATH before each invocation.
#
# CLI reference: https://code.claude.com/docs/en/cli-reference
#
# Why we drop privileges:
#   Claude Code 2.x refuses `--dangerously-skip-permissions` when running as
#   the root user (security guard against accidental privilege escalation in
#   the agent's tool invocations). The saifctl coder container defaults to
#   root because Leash's bootstrap mounts (/leash, /log, /cfg) are root-owned
#   on the host. Running the entire container as a non-root user breaks
#   Leash; running just `claude …` as a non-root user side-steps the guard
#   without affecting the rest of the round.
#
#   `$SAIFCTL_UNPRIV_USER` and `$SAIFCTL_UNPRIV_NPM_PREFIX` are baked into
#   every Dockerfile.coder under src/sandbox-profiles/. agent-install.sh
#   installs the claude CLI into that prefix; this script `runuser`s into
#   the same user to invoke it.
#
# Model and API key:
#   Claude expects ANTHROPIC_API_KEY. The factory provides LLM_API_KEY (generic) and
#   LLM_MODEL_ID (bare model id; LLM_MODEL is the prefixed form for LiteLLM-style
#   agents and would be rejected by Claude Code's CLI as "model not found"). We
#   fall back to LLM_API_KEY when ANTHROPIC_API_KEY is not set, and pass
#   LLM_MODEL_ID via --model to override Claude's default.
#
#   Note: Claude Code does not support a generic base URL override. Custom endpoints
#   are only available for specific integrations (Azure Foundry: ANTHROPIC_FOUNDRY_BASE_URL,
#   AWS Bedrock: AWS_BEARER_TOKEN_BEDROCK, etc.). LLM_BASE_URL is not forwarded here.
#
# Key flags:
#   -p / --print               Non-interactive (headless) mode: process prompt and exit.
#   --model                    Override the model for this session.
#   --dangerously-skip-permissions
#                              Skip all permission prompts (required for headless use).
#   --output-format stream-json
#                              Emit newline-delimited JSON events; compatible with the
#                              factory's log parsing and lets the loop stream progress.
#   --verbose                  Show full turn-by-turn output in the log.
#   --no-session-persistence   Do not save this session to disk; each factory round is
#                              independent and sessions should not accumulate.
#   --disable-slash-commands   Prevent task text from being interpreted as Claude Code
#                              slash commands.
#
# No --max-turns is set, so Claude runs until it naturally finishes the task.

set -euo pipefail

echo "[agent/claude] Starting agent claude in agent.sh..."

# Drop-privileges scaffold: assert env vars + realign UID. See header
# comment ("Why we drop privileges") for context. Implementation lives in
# the shared helper (sourced once per agent.sh invocation).
# shellcheck source=/dev/null
source /saifctl/saifctl-agent-helpers.sh
saifctl_drop_privs_init

# Resolve the API key once, then forward it via env to the unprivileged shell.
# Read the task file as root (it lives under /workspace/.saifctl/, which is
# typically writable by everyone but we don't depend on that here).
_API_KEY="${ANTHROPIC_API_KEY:-${LLM_API_KEY:-}}"
if [[ -z "$_API_KEY" ]]; then
  echo "[agent/claude] ERROR: neither ANTHROPIC_API_KEY nor LLM_API_KEY is set." >&2
  exit 1
fi
_TASK_CONTENT="$(cat "$SAIFCTL_TASK_PATH")"

_SAIFCTL_TASK_SNIP="$_TASK_CONTENT"
if [ "${#_SAIFCTL_TASK_SNIP}" -gt 200 ]; then
  _SAIFCTL_TASK_SNIP="${_SAIFCTL_TASK_SNIP:0:200}..."
fi
echo "[agent/claude] About to run (as ${SAIFCTL_UNPRIV_USER}): claude -p \"${_SAIFCTL_TASK_SNIP}\" --model \"${LLM_MODEL_ID}\" --dangerously-skip-permissions --output-format stream-json --verbose --no-session-persistence --disable-slash-commands"

# Run claude as the unprivileged user. `runuser -l` resets HOME/PATH/etc.
# to the target user's login env; we re-export the env vars claude needs.
# Stdin is closed (`< /dev/null`) so claude doesn't pause 3s waiting for it.
# The task content goes via env var (not piped) to avoid quoting hazards.
#
# `SAIFCTL_TLS_ENV_NAMES` carries Leash's MITM CA wiring across the
# privilege drop — without it, claude's HTTP client (anthropic-sdk-node,
# undici-based) hits `SELF_SIGNED_CERT_IN_CHAIN` against api.anthropic.com.
# See the helpers file header for the rationale.
_agent_exit=0
# Whitelist = central helper output (TLS env, factory plumbing, provider keys
# including LLM_MODEL_ID) + SAIFCTL_TASK_CONTENT (passed via env to avoid
# prompt quoting hazards). LLM_MODEL_ID — not LLM_MODEL — is what Claude's
# CLI accepts; LLM_MODEL is the prefixed form (`anthropic/claude-haiku-4-5`)
# the LiteLLM-style agents need.
SAIFCTL_TASK_CONTENT="$_TASK_CONTENT" \
  ANTHROPIC_API_KEY="$_API_KEY" \
  SAIFCTL_UNPRIV_NPM_PREFIX="$SAIFCTL_UNPRIV_NPM_PREFIX" \
  runuser -l "$SAIFCTL_UNPRIV_USER" \
    --whitelist-environment="$(saifctl_unpriv_env_whitelist),SAIFCTL_TASK_CONTENT" \
    -c '
      export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$PATH"
      # cd into the workspace; runuser -l defaults cwd to /home/saifctl, but
      # claude resolves task-prompt relative paths against cwd. See the cwd
      # gotcha in /saifctl/saifctl-agent-helpers.sh.
      cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"
      claude -p "$SAIFCTL_TASK_CONTENT" \
        --model "$LLM_MODEL_ID" \
        --dangerously-skip-permissions \
        --output-format stream-json \
        --verbose \
        --no-session-persistence \
        --disable-slash-commands
    ' < /dev/null || _agent_exit=$?

echo "[agent/claude] Finished agent claude in agent.sh (exit code ${_agent_exit})."
exit "${_agent_exit}"
