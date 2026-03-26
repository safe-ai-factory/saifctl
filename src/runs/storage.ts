/**
 * Persisted run storage — wraps generic `StorageImpl<RunArtifact>` with run semantics
 * (revision merge, optimistic locking, filters).
 */

import { createStorage } from '../storage/index.js';
import type { StorageFilter, StorageImpl } from '../storage/types.js';
import {
  RunAlreadyRunningError,
  type RunArtifact,
  type RunSaveOptions,
  type RunStatus,
  StaleArtifactError,
} from './types.js';

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

function buildFilters(filter?: { taskId?: string; status?: RunStatus }): StorageFilter[] {
  const filters: StorageFilter[] = [];
  if (filter?.taskId != null) {
    filters.push({ type: 'match', field: 'taskId', value: filter.taskId });
  }
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
      taskId: artifact.taskId ?? existing?.taskId,
      artifactRevision: currentRev + 1,
      updatedAt: artifact.updatedAt,
    };

    await this.storage.save(runId, merged);
    return merged.artifactRevision!;
  }

  async setStatusRunning(runId: string, artifact: RunArtifact): Promise<number> {
    const existing = await this.storage.get(runId);
    if (existing?.status === 'running') {
      throw new RunAlreadyRunningError(runId);
    }
    const currentRev = existing?.artifactRevision ?? 0;
    const merged: RunArtifact = {
      ...artifact,
      runId,
      status: 'running',
      startedAt: existing?.startedAt ?? artifact.startedAt,
      taskId: artifact.taskId ?? existing?.taskId,
      artifactRevision: currentRev + 1,
      updatedAt: artifact.updatedAt,
    };
    await this.storage.save(runId, merged);
    return merged.artifactRevision!;
  }

  async getRun(runId: string): Promise<RunArtifact | null> {
    return this.storage.get(runId);
  }

  async listRuns(filter?: { taskId?: string; status?: RunStatus }): Promise<RunArtifact[]> {
    const filters = buildFilters(filter);
    return this.storage.list(filters.length > 0 ? filters : undefined);
  }

  async deleteRun(runId: string): Promise<void> {
    await this.storage.delete(runId);
  }

  async clearRuns(filter?: { taskId?: string; status?: RunStatus }): Promise<void> {
    const filters = buildFilters(filter);
    await this.storage.clear(filters.length > 0 ? filters : undefined);
  }
}
