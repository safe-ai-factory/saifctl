/**
 * Central LLM configuration resolver.
 *
 * This module is the single source of truth for deciding which model, provider,
 * API key, and base URL any agent uses at runtime. It replaces scattered
 * `process.env.LLM_*` reads and hardcoded model strings.
 *
 * ## Resolution cascade (highest → lowest priority)
 *
 * For each agent, the model string is resolved in this order:
 *   1. Per-agent from `--model` (agent=model parts)        (most specific)
 *   2. Global from `--model` CLI flag                      (global override)
 *   3. Auto-discovery from standard API keys              (zero-config default)
 *
 * ## Model string format
 *
 * All model identifiers use `provider/model` format:
 *   - anthropic/claude-3-5-sonnet-latest
 *   - openai/gpt-4o
 *   - google/gemini-2.5-pro
 *   - xai/grok-3
 *   - mistral/mistral-large-latest
 *   - openrouter/meta-llama/llama-3.1-405b
 *   - ollama/llama3.1
 *
 * The provider prefix drives API key selection, base URL routing, and which
 * native SDK is instantiated. See docs/models.md for the full provider table.
 */

import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createBaseten } from '@ai-sdk/baseten';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFireworks } from '@ai-sdk/fireworks';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createHuggingFace } from '@ai-sdk/huggingface';
import { createMistral } from '@ai-sdk/mistral';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createPerplexity } from '@ai-sdk/perplexity';
import type { LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createVercel } from '@ai-sdk/vercel';
import { createXai } from '@ai-sdk/xai';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A fully resolved LLM configuration ready to instantiate a provider model. */
export interface LlmConfig {
  /** Model name without the provider prefix, e.g. "claude-3-5-sonnet-latest". */
  modelId: string;
  /** Provider identifier, e.g. "anthropic", "openai", "openrouter", "ollama". */
  provider: string;
  /** Full provider-prefixed model string, e.g. "anthropic/claude-3-5-sonnet-latest". */
  fullModelString: string;
  /** API key for authenticating with the provider endpoint. */
  apiKey: string;
  /** Base URL for the provider endpoint. Omitted when the SDK default is correct. */
  baseURL?: string;
}

/**
 * CLI-level overrides parsed from command flags.
 *
 * Examples:
 * ```
 * --model anthropic/claude-3-5-sonnet-latest
 * --model coder=openai/o3,pr-summarizer=openai/gpt-4o-mini
 * --base-url https://api.anthropic.com/v1
 * --base-url coder=https://api.anthropic.com/v1,pr-summarizer=https://api.openai.com/v1
 * ```
 *
 * Produced by `parseModelOverrides()` in `src/cli/utils.ts` and threaded through
 * from command entry points down to any function that resolves an agent model.
 */
