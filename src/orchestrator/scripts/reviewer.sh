#!/bin/sh
# reviewer.sh — semantic AI code review via Argus.
# Mounted read-only at /saifac/reviewer.sh inside the coder container.
#
# Environment:
#   REVIEWER_LLM_PROVIDER   — e.g. anthropic, openai, gemini
#   REVIEWER_LLM_MODEL      — e.g. claude-3-opus-20240229
#   REVIEWER_LLM_API_KEY    — API key for the provider
#   REVIEWER_LLM_BASE_URL   — optional; for OpenAI-compatible custom endpoints
#   SAIFAC_TASK_PATH       — path to the task file (contains user prompt for verification)
#   SAIFAC_WORKSPACE_BASE  — /workspace (coder container)
#
# Invoked by gate.sh after static checks pass when SAIFAC_REVIEWER_SCRIPT is set.

set -e

WORKSPACE="${SAIFAC_WORKSPACE_BASE:-/workspace}"
TASK_PATH="${SAIFAC_TASK_PATH:-${WORKSPACE}/.factory_task.md}"

# Read the task for the rule prompt (first 2000 chars to avoid huge prompts)
if [ -f "$TASK_PATH" ]; then
  USER_PROMPT=$(head -c 2000 "$TASK_PATH" | tr '\n' ' ')
else
  USER_PROMPT="Implement the changes described in the plan."
fi

# Escape single quotes for the TOML string
USER_PROMPT_ESCAPED=$(echo "$USER_PROMPT" | sed "s/'/''/g")

# Build base_url config line if set
BASE_URL_CONFIG=""
if [ -n "${REVIEWER_LLM_BASE_URL:-}" ]; then
  BASE_URL_CONFIG="base_url = \"${REVIEWER_LLM_BASE_URL}\""
fi

# Write .argus.toml into workspace
cat <<EOF > "${WORKSPACE}/.argus.toml"
[llm]
provider = "${REVIEWER_LLM_PROVIDER:-openai}"
model = "${REVIEWER_LLM_MODEL:-gpt-4o}"
api_key = "${REVIEWER_LLM_API_KEY}"
$BASE_URL_CONFIG

[review]
fail_on = "warning"
include_suggestions = false
self_reflection = true

[[rules]]
name = "Goal Verification"
prompt = """
You are a strict QA gate. The user originally requested: '$USER_PROMPT_ESCAPED'
Look at the git diff. Did the coding agent completely fulfill this request?
If it missed logic, hallucinated APIs, or failed the request, flag it as 'bug' or 'warning'.
"""

[[rules]]
name = "Idiomatic Code & Maintainability"
prompt = """
You are an adversarial Senior Engineer reviewing a Junior Developer's PR.
Analyze the git diff for "AI-isms" or the "Uncanny Valley of Code":
1. Are there overly complex, bizarre architectural choices where a simple pattern would do?
2. Does the code violate idiomatic patterns of the language/framework being used?
3. Is there unmaintainable "write-only" code (e.g. massive regexes instead of simple parsing, convoluted state management)?
If the code is alien, unnecessarily complex, or unmaintainable, flag it as 'warning' to force a rewrite.
"""
EOF

echo "[reviewer] Generating AST repo map..."
argus map --path "$WORKSPACE" --max-tokens 2048

echo "[reviewer] Running semantic review..."
git -C "$WORKSPACE" diff HEAD | argus review --repo "$WORKSPACE" --format json > "${WORKSPACE}/review_output.json"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "[reviewer] Reviewer found flaws."
  if command -v jq >/dev/null 2>&1; then
    jq -r '.comments[] | "- \(.file_path):\(.line): \(.message)"' "${WORKSPACE}/review_output.json" || true
  else
    cat "${WORKSPACE}/review_output.json"
  fi
  exit 1
fi

echo "[reviewer] Reviewer approved."
exit 0
