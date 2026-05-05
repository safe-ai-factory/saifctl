#!/bin/bash
# saifctl agent helpers — sourced by per-profile agent.sh / agent-install.sh
# scripts inside the coder container. Provides shared drop-privileges
# primitives so each agent profile doesn't re-implement them (release-readiness/X-08-P7/P8).
#
# Mounted at /saifctl/saifctl-agent-helpers.sh by the orchestrator (see the
# `coder-start.sh` co-mount list in src/orchestrator/sandbox.ts:421-426).
#
# All helpers are bash functions, prefixed `saifctl_` to avoid collisions
# with agent CLIs whose names also start with `s`. Sourcing is idempotent:
# re-sourcing replaces the function definitions with identical content.
#
# Contract for callers (per-profile agent.sh):
#
#   #!/bin/bash
#   set -euo pipefail
#   source /saifctl/saifctl-agent-helpers.sh
#   saifctl_assert_unpriv_env
#   saifctl_realign_unpriv_uid
#   # ... resolve API key + other env as root ...
#   ENV_VAR="$value" runuser -l "$SAIFCTL_UNPRIV_USER" \
#     --whitelist-environment="${SAIFCTL_TLS_ENV_NAMES},ENV_VAR,SAIFCTL_UNPRIV_NPM_PREFIX,SAIFCTL_WORKSPACE_BASE" \
#     -c '
#       export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
#       cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"   # see Cwd gotcha below
#       <agent-cli> <args...>
#     ' < /dev/null
#
# Cwd gotcha:
#   `runuser -l` runs the target user's *login shell*, which sets the cwd to
#   that user's $HOME (e.g. `/home/saifctl`) regardless of where the parent
#   process was. Most agent CLIs resolve relative paths in the task prompt
#   against their cwd — without an explicit `cd`, an agent told to read
#   `saifctl/features/foo/spec.md` (a workspace-relative path) will look for
#   `/home/saifctl/saifctl/features/foo/spec.md` and report "file does not
#   exist". The orchestrator exports `SAIFCTL_WORKSPACE_BASE` (set to
#   `/workspace` inside Leash containers; the host code dir under
#   `--engine local`); whitelist it AND `cd` into it as the first line of
#   the inline shell.
#
# `SAIFCTL_TLS_ENV_NAMES` (defined below) MUST be included in every
# `--whitelist-environment` arg. `runuser -l` resets the environment to a
# clean login shell, which strips Leash's MITM CA wiring
# (NODE_EXTRA_CA_CERTS et al.). Without those vars, npm / pip / curl /
# language-runtime HTTP clients in the unprivileged shell fall back to
# their built-in CA stores, which do not trust Leash's intercepting cert,
# and outbound HTTPS fails with `SELF_SIGNED_CERT_IN_CHAIN`. The orchestrator
# already exports these in the container's parent env (see
# src/orchestrator/agent-env.ts buildCoderContainerEnv); the whitelist
# carries them across the runuser boundary.

# ---------------------------------------------------------------------------
# SAIFCTL_TLS_ENV_NAMES
#
# Comma-separated list of env-var names every unprivileged-shell invocation
# MUST whitelist through `runuser`. These carry Leash's MITM CA wiring
# across the privilege drop:
#
#   NODE_EXTRA_CA_CERTS   — Node.js (npm, claude CLI, codex CLI, anything
#                            built on undici / node-fetch / OpenAI SDK).
#   SSL_CERT_FILE         — OpenSSL-linked tools that respect this env
#                            (curl static builds, some go programs).
#   REQUESTS_CA_BUNDLE    — Python `requests` library (also LiteLLM, OpenAI
#                            python SDK, anthropic-sdk-python's HTTPX layer
#                            via this proxy var convention).
#   CURL_CA_BUNDLE        — `curl` binary; also picked up by libcurl-using
#                            tools.
#
# Drop or rename any of these and the corresponding ecosystem will fail
# outbound HTTPS with `SELF_SIGNED_CERT_IN_CHAIN` (or its equivalent in
# that runtime). Defined at the top of this helper file so callers don't
# need to repeat the constant inline.
#
# `readonly` so a per-script accidental reassignment surfaces immediately
# rather than silently truncating the whitelist. Guarded so re-sourcing the
# helpers (the file's documented idempotency contract) doesn't trip the
# "cannot reassign readonly" error.
# ---------------------------------------------------------------------------
if [[ -z "${SAIFCTL_TLS_ENV_NAMES:-}" ]]; then
  readonly SAIFCTL_TLS_ENV_NAMES='NODE_EXTRA_CA_CERTS,SSL_CERT_FILE,REQUESTS_CA_BUNDLE,CURL_CA_BUNDLE'
fi