export interface ModelOverrides {
  /** Value of `--model` (global part) — applies to all agents. */
  model?: string;
  /** Value of `--base-url` — applies to all agents. */
  baseUrl?: string;
  /** Per-agent model overrides from `--model` agent=model parts. */
  agentModels?: Record<string, string>;
  /** Per-agent base URL overrides from `--base-url` agent=url parts. */
  agentBaseUrls?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

type CreateProviderFn = (opts: {
  apiKey: string;
  baseURL?: string;
}) => ProviderV3 & { (modelId: string): LanguageModelV3 };

interface ProviderConfig {
  apiKeyEnvVar: string;
  defaultModel: string;
  createProvider: CreateProviderFn;
  /** Default base URL for the provider's API (e.g. OpenRouter, Ollama). */
  baseURL?: string;
  /** Alternative prefixes that resolve to this provider (e.g. "gemini" → google). */
  aliases?: string[];
}

/**
 * Canonical provider definitions, in auto-discovery priority order (first match wins).
 * Aliases are declared inline; a flat lookup map is built below.
 */
const PROVIDERS: ProviderConfig[] = [
  {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    createProvider: createAnthropic,
  },
  {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'openai/gpt-5.4',
    createProvider: createOpenAI,
    aliases: ['openai'],
  },
  {
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4-6',
    createProvider: createOpenAI,
    baseURL: 'https://openrouter.ai/api/v1',
    aliases: ['openrouter'],
  },
  {
    apiKeyEnvVar: 'GEMINI_API_KEY',
    defaultModel: 'google/gemini-3.1-pro-preview',
    createProvider: createGoogleGenerativeAI,
    aliases: ['google', 'gemini'],
  },
  {
    apiKeyEnvVar: 'XAI_API_KEY',
    defaultModel: 'xai/grok-4-1-fast-reasoning',
    createProvider: createXai,
    aliases: ['xai'],
  },
  {
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral/mistral-large-2512',
    createProvider: createMistral,
    aliases: ['mistral'],
  },
  {
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek/deepseek-chat',
    createProvider: createDeepSeek,
    aliases: ['deepseek'],
  },
  {
    apiKeyEnvVar: 'GROQ_API_KEY',
    defaultModel: 'groq/llama-3.3-70b-versatile',
    createProvider: createGroq,
    aliases: ['groq'],
  },
  {
    apiKeyEnvVar: 'COHERE_API_KEY',
    defaultModel: 'cohere/command-a-03-2025',
    createProvider: createCohere,
    aliases: ['cohere'],
  },
  {
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    defaultModel: 'together/meta-llama/Llama-3.3-70B-Instruct',
    createProvider: createTogetherAI,
    aliases: ['together', 'togetherai'],
  },
  {
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    defaultModel: 'fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct',
    createProvider: createFireworks,
    aliases: ['fireworks'],
  },
  {
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    defaultModel: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
    createProvider: createDeepInfra,
    aliases: ['deepinfra'],
  },
  {
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    defaultModel: 'cerebras/llama3.3-70b',
    createProvider: createCerebras,
    aliases: ['cerebras'],
  },
  {
    apiKeyEnvVar: 'HF_TOKEN',
    defaultModel: 'huggingface/meta-llama/Llama-3.3-70B-Instruct',
    createProvider: createHuggingFace,
    aliases: ['huggingface', 'hf'],
  },
  {
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshotai/kimi-k2.5',
    createProvider: createMoonshotAI,
    aliases: ['moonshotai', 'moonshot'],
  },
  {
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'alibaba/qwen3.5-plus',
    createProvider: createAlibaba,
    aliases: ['alibaba', 'dashscope'],
  },
  {
    apiKeyEnvVar: 'GOOGLE_VERTEX_API_KEY',
    defaultModel: 'vertex/gemini-3.1-pro-preview',
    createProvider: createVertex,
    aliases: ['vertex'],
  },
  {
    apiKeyEnvVar: 'BASETEN_API_KEY',
    defaultModel: 'baseten/Qwen/Qwen3-235B-A22B-Instruct-2507',
    createProvider: createBaseten,
    aliases: ['baseten'],
  },
  {
    apiKeyEnvVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'perplexity/sonar-pro',
    createProvider: createPerplexity,
    aliases: ['perplexity'],
  },
  {
    apiKeyEnvVar: 'VERCEL_API_KEY',
    defaultModel: 'vercel/v0-1.5-md',
    createProvider: createVercel,
    aliases: ['vercel'],
  },
  {
    apiKeyEnvVar: '',
    defaultModel: 'ollama/llama3.1',
    createProvider: createOpenAI,
    baseURL: 'http://localhost:11434/v1',
    aliases: ['ollama'],
  },
];

/** Flat lookup: provider prefix (and all aliases) → config. */
const PROVIDER_LOOKUP: Record<string, ProviderConfig> = {};
for (const cfg of PROVIDERS) {
  for (const alias of cfg.aliases ?? []) {
    PROVIDER_LOOKUP[alias] = cfg;
  }
}

/**
 * Returns the API key for a given provider.
 *
 * - Known provider: requires its specific env var; throws immediately if missing.
 * - Unknown provider: assumed to be an OpenAI-compatible custom endpoint, so falls
 *   back to OPENROUTER_API_KEY or OPENAI_API_KEY before throwing.
 */
function resolveApiKey(provider: string): string {
  const cfg = PROVIDER_LOOKUP[provider.toLowerCase()];
  const knownVar = cfg?.apiKeyEnvVar;

  // Ollama needs no key — return a placeholder that satisfies SDK validation.
  if (knownVar === '') return 'sk-none';

  if (knownVar) {
    const val = process.env[knownVar]?.trim();
    if (val) return val;
    throw new Error(`No API key found for provider "${provider}". Set ${knownVar}.`);
  }

  // Unknown provider: route through the OpenAI-compatible SDK; try common keys.
  for (const envVar of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
    const val = process.env[envVar]?.trim();
    if (val) return val;
  }

  throw new Error(
    `No API key found for unknown provider "${provider}". ` +
      'Set OPENROUTER_API_KEY or OPENAI_API_KEY.',
  );
}

// ---------------------------------------------------------------------------
// Model string parsing
// ---------------------------------------------------------------------------

/**
 * Splits a `provider/model` string into provider + modelId.
 *
 * Handles multi-segment models (e.g. "openrouter/google/gemini-2.5-pro"):
 * - provider = "openrouter"
 * - modelId = "google/gemini-2.5-pro"  (everything after the first slash)
 *
 * If no slash is present, defaults provider to "openai" for backwards-compat
 * with bare model names passed by the user.
 *
 * Also normalises the legacy `provider:model` separator.
 */
function parseModelString(raw: string): { provider: string; modelId: string } {
  const normalised = raw.trim().replace(':', '/');
  const slashIdx = normalised.indexOf('/');
  if (slashIdx === -1) {
    return { provider: 'openai', modelId: normalised };
  }
  return {
    provider: normalised.slice(0, slashIdx),
    modelId: normalised.slice(slashIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Core resolution function
// ---------------------------------------------------------------------------

/**
 * Resolves the full LLM configuration for a named agent.
 *
 * Resolution cascade (highest → lowest priority):
 *   1. Per-agent from `--model` (agent=model parts)
 *   2. Global from `--model` CLI flag
 *   3. Auto-discovery from standard API keys (ANTHROPIC_API_KEY, etc.)
 *
 * @param agentName - Canonical agent name (e.g. "coder", "results-judge") used in `--model` agent=model parts.
 * @param overrides - Parsed CLI flags (from `parseModelOverrides()`).
 */
export function resolveAgentLlmConfig(agentName: string, overrides: ModelOverrides): LlmConfig {
  // 1. Per-agent CLI flag
  const agentModelRaw = overrides.agentModels?.[agentName];
  // 2. Global CLI flag
  const globalModelRaw = overrides.model;

  const modelRaw = agentModelRaw ?? globalModelRaw;

  let fullModelString: string;
  let apiKey: string;

  if (modelRaw) {
    fullModelString = modelRaw.replace(':', '/');
    const { provider } = parseModelString(fullModelString);
    apiKey = resolveApiKey(provider);
  } else {
    // 3. Zero-config auto-discovery
    const defaults = getZeroConfigDefault();
    if (!defaults) {
      const envList = PROVIDERS.filter((c) => c.apiKeyEnvVar)
        .map((c) => c.apiKeyEnvVar)
        .join(', ');
      throw new Error(
        `No AI credentials found. Set one of: ${envList}. ` +
          'Or specify a model explicitly with --model <provider/model>.',
      );
    }
    fullModelString = defaults.model;
    apiKey = process.env[defaults.apiKeyEnv]?.trim() ?? resolveApiKey('');
  }

  const { provider, modelId } = parseModelString(fullModelString);

  // Base URL: per-agent override → global override → provider default
  const baseURL =
    overrides.agentBaseUrls?.[agentName] ??
    overrides.baseUrl ??
    PROVIDER_LOOKUP[provider.toLowerCase()]?.baseURL;

  return { modelId, provider, fullModelString, apiKey, baseURL };
}

/**
 * Auto-discover a sensible default by inspecting which API keys are present.
 * Iterates PROVIDERS in declaration order; first match wins.
 */
function getZeroConfigDefault(): { model: string; apiKeyEnv: string } | undefined {
  for (const cfg of PROVIDERS) {
    if (cfg.apiKeyEnvVar && process.env[cfg.apiKeyEnvVar]?.trim()) {
      return { model: cfg.defaultModel, apiKeyEnv: cfg.apiKeyEnvVar };
    }
  }
}

// ---------------------------------------------------------------------------
// Provider model factory
// ---------------------------------------------------------------------------

/**
 * Instantiates a Vercel AI SDK `LanguageModelV3` from a resolved `LlmConfig`.
 *
 * Dispatches to the native SDK for each provider when available.
 * Falls back to `@ai-sdk/openai` (OpenAI / OpenRouter / Ollama) for everything else.
 */
export function createProviderModel(config: LlmConfig): LanguageModelV3 {
  const p = config.provider.toLowerCase();
  const opts = {
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  };

  const cfg = PROVIDER_LOOKUP[p];
  if (cfg) {
    const provider = cfg.createProvider(opts);
    return provider(config.modelId);
  }

  // Unknown provider: route via OpenAI-compatible endpoint.
  return createOpenAI(opts).chat(config.modelId);
}

// ---------------------------------------------------------------------------
// Convenience: resolve + instantiate in one step
// ---------------------------------------------------------------------------

/**
 * Resolves config for a named agent and immediately returns the AI SDK model.
 * Convenience wrapper for the common case in Mastra agent factories.
 *
 * @param agentName - Canonical agent name used in `--model` agent=model parts.
 * @param overrides - Parsed CLI flags (from `parseModelOverrides()`).
 */
export function resolveAgentModel(agentName: string, overrides: ModelOverrides): LanguageModelV3 {
  return createProviderModel(resolveAgentLlmConfig(agentName, overrides));
}
