/**
 * Helpers for {@link RunStatus} transitions and UI/tooling (e.g. `run list`, VS Code).
 */

import type { RunStatus } from '../types.js';

/** True while an orchestrator (or start/resume handshake) may be in progress — not safe to `run start` again. */
function isRunStatusOrchestratorLive(status: RunStatus): boolean {
  return (
    status === 'running' ||
    status === 'pausing' ||
    status === 'stopping' ||
    status === 'starting' ||
    status === 'resuming'
  );
}

/** Only these may be deleted with `run rm` without `--force` (if added later). */
export function isRunStatusDeletable(status: RunStatus): boolean {
  return status === 'failed' || status === 'completed';
}

/** `saifctl run start` / from-artifact entry (failed or completed artifact). */
function allowsFromArtifactRunStart(status: RunStatus): boolean {
  return status === 'failed' || status === 'completed';
}

/**
 * `beginRunStartFromArtifact`: transition storage to `"starting"` before worktree/sandbox.
 * Includes paused runs with no sandbox path (resume fell back to rebuild like `run start`).
 */
export function allowsBeginRunStartFromArtifact(
  status: RunStatus,
  pausedSandboxBasePath: string | null | undefined,
): boolean {
  if (allowsFromArtifactRunStart(status)) return true;
  return status === 'paused' && !pausedSandboxBasePath?.trim();
}

/** Block `run inspect` (inspect restores prior status; cannot overlap live work). */
export function blocksRunInspect(status: RunStatus): boolean {
  return (
    status === 'running' ||
    status === 'starting' ||
    status === 'pausing' ||
    status === 'stopping' ||
    status === 'resuming' ||
    status === 'inspecting'
  );
}

/** Poll until pause: no longer running or pausing (paused, failed, completed, stopping, …). */
export function isRunAwaitingPauseCompletion(status: RunStatus): boolean {
  return status === 'running' || status === 'pausing';
}

/** Poll until stop (async orchestrator path): settled to a non-live status. */
export function isRunAwaitingStopCompletion(status: RunStatus): boolean {
  return isRunStatusOrchestratorLive(status);
}
