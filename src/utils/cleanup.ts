// ---------------------------------------------------------------------------
// Cleanup registry — tracks live infra engines for graceful shutdown
// ---------------------------------------------------------------------------

import { consola } from '../logger.js';
import { destroySandbox } from '../orchestrator/sandbox.js';

/** Minimal engine interface used by CleanupRegistry (avoids circular deps). */
export interface EngineRef {
  teardown(opts: { runId: string }): Promise<void>;
}

/**
 * Tracks all engines created during a run so that
 * SIGINT/SIGTERM handlers can tear them down even if the mode function is
 * mid-await when the signal fires.
 *
 * Mode functions call `register` immediately after each resource is created.
 * The signal handler calls `cleanup()` which tears down everything in reverse order.
 */
export class CleanupRegistry {
  private engines: Array<{ engine: EngineRef; runId: string }> = [];
  private beforeCleanupHook?: () => Promise<void>;
  /**
   * Sandbox dir to remove on SIGINT/SIGTERM. The iterative loop normally destroys the sandbox in
   * its own `finally`, but the signal handler calls `process.exit` before that runs — without this,
   * Disposable sandbox dirs under the sandbox base (e.g. `/tmp/saifctl/sandboxes/...`) accumulate after every interrupted run.
   */
  private emergencySandboxPath?: string;

  /** Optional hook run before teardown (e.g. save run state on Ctrl+C) */
  setBeforeCleanup(hook: () => Promise<void>): void {
    this.beforeCleanupHook = hook;
  }

  /** Register a sandbox directory to delete when the registry runs signal cleanup. */
  setEmergencySandboxPath(path: string): void {
    this.emergencySandboxPath = path;
  }

  /** Call when the sandbox was already removed (success/abort paths) so signal cleanup is a no-op. */
  clearEmergencySandboxPath(): void {
    this.emergencySandboxPath = undefined;
  }

  /** Register an engine so it is torn down on SIGINT/SIGTERM. */
  registerEngine(engine: EngineRef, runId: string): void {
    this.engines.push({ engine, runId });
  }

  /** Deregister an engine after it has been explicitly torn down. */
  deregisterEngine(engine: EngineRef): void {
    this.engines = this.engines.filter((e) => e.engine !== engine);
  }

  async cleanup(): Promise<void> {
    if (this.beforeCleanupHook) {
      try {
        await this.beforeCleanupHook();
      } catch (err) {
        consola.warn('[orchestrator] Before-cleanup hook error:', err);
      }
    }
    const enginesToDown = [...this.engines];
    this.engines = [];

    for (const { engine, runId } of enginesToDown) {
      await engine.teardown({ runId });
    }

    if (this.emergencySandboxPath) {
      const path = this.emergencySandboxPath;
      this.emergencySandboxPath = undefined;
      try {
        await destroySandbox(path);
      } catch (err) {
        consola.warn('[orchestrator] Emergency sandbox cleanup error:', err);
      }
    }
  }
}
