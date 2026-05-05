/**
 * Persisted run storage — wraps generic `StorageImpl<RunArtifact>` with run semantics
 * (revision merge, optimistic locking, filters).
 */

import { createStorage } from '../storage/index.js';
import type { StorageFilter, StorageImpl } from '../storage/types.js';
import {
  RunAlreadyRunningError,
  type RunArtifact,
  RunCannotPauseError,
  RunCannotStopError,
  type RunInspectSession,
  type RunSaveOptions,
  type RunStatus,
  StaleArtifactError,
} from './types.js';
import { normalizeLoadedRunArtifact } from './utils/normalize-artifact.js';
import { allowsBeginRunStartFromArtifact } from './utils/statuses.js';

const NAMESPACE = 'runs';

/**
 * Creates run storage from a URI or shorthand.
 *
 * @param uriOrShorthand - "local" | "none" | "file:///path" | "s3" | "s3://bucket/prefix"
 * @param projectDir - Used for default local path when uri is "local"
 * @returns `RunStorage` instance, or null for "none" (no persistence)
 */
export function createRunStorage(uriOrShorthand: string, projectDir: string): RunStorage | null {
  const storage = createStorage<RunArtifact>(uriOrShorthand, projectDir, NAMESPACE);
  if (!storage) return null;
  return new RunStorage(storage, uriOrShorthand);
}

function buildFilters(filter?: { status?: RunStatus }): StorageFilter[] {
  const filters: StorageFilter[] = [];
  if (filter?.status != null) {
    filters.push({ type: 'match', field: 'status', value: filter.status });
  }
  return filters;
}

/**
 * Persists run artifacts under a namespace, delegating to {@link StorageImpl<RunArtifact>}.
 */
export class RunStorage {
  constructor(
    private readonly storage: StorageImpl<RunArtifact>,
    readonly uri: string,
  ) {}

  /**
   * @returns The new {@link RunArtifact#artifactRevision} after the write.
   */
  /* eslint-disable-next-line max-params */
  async saveRun(runId: string, artifact: RunArtifact, options?: RunSaveOptions): Promise<number> {
    const existing = await this.storage.get(runId);
    const currentRev = existing?.artifactRevision ?? 0;
    if (options?.ifRevisionEquals !== undefined && currentRev !== options.ifRevisionEquals) {
      throw new StaleArtifactError({
        runId,
        expectedRevision: options.ifRevisionEquals,
        actualRevision: currentRev,
      });
    }

    const merged: RunArtifact = {
      ...artifact,
      runId,
      startedAt: existing?.startedAt ?? artifact.startedAt,
      artifactRevision: currentRev + 1,
      updatedAt: artifact.updatedAt,
      liveInfra: artifact.liveInfra,
      inspectSession: artifact.inspectSession ?? null,
    };

    await this.storage.save(runId, merged);
    return merged.artifactRevision!;
  }

  async setStatusRunning(runId: string, artifact: RunArtifact): Promise<number> {
    const existing = await this.storage.get(runId);
    const s = existing?.status;
    if (s === 'running' || s === 'inspecting' || s === 'pausing' || s === 'stopping') {
      throw new RunAlreadyRunningError(runId);
    }
    const currentRev = existing?.artifactRevision ?? 0;
    const merged: RunArtifact = {
      ...artifact,
      runId,
      status: 'running',
      startedAt: existing?.startedAt ?? artifact.startedAt,
      artifactRevision: currentRev + 1,
      updatedAt: artifact.updatedAt,
      liveInfra: artifact.liveInfra,
      inspectSession: null,
    };
    await this.storage.save(runId, merged);
    return merged.artifactRevision!;
  }

