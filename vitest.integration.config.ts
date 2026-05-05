import { defineConfig } from 'vitest/config';

/**
 * Integration test config (release-readiness/X-08 harness). Authoritative spec:
 * `saifctl/features/release-readiness/specification.md` §10.
 *
 *   pnpm test:integration       — Docker scenarios (debug agent)
 *   pnpm test:integration:llm   — adds live-LLM scenarios when ANTHROPIC_API_KEY is set
 *
 * Both run only with `SAIFCTL_INTEG=1`; otherwise scenarios skip cleanly.
 *
 * - Single-fork pool: sandboxes share `/tmp/saifctl/sandboxes/` and would race
 *   under parallel test files. Forks (not threads) so each scenario gets a
 *   clean process for `process.env` mutation around API keys.
 * - 15-minute test timeout: cold-cache LLM run = docker pulls + in-container
 *   agent install + LLM roundtrips. Per-test timeouts via `itWithLLM` override.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.test.ts'],
    globals: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // 15 min default — covers cold-cache LLM runs (docker pulls + in-container
    // `npm install -g @anthropic-ai/claude-code` + LLM roundtrips). Per-test
    // timeouts via `itWithLLM`/`it(..., ms)` override this; the config default
    // is a ceiling for tests that don't pass an explicit timeout.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
