/**
 * X-08 Phase 2 — claude + Anthropic against the dummy feature.
 *
 * The load-bearing leg of D-07: a real LLM call inside a real container,
 * agent reads the dummy spec, writes `dummy.md` matching the public test
 * cases, full pipeline (staging tests, patch, branch).
 *
 * Asserts:
 *   1. orchestrator status `success` and produced a `saifctl/dummy-…` branch
 *   2. produced branch carries ≥1 commit beyond `main`
 *   3. `dummy.md` exists at repo root with H1 + Purpose + Structure + Next Steps
 *   4. `ANTHROPIC_API_KEY` value never appears in captured stdout/stderr,
 *      orchestrator message, or the produced file (pitfall #4)
 *
 * Runs only when `SAIFCTL_INTEG=1` is set and `SAIFCTL_NO_LLM` is unset —
 * per D-07: "scope LLM calls to one nightly job, not per-PR."
 * See specification.md §10 (X08-P2).
 *
 * Cost estimate: one round, claude-haiku-4-5, < $0.05 typical. Default hard
 * cap 15 minutes wall-clock — covers cold-cache runs (docker pulls + the
 * in-container `npm install -g @anthropic-ai/claude-code` step + Claude API
 * roundtrips). Override with `SAIFCTL_TEST_TIMEOUT_MS=<ms>` for a single run.
 *
 * Debugging a hang or timeout:
 *   1. `pnpm test:integration:llm:debug` — verbose reporter + 30 min timeout.
 *      Streams orchestrator output line-by-line so you can see what phase the
 *      run is stuck in (sandbox, build, agent, gate, tests, patch).
 *   2. The harness mirrors stdout/stderr to `<tmpProjectDir>/harness.log`
 *      in real time (synchronous `writeSync`). On test timeout, vitest aborts
 *      the test fn and the in-memory `result.logs` is lost — but the file
 *      survives. The harness writes a triage banner to stderr on failure
 *      with the exact log path and tmp project dir.
 *   3. Stale containers from a hung run are pruned by `afterAll` here, but
 *      `docker ps -a | grep saifctl-integ-fixture` is the manual check.
 */
import { afterAll, expect } from 'vitest';

import { assertNoSecretInString } from '../harness/assertions/tree.js';
import { runHarness } from '../harness/runHarness.js';
import { pruneStrayHarnessContainers } from '../harness/setup/cleanup.js';
import { describeIntegration, getAnthropicKey, itWithLLM } from '../harness/setup/env-gate.js';

describeIntegration('integration: dummy-claude-anthropic (X08-P2)', () => {
  afterAll(async () => {
    await pruneStrayHarnessContainers();
  });

  itWithLLM({
    name: 'claude + anthropic writes a conformant dummy.md against the dummy feature',
    fn: async () => {
      const apiKey = getAnthropicKey();
      const result = await runHarness({
        fixture: 'dummy-feature',
        featureName: 'dummy',
        agent: 'claude',
        provider: 'anthropic',
        anthropicApiKey: apiKey,
        cleanup: 'on-success',
      });

      expect(result.status, `orchestrator message: ${result.message}`).toBe('success');
      expect(
        result.producedBranch,
        'orchestrator should produce a saifctl/<feat>-… branch',
      ).toMatch(/^saifctl\/dummy-/);
      expect(
        result.commitsOnBranch,
        'produced branch should carry at least one agent commit beyond main',
      ).toBeGreaterThanOrEqual(1);
      expect(result.dummyMdExists, 'dummy.md should exist on the produced branch').toBe(true);
      expect(result.dummyMdContent ?? '').toContain('# Dummy');
      expect(result.dummyMdContent ?? '').toMatch(/#+\s+Purpose/i);
      expect(result.dummyMdContent ?? '').toMatch(/#+\s+Structure/i);
      expect(result.dummyMdContent ?? '').toMatch(/#+\s+Next Steps/i);

      // Pitfall #4: the API key value must not appear in any captured log
      // surface or in the orchestrator's own message / produced file. A
      // single substring sweep covers consola, container log forwarding,
      // child-process stderr, and the agent's own output.
      assertNoSecretInString({ haystack: result.logs.stdout, secret: apiKey, label: 'stdout' });
      assertNoSecretInString({ haystack: result.logs.stderr, secret: apiKey, label: 'stderr' });
      assertNoSecretInString({
        haystack: result.message,
        secret: apiKey,
        label: 'orchestrator message',
      });
      assertNoSecretInString({
        haystack: result.dummyMdContent ?? '',
        secret: apiKey,
        label: 'dummy.md content',
      });
    },
  });
});
