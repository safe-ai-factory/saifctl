/**
 * Live smoke tests for `createProviderModel`.
 *
 * These tests make REAL network calls to LLM provider endpoints and are
 * **gated behind the `LLM_SMOKE` env var**, so they do not run in normal
 * CI / `pnpm run test` invocations.
 *
 * Run locally with:
 *
 *     LLM_SMOKE=1 pnpm vitest run src/llm-config.smoke.test.ts
 *
 * They verify the two release-readiness/D-05 dispatch paths against real endpoints:
 *
 *   1. **Native path** — Anthropic via `@ai-sdk/anthropic`, requires
 *      `ANTHROPIC_API_KEY`.
 *   2. **OpenAI-compatible path** — any provider routed through
 *      `@ai-sdk/openai` with a `baseURL` override. Uses OpenRouter as the
 *      canary because it's the same code path the 15 ex-native providers
 *      now share, and a single `OPENROUTER_API_KEY` exercises it without
 *      needing 15 individual provider keys.
 *
 * Per-provider baseURLs (Groq, Mistral, etc.) are documented in
 * `src/llm-config.ts` PROVIDERS table but are **not** smoke-tested here —
 * if any of those URLs is wrong, users will see a clear error from the
 * provider's auth/route layer and can override with `--base-url`.
 */

import { Agent } from '@mastra/core/agent';
import { describe, expect, it } from 'vitest';

import { createProviderModel } from './llm-config.js';

const SMOKE_ENABLED = process.env.LLM_SMOKE === '1';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim();

const describeSmoke = SMOKE_ENABLED ? describe : describe.skip;

async function pingViaAgent(model: ReturnType<typeof createProviderModel>): Promise<string> {
  const agent = new Agent({
    id: 'smoke-pinger',
    name: 'smoke-pinger',
    instructions:
      'You are a smoke-test helper. Reply with exactly the single word "pong" and nothing else.',
    model,
  });
  const result = await agent.generate('ping');
  return result.text;
}

describeSmoke('llm-config smoke (live)', () => {
  it.runIf(!!ANTHROPIC_KEY)(
    'native Anthropic path returns a real response',
    async () => {
      const model = createProviderModel({
        provider: 'anthropic',
        modelId: 'claude-haiku-4-5',
        fullModelString: 'anthropic/claude-haiku-4-5',
        apiKey: ANTHROPIC_KEY!,
      });
      const text = await pingViaAgent(model);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it.runIf(!!OPENROUTER_KEY)(
    'openai-compat path (via OpenRouter) returns a real response',
    async () => {
      const model = createProviderModel({
        provider: 'openrouter',
        modelId: 'anthropic/claude-haiku-4-5',
        fullModelString: 'openrouter/anthropic/claude-haiku-4-5',
        apiKey: OPENROUTER_KEY!,
        // Note: createProviderModel will fall back to the registered
        // OpenRouter baseURL when LlmConfig.baseURL is unset, exercising
        // the cfg.baseURL branch.
      });
      const text = await pingViaAgent(model);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
