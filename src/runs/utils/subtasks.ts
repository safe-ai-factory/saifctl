/**
 * Helpers for {@link RunSubtask} — ids, inputs → runtime rows, and artifact normalization.
 */

import { randomBytes } from 'node:crypto';

import type { RunSubtask, RunSubtaskInput } from '../types.js';

/** Short stable id: 6 lowercase hex characters (3 random bytes). */
export function newRunSubtaskId(): string {
  return randomBytes(3).toString('hex');
}

/**
 * Turns persisted / manifest inputs into runtime {@link RunSubtask} rows (assigns id, status, timestamps).
 */
export function runSubtasksFromInputs(
  inputs: readonly RunSubtaskInput[],
  nowIso = (): string => new Date().toISOString(),
): RunSubtask[] {
  const t = nowIso();
  return inputs.map((input) => ({
    id: newRunSubtaskId(),
    title: input.title,
    content: input.content,
    status: 'pending' as const,
    createdAt: t,
    gateScript: input.gateScript,
    agentScript: input.agentScript,
    gateRetries: input.gateRetries,
    reviewerEnabled: input.reviewerEnabled,
    agentEnv: input.agentEnv,
    testScope: input.testScope,
    phaseId: input.phaseId,
    criticPrompt: input.criticPrompt,
  }));
}

/** Strips runtime-only fields for persisting subtask shape inside {@link SerializedLoopOpts#subtasks}. */
export function runSubtasksToInputs(subtasks: readonly RunSubtask[]): RunSubtaskInput[] {
  return subtasks.map((s) => ({
    title: s.title,
    content: s.content,
    gateScript: s.gateScript,
    agentScript: s.agentScript,
    gateRetries: s.gateRetries,
    reviewerEnabled: s.reviewerEnabled,
    agentEnv: s.agentEnv,
    testScope: s.testScope,
    phaseId: s.phaseId,
    criticPrompt: s.criticPrompt,
  }));
}
