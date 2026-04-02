/**
 * Shared cache for `saifctl run info` payloads used by the Runs tree (config hydrate)
 * and Chats webview (timeline). Avoids duplicate CLI round-trips when both need the same run.
 */

import type { RunInfoForChat, SaifctlCliService } from './cliService';

export class RunInfoStore {
  private readonly cache = new Map<string, RunInfoForChat>();

  static key(projectPath: string, runId: string): string {
    return `${projectPath}\0${runId}`;
  }

  get(projectPath: string, runId: string): RunInfoForChat | undefined {
    return this.cache.get(RunInfoStore.key(projectPath, runId));
  }

  invalidate(projectPath: string, runId: string): void {
    this.cache.delete(RunInfoStore.key(projectPath, runId));
  }

  /** Remove entries for runs that are no longer in the workspace list. */
  invalidateAbsent(keep: ReadonlyArray<{ projectPath: string; runId: string }>): void {
    const keepSet = new Set(keep.map((r) => RunInfoStore.key(r.projectPath, r.runId)));
    for (const k of [...this.cache.keys()]) {
      if (!keepSet.has(k)) this.cache.delete(k);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  async fetch(opts: {
    cli: SaifctlCliService;
    runId: string;
    projectPath: string;
    force?: boolean;
  }): Promise<RunInfoForChat | null> {
    const { cli, runId, projectPath, force } = opts;
    const k = RunInfoStore.key(projectPath, runId);
    if (!force) {
      const hit = this.cache.get(k);
      if (hit !== undefined) return hit;
    } else {
      this.cache.delete(k);
    }
    const info = await cli.getRunInfoForChat(runId, projectPath);
    if (info !== null) {
      this.cache.set(k, info);
    }
    return info;
  }
}
