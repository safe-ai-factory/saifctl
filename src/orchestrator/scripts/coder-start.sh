#!/bin/bash
# coder-start.sh — inner agentic loop; copied into the sandbox and bind-mounted at /saifctl/coder-start.sh.
#
# Runtime requirements (all SaifCTL coder target images — profile Dockerfile.coder — should provide these):
#   - bash on PATH  — this script is bash; gate scripts are invoked as `bash "$GATE_SCRIPT"`.
#   - sh on PATH    — semantic reviewer is invoked as `sh "$SAIFCTL_REVIEWER_SCRIPT"` when set.
#
# Runs the agent script, then calls /saifctl/gate.sh (injected read-only per-run).
# If the gate passes (exit 0), the container exits successfully.
# If the agent script or the gate (or reviewer) fails, the failure output is appended
# to the task prompt and the agent is re-invoked, up to SAIFCTL_GATE_RETRIES times.
#
# Environment variables:
#   SAIFCTL_INITIAL_TASK        — the full task prompt (required)
#   SAIFCTL_GATE_RETRIES        — max inner rounds before giving up (default: 5)
#   SAIFCTL_GATE_SCRIPT         — path to the gate script (default: /saifctl/gate.sh)
#   SAIFCTL_STARTUP_SCRIPT      — path to the installation script (required); run once before
#                                 the agent loop. Set via --profile (default: node-pnpm-python) or
#                                 --startup-script.
#   SAIFCTL_AGENT_INSTALL_SCRIPT — (optional) path to an agent install script; run once after
#                                 the startup script and before the agent loop. Use to
#                                 install the coding agent (e.g. pipx install aider-chat).
#                                 When unset or empty, this step is skipped.
#   SAIFCTL_AGENT_SCRIPT        — path to the agent script (default: /saifctl/agent.sh)
#                                 The script is called once per inner round. It must read
#                                 the task from $SAIFCTL_TASK_PATH and run the coding agent.
#   SAIFCTL_TASK_PATH           — path where the current task prompt is written before each
#                                 agent invocation (default: /workspace/.saifctl/task.md).
#                                 Agent scripts should read from this file rather than from
#                                 command-line arguments to avoid escaping and length issues.
#   SAIFCTL_REVIEWER_ENABLED    — when set to a non-empty value, run /saifctl/reviewer.sh after
#                                 the gate passes. If the reviewer fails, the round is treated
#                                 as a gate failure and the agent retries.
#   SAIFCTL_ROUNDS_STATS_PATH     — (optional) JSONL path for inner-round summaries (default:
#                                 `${SAIFCTL_TASK_PATH}/stats.jsonl`).
#   SAIFCTL_PENDING_RULES_PATH    — (optional) markdown file the host appends with human feedback
#                                 between inner rounds (default: `pending-rules.md` next to task.md).
#                                 This script renames the file when consumed so the next round
#                                 picks up only new content.
#   SAIFCTL_RUN_ID                  — (optional) orchestrator run id; echoed in round banners for logs.
#
# Agent stdout boundaries (for host log formatting): one line each, echoed by this script only —
#   [SAIFCTL:AGENT_START]  — before bash "$AGENT_SCRIPT" (streams live via tee)
#   [SAIFCTL:AGENT_END]    — after the agent exits (host applies OpenHands parsing only between these)

set -euo pipefail

# Fail fast if a minimal or misconfigured image omits these (should not happen on supported images).
if ! command -v bash >/dev/null 2>&1; then
  echo "[coder-start] ERROR: bash is required on PATH (SaifCTL coder images provide it)." >&2
  exit 127
fi
if ! command -v sh >/dev/null 2>&1; then
  echo "[coder-start] ERROR: sh is required on PATH (for the semantic reviewer when enabled)." >&2
  exit 127
fi

GATE_SCRIPT="${SAIFCTL_GATE_SCRIPT:-/saifctl/gate.sh}"
AGENT_SCRIPT="${SAIFCTL_AGENT_SCRIPT:-/saifctl/agent.sh}"
GATE_RETRIES="${SAIFCTL_GATE_RETRIES:-5}"
TASK_PATH="${SAIFCTL_TASK_PATH:-/workspace/.saifctl/task.md}"
ROUNDS_STATS_PATH="${SAIFCTL_ROUNDS_STATS_PATH:-$(dirname "$TASK_PATH")/stats.jsonl}"
PENDING_RULES_PATH="${SAIFCTL_PENDING_RULES_PATH:-$(dirname "$TASK_PATH")/pending-rules.md}"

if [ -z "${SAIFCTL_INITIAL_TASK:-}" ]; then
  echo "[coder-start] ERROR: SAIFCTL_INITIAL_TASK is not set." >&2
  exit 1
fi

if [ -z "${SAIFCTL_STARTUP_SCRIPT:-}" ]; then
  echo "[coder-start] ERROR: SAIFCTL_STARTUP_SCRIPT is not set." >&2
  exit 1
fi

