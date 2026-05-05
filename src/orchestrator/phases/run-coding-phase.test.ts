/**
 * Unit tests for `wireEngineExitedAbort` — the cross-link that prevents the
 * `Promise.all([engine, driver])` deadlock in `runCodingPhase` when the
 * engine container exits before the driver receives its final
 * `subtask-done` signal.
 *
 * Background: see {@link SAIFCTL_ENGINE_EXITED_REASON} on `runs/types.ts`
 * and the comment at the call site in `run-coding-phase.ts`. Triggered by
 * a real failure observed in release-readiness/X-08-P2 where coder-start.sh died under
 * `set -e` between the inner-loop end and the explicit done-signal write,
 * causing the orchestrator to hang for 15 minutes until vitest's testTimeout
 * fired.
 */
import { describe, expect, it } from 'vitest';

import { SAIFCTL_ENGINE_EXITED_REASON, SAIFCTL_PAUSE_ABORT_REASON } from '../../runs/types.js';
import { wireEngineExitedAbort } from './run-coding-phase.js';

describe('wireEngineExitedAbort', () => {
  it('aborts the controller with ENGINE_EXITED reason once the engine resolves', async () => {
    const controlAbort = new AbortController();
    let resolveEngine: (v: unknown) => void = () => {};
    const enginePromise = new Promise<unknown>((resolve) => {
      resolveEngine = resolve;
    });

    wireEngineExitedAbort({ enginePromise, controlAbort });

    expect(controlAbort.signal.aborted).toBe(false);

    resolveEngine({ outcome: 'completed' });
    await enginePromise; // wait one microtask for the .finally to run.
    // Microtask scheduling: .finally fires after the resolution settles. A
    // tiny tick gives Node a chance to drain the queue before we assert.
    await new Promise((r) => setImmediate(r));

    expect(controlAbort.signal.aborted).toBe(true);
    expect(controlAbort.signal.reason).toBe(SAIFCTL_ENGINE_EXITED_REASON);
  });

  it('aborts when the engine rejects (failure path also dies the driver)', async () => {
    const controlAbort = new AbortController();
    const enginePromise = Promise.reject(new Error('engine spawn failed'));
    // Surface the rejection to a sink so Node doesn't flag it unhandled
    // (the helper's .catch only silences its own .finally chain).
    enginePromise.catch(() => {});

    wireEngineExitedAbort({ enginePromise, controlAbort });

    await new Promise((r) => setImmediate(r));

    expect(controlAbort.signal.aborted).toBe(true);
    expect(controlAbort.signal.reason).toBe(SAIFCTL_ENGINE_EXITED_REASON);
  });

  it('does not overwrite an existing abort reason (user pause/stop wins)', async () => {
    const controlAbort = new AbortController();
    let resolveEngine: (v: unknown) => void = () => {};
    const enginePromise = new Promise<unknown>((resolve) => {
      resolveEngine = resolve;
    });

    // User issued `run pause` BEFORE the engine settled.
    controlAbort.abort(SAIFCTL_PAUSE_ABORT_REASON);

    wireEngineExitedAbort({ enginePromise, controlAbort });

    resolveEngine({ outcome: 'completed' });
    await enginePromise;
    await new Promise((r) => setImmediate(r));

    expect(controlAbort.signal.aborted).toBe(true);
    // PAUSE preserved — engine-exited is a strictly weaker signal.
    expect(controlAbort.signal.reason).toBe(SAIFCTL_PAUSE_ABORT_REASON);
  });

  it('end-to-end: a Promise.all([engine, driver]) settles within ms when engine wins', async () => {
    // Reproduces the exact deadlock pattern `runCodingPhase` uses. Without
    // `wireEngineExitedAbort`, this test would hang until the test timeout.
    // Cap at 1s to make the regression failure mode loud.
    const controlAbort = new AbortController();
    const enginePromise = Promise.resolve({ outcome: 'completed' as const });
    const driverPromise = new Promise<void>((resolve, reject) => {
      // Simulates `pollSubtaskDone` — only resolves on abort.
      controlAbort.signal.addEventListener('abort', () => {
        reject(new Error(`driver aborted: ${String(controlAbort.signal.reason)}`));
      });
    }).catch(() => {
      // The driver's `try { ... } catch { return; }` swallows the abort
      // and returns; mirror that here so Promise.all settles cleanly.
    });

    wireEngineExitedAbort({ enginePromise, controlAbort });

    const start = Date.now();
    await Promise.all([enginePromise, driverPromise]);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(controlAbort.signal.reason).toBe(SAIFCTL_ENGINE_EXITED_REASON);
  });
});
