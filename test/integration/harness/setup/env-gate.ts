/**
 * Env gating for the integration harness — i.e. the test suite that boots a
 * real Docker container, runs the orchestrator end-to-end, and (optionally)
 * makes a live Anthropic API call. These knobs control which subset of
 * scenarios actually executes; everything else cleanly skips so unit-test
 * runs on dev laptops without Docker stay green.
 *
 *   SAIFCTL_INTEG=1       — opt in to Docker-running scenarios. When set, ALL
 *                           integration scenarios run by default — including
 *                           LLM-bearing ones. This is deliberate: silent-skip
 *                           on missing API key is a footgun; CI that forgets
 *                           to set the key would never know it's not
 *                           exercising the LLM path. If the key is missing,
 *                           the test fails loudly at `getAnthropicKey()`.
 *   SAIFCTL_NO_LLM=1      — explicit opt-out for LLM-bearing scenarios (use
 *                           on per-PR CI that doesn't carry secrets). Combine
 *                           with SAIFCTL_INTEG=1 to run only debug-agent
 *                           scenarios.
 *   SAIFCTL_TEST_RETRY=N  — within-run retry budget for `itWithLLM` scenarios
 *                           (default 0). Set to `2` on the weekly LLM
 *                           workflow so a transient Anthropic 5xx / network
 *                           blip doesn't wait a full week to clear; local dev
 *                           keeps the default 0 for fast-fail feedback.
 *                           Scoped to LLM scenarios — debug-agent failures
 *                           are deterministic plumbing failures and should
 *                           surface on first hit.
 *
 * Caller matrix (set in `.github/workflows/tests-integration*.yml`):
 *   - per-PR:  SAIFCTL_INTEG=1 SAIFCTL_NO_LLM=1
 *   - weekly:  SAIFCTL_INTEG=1 SAIFCTL_TEST_RETRY=2  (+ ANTHROPIC_API_KEY)
 *
 * Authoritative spec: saifctl/features/release-readiness/specification.md
 * §4.1, item release-readiness/X-08-P3.
 */
import Docker from 'dockerode';
import { describe, it } from 'vitest';

const INTEG_ENABLED = process.env.SAIFCTL_INTEG === '1';
const LLM_DISABLED = process.env.SAIFCTL_NO_LLM === '1';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? '';

let dockerProbeCache: boolean | null = null;

/**
 * One-shot ping of the Docker daemon. Cached for the test process lifetime so
 * each scenario doesn't re-probe.
 */
export async function dockerAvailable(): Promise<boolean> {
  if (dockerProbeCache !== null) return dockerProbeCache;
  if (!INTEG_ENABLED) {
    dockerProbeCache = false;
    return false;
  }
  try {
    await new Docker().ping();
    dockerProbeCache = true;
  } catch {
    dockerProbeCache = false;
  }
  return dockerProbeCache;
}

/**
 * `describe`-equivalent that skips when integration mode is off OR the Docker
 * daemon is unreachable. Skips quietly — does not fail — so `pnpm test` on a
 * laptop without Docker stays green.
 */
export const describeIntegration: typeof describe = (
  INTEG_ENABLED ? describe : describe.skip
) as typeof describe;

export interface ItWithLLMOpts {
  name: string;
  fn: () => void | Promise<void>;
  /**
   * Hard timeout. Default: 15 minutes. A real container + agent + LLM round
   * can take 2–4 minutes cached, but a cold-cache run (first-time docker
   * image pulls + in-container `npm install -g @anthropic-ai/claude-code` +
   * Claude API roundtrips + gate + staging tests) can blow past 5 min on
   * slow networks. 15 min is generous headroom that still surfaces a real
   * hang. Override per-test with this option, or globally via the
   * `SAIFCTL_TEST_TIMEOUT_MS` env var.
   */
  timeoutMs?: number;
}

const DEFAULT_LLM_TIMEOUT_MS = 900_000;

function resolveLlmTimeout(perTestMs: number | undefined): number {
  if (perTestMs && perTestMs > 0) return perTestMs;
  const envRaw = process.env.SAIFCTL_TEST_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LLM_TIMEOUT_MS;
}

function resolveLlmRetry(): number {
  const envRaw = process.env.SAIFCTL_TEST_RETRY;
  if (!envRaw) return 0;
  const parsed = Number.parseInt(envRaw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * `it` wrapper for scenarios that make live LLM calls.
 *
 * Skips ONLY when:
 *   - `SAIFCTL_INTEG !== '1'` (integration gate off; everything skips)
 *   - `SAIFCTL_NO_LLM === '1'` (explicit opt-out)
 *
 * Does NOT silently skip on missing `ANTHROPIC_API_KEY`. If the key is missing
 * but the gate says "run", the scenario fails loudly inside `getAnthropicKey()`.
 * That's intentional — silent-skip-on-missing-key would let CI mis-configurations
 * masquerade as green forever.
 */
export function itWithLLM(opts: ItWithLLMOpts): void {
  const { name, fn, timeoutMs } = opts;
  if (!INTEG_ENABLED || LLM_DISABLED) {
    it.skip(name, fn);
    return;
  }
  const retry = resolveLlmRetry();
  if (retry > 0) {
    it(name, fn, { timeout: resolveLlmTimeout(timeoutMs), retry });
    return;
  }
  it(name, fn, resolveLlmTimeout(timeoutMs));
}

export function getAnthropicKey(): string {
  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required for this scenario but is not set');
  }
  return ANTHROPIC_KEY;
}
