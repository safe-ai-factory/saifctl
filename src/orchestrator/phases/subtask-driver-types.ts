import type { InnerRoundSummary } from '../../runs/types.js';

/**
 * Result for one completed subtask inner loop (after `subtask-done` was observed).
 *
 * Lives in a standalone module so {@link ../loop.js} can import it without pulling in
 * types that participate in the `loop` ↔ `run-coding-phase` dependency cycle (which
 * confuses typed lint).
 */
export interface SubtaskCodingResult {
  /** 0-based index into the run's {@link RunArtifact#subtasks}. */
  subtaskIndex: number;
  /**
   * Exit code written by `coder-start.sh` for this subtask's inner loop.
   * `0` = gate (and reviewer if enabled) passed; non-zero = exhausted inner retries or agent failure.
   */
  innerExitCode: number;
  /** Inner round summaries read from `stats.jsonl` immediately after the done signal. */
  innerRounds: InnerRoundSummary[];
}

/**
 * What the host should do after {@link OnSubtaskComplete} runs.
 *
 * For `next` / `retry`, {@link writeSubtaskNextPrompt} is called with `prompt` (full task text for the container).
 */
export type SubtaskDriverAction =
  | {
      kind: 'next';
      /** Written to `saifctl/gate.sh` before the next subtask. */
      gateScript: string;
      /** When set, overwrites `saifctl/agent.sh`. */
      agentScript?: string;
      /** Optional override read from workspace before the next inner loop. */
      gateRetries?: number;
      prompt: string;
    }
  | {
      kind: 'retry';
      prompt: string;
      gateRetries?: number;
    }
  | { kind: 'exit' }
  | { kind: 'abort' };

/** Callback invoked by the subtask driver after each `subtask-done` signal; returns the next {@link SubtaskDriverAction}. */
export type OnSubtaskComplete = (result: SubtaskCodingResult) => Promise<SubtaskDriverAction>;
