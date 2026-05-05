#!/bin/bash
# coder-start.sh — inner agentic loop; copied into the sandbox and bind-mounted at /saifctl/coder-start.sh.
#
# Runtime requirements (all SaifCTL coder target images — profile Dockerfile.coder — should provide these):
#   - bash on PATH  — this script is bash; gate scripts are invoked as `bash "$GATE_SCRIPT"`.
#   - sh on PATH    — semantic reviewer is invoked as `sh "$SAIFCTL_REVIEWER_SCRIPT"` when set.
#
# Runs the agent script for one or more subtasks, then calls /saifctl/gate.sh after each round.
# For multi-subtask runs the host sets SAIFCTL_ENABLE_SUBTASK_SEQUENCE and delivers subsequent task
# prompts via SAIFCTL_NEXT_SUBTASK_PATH and signals completion via SAIFCTL_SUBTASK_EXIT_PATH; the
# container stays alive between subtasks. When SAIFCTL_ENABLE_SUBTASK_SEQUENCE is unset, the
# container exits 0 after the first successful subtask (single-task / legacy behavior).
#
# If the gate passes (exit 0), the subtask completes successfully.
# If the agent script or the gate (or reviewer) fails, the failure output is appended
# to the task prompt and the agent is re-invoked, up to the effective gate retry count.
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
#   SAIFCTL_ENABLE_SUBTASK_SEQUENCE — when set to a non-empty value, after each successful subtask
#                                 wait for SAIFCTL_SUBTASK_EXIT_PATH or SAIFCTL_NEXT_SUBTASK_PATH.
#                                 When unset, exit 0 after the first successful subtask.
#   SAIFCTL_NEXT_SUBTASK_PATH  — (optional) path the host writes the next subtask prompt to between
#                                 subtasks. Shell polls this file after writing the done signal.
#                                 default: subtask-next.md next to task.md.
#   SAIFCTL_SUBTASK_DONE_PATH  — (optional) path where this script writes the subtask exit code
#                                 after each subtask's inner loop completes. Host polls this.
#                                 default: subtask-done next to task.md.
#   SAIFCTL_SUBTASK_EXIT_PATH  — (optional) path the host creates to signal clean termination.
#                                 When present, the shell exits 0 after completing the current subtask.
#                                 default: subtask-exit next to task.md.
#   SAIFCTL_SUBTASK_RETRIES_PATH — (optional) path the host writes a positive integer to override
#                                 SAIFCTL_GATE_RETRIES for the next subtask only. Consumed on read.
#                                 default: subtask-retries next to task.md.
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
NEXT_SUBTASK_PATH="${SAIFCTL_NEXT_SUBTASK_PATH:-$(dirname "$TASK_PATH")/subtask-next.md}"
SUBTASK_DONE_PATH="${SAIFCTL_SUBTASK_DONE_PATH:-$(dirname "$TASK_PATH")/subtask-done}"
SUBTASK_EXIT_PATH="${SAIFCTL_SUBTASK_EXIT_PATH:-$(dirname "$TASK_PATH")/subtask-exit}"
SUBTASK_RETRIES_PATH="${SAIFCTL_SUBTASK_RETRIES_PATH:-$(dirname "$TASK_PATH")/subtask-retries}"

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

# One subtask: inner agent → gate → optional reviewer loop, up to effective_retries rounds.
# Args: initial_task effective_retries subtask_label
# Returns 0 on success, 1 on failure.
run_subtask() {
  local INITIAL_TASK="$1"
  local effective_retries="$2"
  local subtask_label="$3"

  mkdir -p "$(dirname "$ROUNDS_STATS_PATH")"
  printf '' > "$ROUNDS_STATS_PATH"
  mkdir -p "$(dirname "$PENDING_RULES_PATH")"
  printf '' > "$PENDING_RULES_PATH"

  local round=0
  local current_task="$INITIAL_TASK"
  local gate_output gate_exit round_started_at
  local agent_output agent_exit agent_tmpfile pending_content

  while [ "$round" -lt "$effective_retries" ]; do
    round=$((round + 1))
    round_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "[coder-start] ===== ${subtask_label} Round $round/$effective_retries${SAIFCTL_RUN_ID:+ (run $SAIFCTL_RUN_ID)} ====="

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
      echo "[coder-start] Agent FAILED (round $round/$effective_retries, exit $agent_exit):"
      log_inner_round_summary agent_failed "$agent_output"
      if [ "$round" -ge "$effective_retries" ]; then
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
        return 0
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
        return 0
      else
        # Log and proceed to error branch.
        echo "[coder-start] Reviewer FAILED (round $round/$effective_retries):"
        log_inner_round_summary reviewer_failed "$gate_output"
      fi
    else
      # Log and proceed to error branch.
      echo "[coder-start] Gate FAILED (round $round/$effective_retries):"
      log_inner_round_summary gate_failed "$gate_output"
    fi

    ######################
    # Failure branch: append the output to the task prompt and retry.
    ######################

    # If we've reached the max number of retries, exit with failure.
    if [ "$round" -ge "$effective_retries" ]; then
      break
    fi

    # Rebuild prompt: original task + failure feedback.
    current_task="$(printf '%s\n\n## Validation Failed — Fix Before Finishing\n\n```\n%s\n```\n\nFix the above issues.' \
      "$INITIAL_TASK" "$gate_output")"
  done

  echo "[coder-start] Exhausted $effective_retries inner round(s) without success (${subtask_label})."
  return 1
}

