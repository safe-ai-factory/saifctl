// ---------------------------------------------------------------------------
// Cleanup registry — tracks live infra engines for graceful shutdown
// ---------------------------------------------------------------------------

import type { LiveInfra } from '../engines/types.js';
import { consola } from '../logger.js';
import { destroySandbox } from '../orchestrator/sandbox.js';

/** Minimal engine interface used by CleanupRegistry (avoids circular deps). */
export interface EngineRef {
  teardown(opts: { runId: string; infra: LiveInfra | null; projectDir: string }): Promise<void>;
}

/** Args for {@link CleanupRegistry.registerEngine}: how to tear down one engine on signal-driven cleanup. */
export interface RegisterEngineOpts {
  engine: EngineRef;
  /**
   * Same run id passed to {@link Engine.setup} / {@link Engine.teardown} for this engine
   * (authoritative for Docker resources and teardown).
   */
  runId: string;
  /**
   * Human-readable registration label for logs (may differ from `runId`, e.g. `${runId}-coding-1`).
   */
  label: string;
  projectDir: string;
  /**
   * Latest live infra for this engine. `null` until the first successful `setup()` assigns it.
   * Passed through to `engine.teardown()`; Docker logs and no-ops when still `null`.
   */
  getInfra: () => LiveInfra | null;
}

/**
 * Tracks all engines created during a run so that
 * SIGINT/SIGTERM handlers can tear them down even if the mode function is
 * mid-await when the signal fires.
 *
 * Call sites register **before** `Engine.setup()` so an early signal still sees infra once
 * `getInfra()` reflects the latest snapshot (see `run-agent-phase`, iterative loop, test phases).
 * The signal handler calls `cleanup()` which tears down everything in reverse order.
 */
export class CleanupRegistry {
  private engines: Array<RegisterEngineOpts> = [];
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
  registerEngine(opts: RegisterEngineOpts): void {
    this.engines.push(opts);
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

    for (const { engine, runId, projectDir, getInfra } of enginesToDown) {
      // `infra === null` => failed setup ⇒ teardown no-ops / warns.
      // This is handled inside each engine's teardown (Docker warns; local no-ops).
      await engine.teardown({ runId, infra: getInfra(), projectDir });
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