# ---------------------------------------------------------------------------
# saifctl_assert_unpriv_env
#
# Verify the Dockerfile.coder scaffold (src/sandbox-profiles/*/Dockerfile.coder
# and the contract test src/sandbox-profiles/scaffold-contract.test.ts) has
# exposed the required env vars. Exits with a clear error if not — points
# the operator at the rebuild command rather than letting `runuser`'s opaque
# "user `' does not exist" surface later.
# ---------------------------------------------------------------------------
saifctl_assert_unpriv_env() {
  if [[ -z "${SAIFCTL_UNPRIV_USER:-}" || -z "${SAIFCTL_UNPRIV_NPM_PREFIX:-}" ]]; then
    echo "[saifctl-helpers] ERROR: SAIFCTL_UNPRIV_USER / SAIFCTL_UNPRIV_NPM_PREFIX not set." >&2
    echo "[saifctl-helpers] These are baked into Dockerfile.coder; rebuild the coder image." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# saifctl_realign_unpriv_uid
#
# Linux UID realignment ("fix-attrs" pattern, popularised by gosu/tini and
# linuxserver.io's PUID/PGID convention).
#
# The bind-mounted /workspace is owned by the host process that created the
# sandbox dir. On macOS Docker Desktop, UIDs are translated transparently
# through the virtualisation layer and any container UID can read/write the
# bind mount. On Linux, mapping is strict 1:1: a container `saifctl` at
# UID 1000 cannot write to /workspace if the host process runs as a
# different UID (e.g. CI runners often use UID 1001).
#
# Before dropping privileges, this function realigns the unprivileged
# user's UID/GID in /etc/passwd to match the bind-mount owner. usermod is
# a metadata operation only — it rewrites /etc/passwd inside this
# container's overlay layer, doesn't touch the host or other containers,
# and is cheap (~5 ms). Idempotent: skipped when /workspace owner is
# already saifctl, or when /workspace is owned by root (UID 0) — macOS
# Docker Desktop sometimes presents bind-mount entries as root-owned
# regardless of host UID; realigning saifctl to UID 0 would defeat the
# purpose of dropping privileges.
# ---------------------------------------------------------------------------
saifctl_realign_unpriv_uid() {
  if [[ ! -d /workspace ]]; then return 0; fi
  local ws_uid ws_gid cur_uid cur_gid
  ws_uid="$(stat -c %u /workspace 2>/dev/null || true)"
  ws_gid="$(stat -c %g /workspace 2>/dev/null || true)"
  cur_uid="$(id -u "$SAIFCTL_UNPRIV_USER" 2>/dev/null || true)"
  cur_gid="$(id -g "$SAIFCTL_UNPRIV_USER" 2>/dev/null || true)"
  if [[ -z "$ws_uid" || "$ws_uid" == "0" || "$ws_uid" == "$cur_uid" ]]; then return 0; fi
  echo "[saifctl-helpers] Realigning ${SAIFCTL_UNPRIV_USER} UID ${cur_uid} → ${ws_uid} to match /workspace owner."
  if [[ -n "$ws_gid" && "$ws_gid" != "$cur_gid" ]]; then
    groupmod -g "$ws_gid" "$SAIFCTL_UNPRIV_USER" 2>/dev/null || true
  fi
  usermod -u "$ws_uid" "$SAIFCTL_UNPRIV_USER"
  chown -R "$ws_uid:${ws_gid:-$ws_uid}" "/home/${SAIFCTL_UNPRIV_USER}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# saifctl_drop_privs_init
#
# Convenience: assert env + realign UID. Most agent.sh / agent-install.sh
# scripts want both, in this order. Use this when the caller has nothing
# extra to do between the two steps.
# ---------------------------------------------------------------------------
saifctl_drop_privs_init() {
  saifctl_assert_unpriv_env
  saifctl_realign_unpriv_uid
}

# ---------------------------------------------------------------------------
# saifctl_unpriv_env_whitelist
#
# The canonical set of env-var names every per-profile agent.sh forwards into
# its `runuser --whitelist-environment=…` invocation. Centralised here so a
# new factory-provided env var (or a new provider key the factory wants to
# pass through) is added in one place rather than 14 agent.sh files.
#
# Output: comma-separated list, suitable for direct interpolation.
#
# Categories:
#   - $SAIFCTL_TLS_ENV_NAMES — Leash MITM CA wiring (load-bearing for outbound
#     HTTPS in any unprivileged language runtime; see the constant's docstring).
#   - SAIFCTL_*       — factory plumbing (task path, unpriv user/prefix)
#   - LLM_*           — factory's generic LLM config:
#                       LLM_MODEL    is the full `provider/model[/sub]` string
#                                    (LiteLLM-style; what aider, openhands,
#                                    mini-swe-agent, terminus, deepagents,
#                                    opencode, kilocode, forge consume).
#                       LLM_MODEL_ID is the bare model id with any provider
#                                    prefix stripped (what native single-vendor
#                                    CLIs like Claude Code, Gemini CLI, OpenAI
#                                    Codex, Cursor, Copilot, Qwen want — those
#                                    tools reject `provider/model`).
#                       Each agent.sh picks whichever its CLI accepts; no shell
#                       parsing needed. Mirrors LlmConfig.{fullModelString,
#                       modelId} in src/llm-config.ts 1:1.
#   - <provider>_*    — native provider keys agents may read (auto-fallback path)
#   - <provider>_BASE_URL — native provider URL overrides
#   - GH/GITHUB tokens — copilot's auth path
#
# When using inside an agent.sh:
#
#   runuser -l "$SAIFCTL_UNPRIV_USER" \
#     --whitelist-environment="$(saifctl_unpriv_env_whitelist)" \
#     -c '
#       export PATH="$SAIFCTL_UNPRIV_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
#       <agent-cli> <args>
#     ' < /dev/null
#
# Output ordering: TLS first so a regression in the constant surfaces right
# at the start of the produced list (helpful for `runuser --help` debugging
# when whitelist parsing complains).
# ---------------------------------------------------------------------------
saifctl_unpriv_env_whitelist() {
  echo "${SAIFCTL_TLS_ENV_NAMES},\
SAIFCTL_TASK_PATH,SAIFCTL_UNPRIV_USER,SAIFCTL_UNPRIV_NPM_PREFIX,SAIFCTL_WORKSPACE_BASE,\
LLM_API_KEY,LLM_MODEL,LLM_MODEL_ID,LLM_BASE_URL,LLM_PROVIDER,\
ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,\
OPENAI_API_KEY,OPENAI_BASE_URL,OPENAI_API_BASE,\
OPENROUTER_API_KEY,GEMINI_API_KEY,DASHSCOPE_API_KEY,\
COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN" | tr -d ' \\\n'
}