if [ ! -f "$SAIFCTL_STARTUP_SCRIPT" ]; then
  echo "[coder-start] ERROR: startup script not found: $SAIFCTL_STARTUP_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$AGENT_SCRIPT" ]; then
  echo "[coder-start] ERROR: agent script not found: $AGENT_SCRIPT" >&2
  exit 1
fi

echo "[coder-start] Running startup script: $SAIFCTL_STARTUP_SCRIPT"
bash "$SAIFCTL_STARTUP_SCRIPT"
echo "[coder-start] Startup script completed."

if [ -n "${SAIFCTL_AGENT_INSTALL_SCRIPT:-}" ]; then
  if [ ! -f "$SAIFCTL_AGENT_INSTALL_SCRIPT" ]; then
    echo "[coder-start] ERROR: agent install script not found: $SAIFCTL_AGENT_INSTALL_SCRIPT" >&2
    exit 1
  fi
  echo "[coder-start] Running agent install script: $SAIFCTL_AGENT_INSTALL_SCRIPT"
  bash "$SAIFCTL_AGENT_INSTALL_SCRIPT"
  echo "[coder-start] Agent install script completed."
fi

# Print one JSON string token for the entire file contents, or "" if no encoder.
# Strips a single trailing newline from encoders that print one (jq, python print, console.log).
# Order: jq when installed (single binary); else python3 / node; else perl (Debian base); else omit body.
json_string_from_file() {
  local path="$1"
  local out
  if command -v jq >/dev/null 2>&1; then
    out="$(jq -Rs '.' < "$path")"
  elif command -v python3 >/dev/null 2>&1; then
    out="$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1],encoding="utf-8",errors="replace").read()))' "$path")"
  elif command -v node >/dev/null 2>&1; then
    out="$(node -e "const fs=require('fs');console.log(JSON.stringify(fs.readFileSync(process.argv[1],'utf8')))" "$path")"
  elif command -v perl >/dev/null 2>&1; then
    # Manually escape the string using Perl.
    out="$(perl -0777 -e '
      my $s = <>;
      $s =~ s/\\/\\\\/g;
      $s =~ s/"/\\"/g;
      $s =~ s/\n/\\n/g;
      $s =~ s/\r/\\r/g;
      $s =~ s/\t/\\t/g;
      $s =~ s/([\x00-\x08\x0B\x0C\x0E-\x1F])/sprintf("\\u%04x", ord($1))/ge;
      print "\"", $s, "\"";
    ' < "$path")"
  else
    out='""'
  fi
  printf '%s' "${out%$'\n'}"
}

# Capture round stats and append to the JSONL file.
log_inner_round_summary() {
  local phase="$1" # agent_failed | gate_passed | gate_failed | reviewer_passed | reviewer_failed
  local out="${2-}" # raw stderr+stdout from agent, gate, or reviewer on failure (may be huge / multiline)
  local completed_at
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$ROUNDS_STATS_PATH")"

  # Cap log size and avoid hand-escaping arbitrary bytes for JSON.
  local truncated
  truncated="$(printf '%s' "$out" | head -c 2000)"
  local gate_output_json
  if [ -n "$truncated" ]; then
    # Truncate and escape the output.
    local tmp
    tmp="$(mktemp)"
    printf '%s' "$truncated" > "$tmp"
    gate_output_json="$(json_string_from_file "$tmp")"
    rm -f "$tmp"
  else
    # No output: set "gateOutput": null
    gate_output_json=null
  fi

  # Format the JSON line.
  local line
  line="$(printf '{"type":"inner_round","round":%s,"phase":"%s","startedAt":"%s","completedAt":"%s","gateOutput":%s}' \
    "$round" "$phase" "$round_started_at" "$completed_at" "$gate_output_json")"
  printf '%s\n' "$line" >> "$ROUNDS_STATS_PATH"
}