  /**
   * Marks the run as {@link RunStatus} `"inspecting"` and records the idle coder container for tooling.
   *
   * @returns New {@link RunArtifact#artifactRevision} after the write.
   */
  async setStatusInspecting(runId: string, session: RunInspectSession): Promise<number> {
    const existing = await this.storage.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (existing.status === 'inspecting') {
      throw new Error(
        `Run "${runId}" is already in inspect mode. Finish or Ctrl+C the other inspect session first.`,
      );
    }
    if (
      existing.status === 'running' ||
      existing.status === 'starting' ||
      existing.status === 'pausing' ||
      existing.status === 'stopping' ||
      existing.status === 'resuming'
    ) {
      throw new Error(
        `Run "${runId}" cannot enter inspect (status: "${existing.status}"). Stop or wait for it to finish first.`,
      );
    }
    const currentRev = existing.artifactRevision ?? 0;
    const merged: RunArtifact = {
      ...existing,
      status: 'inspecting',
      inspectSession: session,
      artifactRevision: currentRev + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.save(runId, merged);
    return merged.artifactRevision!;
  }

  async getRun(runId: string): Promise<RunArtifact | null> {
    const r = await this.storage.get(runId);
    if (!r) return null;
    const withInspect = r.inspectSession === undefined ? { ...r, inspectSession: null } : r;
    return normalizeLoadedRunArtifact(withInspect);
  }

  async listRuns(filter?: { status?: RunStatus }): Promise<RunArtifact[]> {
    const filters = buildFilters(filter);
    const rows = await this.storage.list(filters.length > 0 ? filters : undefined);
    return rows.map((r) => normalizeLoadedRunArtifact(r));
  }

  /**
   * Sets status to {@link RunStatus} `"pausing"` and {@link RunArtifact#controlSignal} `pause`.
   * The orchestrator polls storage and completes the pause to `"paused"`.
   *
   * @throws {@link RunCannotPauseError} when the Run is not {@link RunStatus} `"running"`.
   */
  async requestPause(runId: string): Promise<void> {
    const existing = await this.storage.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (existing.status !== 'running') {
      throw new RunCannotPauseError(runId, existing.status);
    }
    const currentRev = existing.artifactRevision ?? 0;
    const t = new Date().toISOString();
    const next: RunArtifact = {
      ...existing,
      status: 'pausing',
      controlSignal: { action: 'pause', requestedAt: t },
      updatedAt: t,
      liveInfra: existing.liveInfra,
    };
    await this.saveRun(runId, next, { ifRevisionEquals: currentRev });
  }

  /**
   * Sets status to `"stopping"` and control signal `stop` for live orchestrator teardown.
   * Does not apply to `"paused"` — the CLI `run stop` command tears that down synchronously.
   * Idempotent when already `"stopping"` (refreshes stop signal timestamp).
   *
   * @throws {@link RunCannotStopError} when the run cannot be stopped asynchronously (e.g. completed).
   */
  async requestStop(runId: string): Promise<void> {
    const existing = await this.storage.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    const stoppableAsync =
      existing.status === 'running' ||
      existing.status === 'starting' ||
      existing.status === 'resuming' ||
      existing.status === 'pausing' ||
      existing.status === 'stopping';
    if (!stoppableAsync) {
      throw new RunCannotStopError(runId, existing.status);
    }
    const currentRev = existing.artifactRevision ?? 0;
    const t = new Date().toISOString();
    const next: RunArtifact = {
      ...existing,
      status: 'stopping',
      controlSignal: { action: 'stop', requestedAt: t },
      updatedAt: t,
    };
    await this.saveRun(runId, next, { ifRevisionEquals: currentRev });
  }

  /**
   * Mark a terminal run as {@link RunStatus} `"starting"` before worktree/sandbox setup (`run start`).
   * Caller should poll for `stopping` / stop signal and abort if the user requested stop.
   *
   * @returns New {@link RunArtifact#artifactRevision}.
   */
  async beginRunStartFromArtifact(runId: string): Promise<number> {
    const existing = await this.storage.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (!allowsBeginRunStartFromArtifact(existing.status, existing.pausedSandboxBasePath)) {
      const hint =
        existing.status === 'paused' && existing.pausedSandboxBasePath?.trim()
          ? ` Use: saifctl run resume ${runId}`
          : '';
      throw new Error(
        `Run "${runId}" cannot be started (status: "${existing.status}").` +
          (hint ||
            ` Only failed or completed runs can use run start; use run resume when paused with a sandbox.`),
      );
    }
    const currentRev = existing.artifactRevision ?? 0;
    const t = new Date().toISOString();
    const next: RunArtifact = {
      ...existing,
      status: 'starting',
      controlSignal: null,
      updatedAt: t,
    };
    return this.saveRun(runId, next, { ifRevisionEquals: currentRev });
  }

  /**
   * First persistence for a new run id (`feat run`): status `"starting"` before `"running"`.
   * Fails if an artifact already exists for this id.
   */
  async setStatusStartingNewRun(runId: string, artifact: RunArtifact): Promise<number> {
    const existing = await this.storage.get(runId);
    if (existing != null) {
      throw new RunAlreadyRunningError(runId);
    }
    return this.saveRun(runId, {
      ...artifact,
      status: 'starting',
      inspectSession: artifact.inspectSession ?? null,
    });
  }

  async deleteRun(runId: string): Promise<void> {
    await this.storage.delete(runId);
  }

  async clearRuns(filter?: { status?: RunStatus }): Promise<void> {
    const filters = buildFilters(filter);
    await this.storage.clear(filters.length > 0 ? filters : undefined);
  }
}