#
# Last-resort signal — fires on ANY exit path (clean, error, signal). Without
# this, a `set -e` death between the subtask inner loop and the explicit
# `printf > $SUBTASK_DONE_PATH` line would leave the host driver
# (`pollSubtaskDone`) polling forever for a file that never appears, which
# in turn deadlocks `Promise.all([engine, driver])` in `runCodingPhase`.
#
# The orchestrator-side fix (SAIFCTL_ENGINE_EXITED_REASON) is the authoritative
# safety net for cases where even this trap can't fire (SIGKILL, container
# torn down). This script-level handshake is the cleaner protocol that lets
# the orchestrator distinguish "shell died with known exit code" from
# "container vanished".
#
# `_subtask_done_signaled` is set by the explicit happy-path write so the
# trap is a no-op when the script reached the normal write line successfully.
_subtask_done_signaled=0
write_subtask_done_signal() {
  local code="$1"
  if [ "$_subtask_done_signaled" -eq 1 ]; then return 0; fi
  _subtask_done_signaled=1
  # Best-effort: never fail the trap itself (we are dying anyway).
  rm -f "$SUBTASK_DONE_PATH" 2>/dev/null || true
  printf '%d' "$code" > "$SUBTASK_DONE_PATH" 2>/dev/null || true
}

main() {
  # `subtask_exit` is the *intended* exit code of the most recently completed
  # subtask. The trap reads it on unexpected exit; defaults to 1 (failure).
  # shellcheck disable=SC2034 # consumed by the trap, set inside the loop.
  local subtask_exit=1
  trap 'write_subtask_done_signal "${subtask_exit:-1}"' EXIT

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

  local current_task="$SAIFCTL_INITIAL_TASK"
  local subtask_num=0
  local effective_retries retries_val subtask_label

  while true; do
    # Reset per-iteration signaling state. `subtask_exit` defaults to 1 so
    # that a death anywhere in this iteration (before `run_subtask` even
    # starts, between iterations, etc.) is reported as failure rather than
    # carrying the previous subtask's exit code into a false "succeeded"
    # signal for the next subtask.
    _subtask_done_signaled=0
    subtask_exit=1

    subtask_num=$((subtask_num + 1))
    subtask_label="Subtask $subtask_num"
    echo "[coder-start] ===== $subtask_label ====="

    effective_retries="$GATE_RETRIES"
    if [ -f "$SUBTASK_RETRIES_PATH" ] && [ -s "$SUBTASK_RETRIES_PATH" ]; then
      retries_val="$(cat "$SUBTASK_RETRIES_PATH")"
      rm -f "$SUBTASK_RETRIES_PATH"
      if printf '%s' "$retries_val" | grep -qE '^[1-9][0-9]*$'; then
        effective_retries="$retries_val"
        echo "[coder-start] Per-subtask gate retries override: $effective_retries"
      else
        echo "[coder-start] WARNING: ignored invalid subtask-retries value: $retries_val" >&2
      fi
    fi

    set +e
    run_subtask "$current_task" "$effective_retries" "$subtask_label"
    subtask_exit=$?
    set -e

    # Happy-path explicit write — also marks the trap as a no-op for this
    # iteration. We keep both paths so a successful run produces a single
    # `Wrote done signal.` log line and a deterministic file mtime.
    write_subtask_done_signal "$subtask_exit"
    echo "[coder-start] $subtask_label done (exit $subtask_exit). Wrote done signal."

    if [ "$subtask_exit" -ne 0 ]; then
      echo "[coder-start] $subtask_label FAILED — exiting." >&2
      exit 1
    fi

    echo "[coder-start] $subtask_label COMPLETED successfully."

    # Without multi-subtask sequencing, exit after first success (matches pre–Phase 6 host behavior).
    if [ -z "${SAIFCTL_ENABLE_SUBTASK_SEQUENCE:-}" ]; then
      exit 0
    fi

    echo "[coder-start] Waiting for next instruction (next subtask or exit signal)..."
    while true; do
      if [ -f "$SUBTASK_EXIT_PATH" ]; then
        echo "[coder-start] Exit signal received — all subtasks complete."
        exit 0
      fi
      if [ -f "$NEXT_SUBTASK_PATH" ] && [ -s "$NEXT_SUBTASK_PATH" ]; then
        break
      fi
      sleep 1
    done

    current_task="$(cat "$NEXT_SUBTASK_PATH")"
    mv "$NEXT_SUBTASK_PATH" "${NEXT_SUBTASK_PATH}.consumed.${subtask_num}"
    echo "[coder-start] Received subtask $((subtask_num + 1)) prompt."
  done
}

main "$@"