main() {
  local INITIAL_TASK="$SAIFCTL_INITIAL_TASK"
  local round=0
  local current_task="$INITIAL_TASK"
  local gate_output gate_exit round_started_at
  local agent_output agent_exit

  while [ "$round" -lt "$GATE_RETRIES" ]; do
    round=$((round + 1))
    round_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[coder-start] ===== Round $round/$GATE_RETRIES${SAIFCTL_RUN_ID:+ (run $SAIFCTL_RUN_ID)} ====="

    # Human feedback queued on the host (e.g. `saifctl run rules create` while the agent runs).
    if [ -f "$PENDING_RULES_PATH" ] && [ -s "$PENDING_RULES_PATH" ]; then
      pending_content="$(cat "$PENDING_RULES_PATH")"
      mv "$PENDING_RULES_PATH" "${PENDING_RULES_PATH}.consumed.${round}"
      current_task="$(printf '%s\n\n## Human Feedback\n\n%s' "$current_task" "$pending_content")"
      echo "[coder-start] Applied pending human feedback (round $round)."
    fi

    # Write the current task to SAIFCTL_TASK_PATH so the agent script can read it.
    # Agent scripts must consume the task from this file (not from env var or CLI args).
    export SAIFCTL_TASK_PATH="$TASK_PATH"
    mkdir -p "$(dirname "$TASK_PATH")"
    printf '%s' "$current_task" > "$TASK_PATH"

    # This is where we call the actual agent, e.g. OpenHands, Aider, Claude, Codex, etc.
    # Instead of calling openhands directly, we call the agent script - a bash script
    # that can contain anything. This way we can use any agent, not just OpenHands.
    # Stream to stdout (tee) so the host sees live output; keep a copy for failure feedback.
    # The command is wrapped in blocks like [SAIFCTL:AGENT_START] so we can foramt the agent's
    # output differently for differnet agents. E.g. OpenHands uses JSON, Aider uses Markdown.
    echo "[coder-start] Running agent: $AGENT_SCRIPT"
    agent_tmpfile="$(mktemp)"
    printf '%s\n' '[SAIFCTL:AGENT_START]'
    set +e
    bash "$AGENT_SCRIPT" 2>&1 | tee "$agent_tmpfile"
    agent_exit="${PIPESTATUS[0]}"
    set -e
    printf '%s\n' '[SAIFCTL:AGENT_END]'
    agent_output="$(cat "$agent_tmpfile")"
    rm -f "$agent_tmpfile"

    # Agent script failed, log and retry.
    if [ "$agent_exit" -ne 0 ]; then
      echo "[coder-start] Agent FAILED (round $round/$GATE_RETRIES, exit $agent_exit):"
      log_inner_round_summary agent_failed "$agent_output"
      if [ "$round" -ge "$GATE_RETRIES" ]; then
        break
      fi
      current_task="$(printf '%s\n\n## Agent Script Failed (exit %s)\n\n```\n%s\n```\n\nFix the above issues.' \
        "$INITIAL_TASK" "$agent_exit" "$agent_output")"
      continue
    fi

    echo "[coder-start] Agent completed."

    if [ -f "$GATE_SCRIPT" ]; then
      echo "[coder-start] Running gate: $GATE_SCRIPT"
      # Use explicit bash: bind-mounted scripts may lack +x (e.g. from the host filesystem).
      # Capture stdout+stderr; preserve exit code without triggering set -e.
      gate_output=$(bash "$GATE_SCRIPT" 2>&1) && gate_exit=0 || gate_exit=$?
    else
      # If no gate scripts, still set gate_exit to 0 so we proceed to the reviewer.
      echo "[coder-start] No gate script at $GATE_SCRIPT — skipping static checks."
      gate_output=""
      gate_exit=0
    fi

    # Print captured output from gate.sh if not empty.
    if [ -n "${gate_output:-}" ]; then
      printf '%s\n' "$gate_output"
    fi

    # User-supplied gate script succeeded, now let's run the semantic reviewer (argus-ai) if enabled.
    if [ "$gate_exit" -eq 0 ]; then
      # Success branch: No reviewer configured.
      if [ -z "${SAIFCTL_REVIEWER_ENABLED:-}" ]; then
        log_inner_round_summary gate_passed ""
        echo "[coder-start] Gate PASSED."
        exit 0
      fi

      REVIEWER_SCRIPT="/saifctl/reviewer.sh"
      # Use explicit sh: reviewer.sh is mounted read-only and may not be +x.
      echo "[coder-start] Running semantic reviewer: $REVIEWER_SCRIPT"
      gate_output=$(sh "$REVIEWER_SCRIPT" 2>&1) && gate_exit=0 || gate_exit=$?

      # Print captured output from reviewer.sh if not empty.
      if [ -n "${gate_output:-}" ]; then
        printf '%s\n' "$gate_output"
      fi

      # Success branch: both gate and reviewer passed.
      if [ "$gate_exit" -eq 0 ]; then
        log_inner_round_summary reviewer_passed ""
        echo "[coder-start] Gate PASSED (static checks + reviewer)."
        exit 0
      else
        # Log and proceed to error branch.
        echo "[coder-start] Reviewer FAILED (round $round/$GATE_RETRIES):"
        log_inner_round_summary reviewer_failed "$gate_output"
      fi
    else
      # Log and proceed to error branch.
      echo "[coder-start] Gate FAILED (round $round/$GATE_RETRIES):"
      log_inner_round_summary gate_failed "$gate_output"
    fi

    ######################
    # Failure branch: append the output to the task prompt and retry.
    ######################

    # If we've reached the max number of retries, exit with failure.
    if [ "$round" -ge "$GATE_RETRIES" ]; then
      break
    fi

    # Rebuild prompt: original task + failure feedback.
    current_task="$(printf '%s\n\n## Validation Failed — Fix Before Finishing\n\n```\n%s\n```\n\nFix the above issues.' \
      "$INITIAL_TASK" "$gate_output")"
  done

  echo "[coder-start] Exhausted $GATE_RETRIES inner round(s) without success."
  exit 1
}

main "$@"
