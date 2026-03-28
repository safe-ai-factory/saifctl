#!/bin/sh
# reviewer.sh — semantic AI code review via Argus.
# Mounted read-only at /saifctl/reviewer.sh inside the coder container.
# Invoked as `sh /saifctl/reviewer.sh` from coder-start.sh so it runs without +x on the mount.
#
# Environment:
#   REVIEWER_LLM_PROVIDER   — e.g. anthropic, openai, gemini
#   REVIEWER_LLM_MODEL      — e.g. gpt-4o, anthropic/claude-3-5-sonnet for OpenRouter
#   REVIEWER_LLM_API_KEY    — API key for the provider
#   REVIEWER_LLM_BASE_URL   — optional; for OpenAI-compatible custom endpoints
#   SAIFCTL_TASK_PATH       — path to the task file (contains user prompt for verification)
#   SAIFCTL_WORKSPACE_BASE  — /workspace (coder container)
#
# Invoked by gate.sh after static checks pass when SAIFCTL_REVIEWER_SCRIPT is set.

set -e

WORKSPACE="${SAIFCTL_WORKSPACE_BASE:-/workspace}"
TASK_PATH="${SAIFCTL_TASK_PATH:-${WORKSPACE}/.saifctl/task.md}"
# Argus accepts `--config <path>` (default would be repo-root `.argus.toml`);
# Instead we put it in .saifctl/argus.toml. Files in .saifctl/ are excluded from the diff.
ARGUS_CONFIG="${WORKSPACE}/.saifctl/argus.toml"
REVIEW_OUTPUT_JSON="${WORKSPACE}/.saifctl/review_output.json"

# Read the task for the rule prompt (first 2000 chars to avoid huge prompts)
if [ -f "$TASK_PATH" ]; then
  USER_PROMPT=$(head -c 2000 "$TASK_PATH" | tr '\n' ' ')
else
  USER_PROMPT="Implement the changes described in the plan."
fi

# Escape single quotes for the TOML string
USER_PROMPT_ESCAPED=$(echo "$USER_PROMPT" | sed "s/'/''/g")

ARGUS_MODEL="${REVIEWER_LLM_MODEL:-gpt-4o}"

echo "[reviewer] model: $ARGUS_MODEL"

# Build base_url config line if set
BASE_URL_CONFIG=""
if [ -n "${REVIEWER_LLM_BASE_URL:-}" ]; then
  BASE_URL_CONFIG="base_url = \"${REVIEWER_LLM_BASE_URL}\""
  echo "[reviewer] base URL: $REVIEWER_LLM_BASE_URL"
else
  echo "[reviewer] base URL: not set"
fi

# Normalize provider: Argus only knows openai/anthropic/gemini/ollama.
# Any other value (openrouter, together, litellm, etc.) is OpenAI-compatible —
# pass provider=openai and let base_url handle routing.
ARGUS_PROVIDER="${REVIEWER_LLM_PROVIDER:-openai}"
case "$ARGUS_PROVIDER" in
  openai|anthropic|gemini|ollama) ;;
  *) ARGUS_PROVIDER="openai" ;;
esac

echo "[reviewer] provider: $ARGUS_PROVIDER"

mkdir -p "${WORKSPACE}/.saifctl"
# Write Argus TOML to `{workspace}/.saifctl/argus.toml` (path passed via `argus --config`).
cat <<EOF > "$ARGUS_CONFIG"
[llm]
provider = "${ARGUS_PROVIDER}"
model = "${ARGUS_MODEL}"
api_key = "${REVIEWER_LLM_API_KEY}"
$BASE_URL_CONFIG

[review]
fail_on = "warning"
include_suggestions = false
self_reflection = true

[[rules]]
name = "Goal Verification"
severity = "warning"
description = """
You are a strict QA gate. The user originally requested: '$USER_PROMPT_ESCAPED'
Look at the git diff. Did the coding agent completely fulfill this request?
If it missed logic, hallucinated APIs, or failed the request, flag it as 'bug' or 'warning'.
"""

[[rules]]
name = "Idiomatic Code & Maintainability"
severity = "warning"
description = """
You are an adversarial Senior Engineer reviewing a Junior Developer's PR.
Analyze the git diff for "AI-isms" or the "Uncanny Valley of Code":
1. Are there overly complex, bizarre architectural choices where a simple pattern would do?
2. Does the code violate idiomatic patterns of the language/framework being used?
3. Is there unmaintainable "write-only" code (e.g. massive regexes instead of simple parsing, convoluted state management)?
If the code is alien, unnecessarily complex, or unmaintainable, flag it as 'warning' to force a rewrite.
"""
EOF

echo "[reviewer] Running argus doctor..."
argus --config "$ARGUS_CONFIG" doctor

