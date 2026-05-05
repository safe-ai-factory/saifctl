/**
 * Bridge between the in-sandbox inner loop (`coder-start.sh`) and the host orchestrator.
 *
 * The coder appends one JSON line per inner round (gate/reviewer outcome, optional truncated output).
 * We reset the file per outer attempt so round numbers stay meaningful, read it back after the
 * attempt, and fold rows into outer-attempt summaries for run artifacts and downstream telemetry.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { consola } from '../logger.js';
import type {
  InnerRoundPhase,
  InnerRoundSummary,
  OuterAttemptPhase,
  OuterAttemptSummary,
} from '../runs/types.js';
import { pathExists, readUtf8, writeUtf8 } from '../utils/io.js';

function previewLogLine(line: string, maxChars = 120): string {
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}…`;
}

const VALID_PHASES = new Set<InnerRoundPhase>([
  'agent_failed',
  'gate_passed',
  'gate_failed',
  'reviewer_passed',
  'reviewer_failed',
]);

/**
 * Host path to the per-attempt inner rounds JSONL.
 * Must match where `coder-start.sh` writes: same directory as `task.md` under the workspace root
 * (`sandboxBasePath/code` on disk, `/workspace` in the Leash coder container).
 */
export function roundsStatsPath(sandboxBasePath: string): string {
  return join(sandboxBasePath, 'code', '.saifctl', 'stats.jsonl');
}

/** Clears the log before each outer coding attempt so inner `round` indices stay unambiguous. */
export async function prepareRoundsStatsFile(sandboxBasePath: string): Promise<void> {
  const p = roundsStatsPath(sandboxBasePath);
  await mkdir(dirname(p), { recursive: true });
  await writeUtf8(p, '');
}

/**
 * Parses inner_round lines from coder-start.sh. Malformed lines are skipped.
 */
export async function readInnerRounds(logPath: string): Promise<InnerRoundSummary[]> {
  if (!(await pathExists(logPath))) return [];

  let raw: string;
  try {
    raw = await readUtf8(logPath);
  } catch (err) {
    consola.warn('[stats] Failed to read inner rounds log:', logPath, err);
    return [];
  }

  const results: InnerRoundSummary[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        obj.type !== 'inner_round' ||
        typeof obj.round !== 'number' ||
        typeof obj.phase !== 'string' ||
        !VALID_PHASES.has(obj.phase as InnerRoundPhase)
      ) {
        consola.warn('[stats] Skipping line: not a valid inner_round record', {
          logPath,
          preview: previewLogLine(trimmed),
          type: obj.type,
          round: obj.round,
          phase: obj.phase,
        });
        continue;
      }
      if (typeof obj.startedAt !== 'string' || typeof obj.completedAt !== 'string') {
        consola.warn('[stats] inner_round missing startedAt or completedAt; using current time', {
          logPath,
          round: obj.round,
          phase: obj.phase,
        });
      }
      if (
        obj.gateOutput !== undefined &&
        obj.gateOutput !== null &&
        typeof obj.gateOutput !== 'string'
      ) {
        consola.warn('[stats] inner_round gateOutput ignored (expected string or null)', {
          logPath,
          round: obj.round,
          phase: obj.phase,
          got: typeof obj.gateOutput,
        });
      }
      results.push({
        round: obj.round,
        phase: obj.phase as InnerRoundPhase,
        gateOutput: typeof obj.gateOutput === 'string' ? obj.gateOutput : undefined,
        startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : new Date().toISOString(),
        completedAt:
          typeof obj.completedAt === 'string' ? obj.completedAt : new Date().toISOString(),
      });
    } catch (err) {
      consola.warn(
        '[stats] Skipping malformed JSON line in inner rounds log:',
        logPath,
        previewLogLine(trimmed),
        err,
      );
    }
  }
  return results;
}

/** Builds one outer-attempt summary for run artifact / Hatchet wire output. */
export function buildOuterAttemptSummary(input: {
  attempt: number;
  subtaskIndex: number;
  subtaskAttempt: number;
  phase: OuterAttemptPhase;
  innerRounds: InnerRoundSummary[];
  commitCount: number;
  patchBytes: number;
  errorFeedback?: string;
  startedAt: string;
}): OuterAttemptSummary {
  const completedAt = new Date().toISOString();
  return {
    attempt: input.attempt,
    subtaskIndex: input.subtaskIndex,
    subtaskAttempt: input.subtaskAttempt,
    phase: input.phase,
    innerRoundCount: input.innerRounds.length,
    innerRounds: input.innerRounds,
    commitCount: input.commitCount,
    patchBytes: input.patchBytes,
    errorFeedback: input.errorFeedback,
    startedAt: input.startedAt,
    completedAt,
  };
}
