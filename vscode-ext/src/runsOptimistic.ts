/** Drop optimistic run status if the server has not moved off {@link OptimisticRunEntry#prev} by then. */
export const OPTIMISTIC_RUN_STATUS_TTL_MS = 60_000;

export type OptimisticRunEntry = { display: string; prev: string; setAt: number };

export function optimisticRunKey(projectPath: string, runId: string): string {
  return `${projectPath}\0${runId}`;
}

/**
 * Merge one API run row with a pending optimistic status overlay (mutates {@link optimisticByRun} when clearing).
 */
export function resolveOptimisticRunStatusForFetch(
  apiRun: { id: string; projectPath: string; status: string },
  opts: {
    optimisticByRun: Map<string, OptimisticRunEntry>;
    now: number;
    ttlMs?: number;
  },
): string {
  const { optimisticByRun, now, ttlMs = OPTIMISTIC_RUN_STATUS_TTL_MS } = opts;
  const key = optimisticRunKey(apiRun.projectPath, apiRun.id);
  const o = optimisticByRun.get(key);
  if (!o) return apiRun.status;
  if (now - o.setAt > ttlMs) {
    optimisticByRun.delete(key);
    return apiRun.status;
  }
  if (apiRun.status !== o.prev) {
    optimisticByRun.delete(key);
    return apiRun.status;
  }
  return o.display;
}