echo "[reviewer] Workspace: $WORKSPACE"
echo "[reviewer] Task path: $TASK_PATH (exists=$([ -f "$TASK_PATH" ] && echo yes || echo no))"

# Git state snapshot — helps diagnose empty-diff issues.
echo "[reviewer] --- git log (all commits) ---"
git -C "$WORKSPACE" log --oneline 2>/dev/null || echo "[reviewer]   (git log failed)"
echo "[reviewer] --- git status ---"
git -C "$WORKSPACE" status --short 2>/dev/null || echo "[reviewer]   (git status failed)"
echo "[reviewer] --- end git state ---"

echo "[reviewer] Staging changes..."
git -C "$WORKSPACE" add .
# Do not commit `.saifctl/` (factory-internal; same idea as extractPatch on the host).
git -C "$WORKSPACE" reset HEAD -- .saifctl 2>/dev/null || true
# Only commit if there's actually something staged
if ! git -C "$WORKSPACE" diff --cached --quiet; then
  echo "[reviewer] Committing changes..."
  # Coder containers often have no git user.* config; match sandbox.ts / extractPatch (GIT_* saifctl@safeaifactory.com).
  git -C "$WORKSPACE" \
    -c user.name=saifctl \
    -c user.email=saifctl@safeaifactory.com \
    commit -m "saifctl: capture uncommitted changes"
fi

# Diff from the factory's initial "Base state" commit (always the root commit,
# created by sandbox.ts before the agent runs) to HEAD.
# This captures all agent changes — including ones the agent committed itself —
# rather than just `git diff HEAD` which would be empty for committed work.
BASE_COMMIT="$(git -C "$WORKSPACE" rev-list --max-parents=0 HEAD 2>/dev/null || true)"
CURRENT_HEAD="$(git -C "$WORKSPACE" rev-parse HEAD 2>/dev/null || true)"

if [ -z "$BASE_COMMIT" ]; then
  echo "[reviewer] WARNING: could not resolve base commit; falling back to git diff HEAD." >&2
  DIFF_CMD="git -C '$WORKSPACE' diff HEAD"
  NAME_ONLY_ARGS="HEAD"
else
  echo "[reviewer] Base commit (Base state): $BASE_COMMIT"
  echo "[reviewer] Current HEAD:             $CURRENT_HEAD"
  if [ "$BASE_COMMIT" = "$CURRENT_HEAD" ]; then
    echo "[reviewer] WARNING: HEAD == base commit — agent made no commits." >&2
  fi
  DIFF_CMD="git -C '$WORKSPACE' diff ${BASE_COMMIT}..HEAD"
  NAME_ONLY_ARGS="${BASE_COMMIT}..HEAD"
fi

echo "[reviewer] Affected files:"
AFFECTED=$(git -C "$WORKSPACE" diff --name-only $NAME_ONLY_ARGS 2>/dev/null || true)
if [ -z "$AFFECTED" ]; then
  echo "[reviewer]   (none — no paths differ from base for this diff)"
  echo "[reviewer] Uncommitted working-tree changes (git diff HEAD --name-only):"
  git -C "$WORKSPACE" diff HEAD --name-only 2>/dev/null | sed 's/^/[reviewer]   /' || true
  echo "[reviewer] Staged changes (git diff --cached --name-only):"
  git -C "$WORKSPACE" diff --cached --name-only 2>/dev/null | sed 's/^/[reviewer]   /' || true
else
  echo "$AFFECTED" | sed 's/^/[reviewer]   /'
fi

echo "[reviewer] Generating AST repo map..."
argus --config "$ARGUS_CONFIG" map --path "$WORKSPACE" --max-tokens 2048

echo "[reviewer] Running semantic review..."
# --verbose: Argus prints review stats (files, LLM calls, comment pipeline) to stderr; JSON stays on stdout.
eval "$DIFF_CMD" | argus --config "$ARGUS_CONFIG" review --repo "$WORKSPACE" --format json --verbose > "$REVIEW_OUTPUT_JSON"
EXIT_CODE=$?

# Always print comments so the log shows what the reviewer said regardless of outcome.
if command -v jq >/dev/null 2>&1; then
  COMMENT_COUNT=$(jq '.comments | length' "$REVIEW_OUTPUT_JSON" 2>/dev/null || echo 0)
  if [ "$COMMENT_COUNT" -gt 0 ]; then
    echo "[reviewer] Comments:"
    jq -r '.comments[] | "[reviewer]   [\(.severity)] \(.file_path):\(.line): \(.message)"' "$REVIEW_OUTPUT_JSON" || true
  else
    echo "[reviewer] No comments."
  fi
else
  cat "$REVIEW_OUTPUT_JSON"
fi

if [ $EXIT_CODE -ne 0 ]; then
  echo "[reviewer] Reviewer found flaws."
  exit 1
fi

echo "[reviewer] Reviewer approved."
exit 0
