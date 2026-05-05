/**
 * release-readiness/X-08-P1 — debug-agent integration smoke (no LLM key required).
 *
 * Boots a real Docker container with the `debug` agent profile, which writes
 * a deterministic `dummy.md` matching the dummy feature's public test cases.
 * Asserts that the orchestrator produced a `saifctl/<feat>-…` feature branch
 * with the file on it (the same flow the CLI's `feat run` uses).
 *
 * The debug agent's network probe runs by default (Cedar/Leash NetworkConnect
 * smoke). Set `SAIFCTL_TEST_SKIP_NETWORK_PROBE=1` to opt out on runners
 * without egress.
 *
 * Runs under `SAIFCTL_INTEG=1`; skips otherwise.
 *
 * See release-readiness/X-08-P1.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';

import { runHarness } from '../harness/runHarness.js';
import { pruneStrayHarnessContainers } from '../harness/setup/cleanup.js';
import { describeIntegration, dockerAvailable } from '../harness/setup/env-gate.js';

describeIntegration('integration: sandbox-mode-debug (X-08-P1)', () => {
  beforeAll(async () => {
    const ok = await dockerAvailable();
    if (!ok) {
      // Don't fail the suite; describeIntegration already gated on SAIFCTL_INTEG.
      // This belt only fires when SAIFCTL_INTEG=1 was set but the daemon is down,
      // in which case making the failure mode clear in logs is more useful than
      // the dockerode error stack the harness would otherwise surface.
      console.warn('[integ] Docker daemon not reachable; tests will throw HarnessSetupError');
    }
  });

  afterAll(async () => {
    await pruneStrayHarnessContainers();
  });

  it('debug agent writes a conformant dummy.md against the dummy feature', async () => {
    const result = await runHarness({
      fixture: 'dummy-feature',
      featureName: 'dummy',
      agent: 'debug',
      cleanup: 'on-success',
    });

    // Surface the orchestrator message early — easier triage when this fails.
    expect(result.status, `orchestrator message: ${result.message}`).toBe('success');
    expect(result.producedBranch, 'orchestrator should produce a saifctl/<feat>-… branch').toMatch(
      /^saifctl\/dummy-/,
    );
    expect(
      result.commitsOnBranch,
      'produced branch should carry at least one agent commit beyond main',
    ).toBeGreaterThanOrEqual(1);
    expect(result.dummyMdExists, 'dummy.md should exist on the produced branch').toBe(true);
    expect(result.dummyMdContent ?? '').toContain('# Dummy');
    expect(result.dummyMdContent ?? '').toMatch(/#+\s+Purpose/i);
    expect(result.dummyMdContent ?? '').toMatch(/#+\s+Structure/i);
    expect(result.dummyMdContent ?? '').toMatch(/#+\s+Next Steps/i);
  }, 300_000);
});
