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
 * native SDK is instantiated. The `PROVIDERS` array below is the canonical
 * list — each entry declares its env var, default model, and (for `openai-
 * compat`) the registered baseURL.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';

// ---------------------------------------------------------------------------
// Supported agent names
// ---------------------------------------------------------------------------

/**
 * Canonical agent names that use LLM models.
 * Used to validate agent keys in --model, --base-url, and config.defaults.agentModels/agentBaseUrls.
 *
 * Add new names here when introducing agents that call resolveAgentLlmConfig/resolveAgentModel.
 */
export const SUPPORTED_AGENT_NAMES = [
  'coder',
  'discovery',
  'reviewer',
  'vague-specs-check',
  'pr-summarizer',
  'tests-catalog',
  'tests-writer',
] as const;

export type SupportedAgentName = (typeof SUPPORTED_AGENT_NAMES)[number];

/** Set for O(1) validation. */
const SUPPORTED_AGENT_NAMES_SET = new Set<string>(SUPPORTED_AGENT_NAMES);

export function isSupportedAgentName(name: string): boolean {
  return SUPPORTED_AGENT_NAMES_SET.has(name);
}

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
 * Placeholder LLM config for `saifctl run inspect`: the coding container stays idle
 * (`sleep infinity`) and does not run the factory agent, so host API keys are not required.
 * Reuses the same no-key pattern as Ollama in {@link resolveApiKey}.
 */
export function dummyInspectLlmConfig(): LlmConfig {
  return {
    modelId: 'inspect',
    provider: 'ollama',
    fullModelString: 'ollama/inspect',
    apiKey: 'sk-none',
  };
}

/**
 * Effective LLM configuration for model resolution: global + per-agent models and base URLs.
 *
 * Examples (CLI):
 * ```
 * --model anthropic/claude-3-5-sonnet-latest
 * --model coder=openai/o3,pr-summarizer=openai/gpt-4o-mini
 * --base-url https://api.anthropic.com/v1
 * --base-url coder=https://api.anthropic.com/v1,pr-summarizer=https://api.openai.com/v1
 * ```
 *
 * Built from config baseline + optional artifact + CLI delta, threaded through from command
 * entry points down to any function that resolves an agent model.
 */
export interface LlmOverrides {
  /** Global model; value of `--model` — applies to all agents. */
  globalModel?: string;
  /** Global base URL; value of `--base-url` — applies to all agents. */
  globalBaseUrl?: string;
  /** Per-agent model overrides from `--model`; agent=model parts. */
  agentModels?: Record<string, string>;
  /** Per-agent base URL overrides from `--base-url`; agent=url parts. */
  agentBaseUrls?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

type CreateProviderFn = (opts: {
  apiKey: string;
  baseURL?: string;
}) => ProviderV3 & { (modelId: string): LanguageModelV3 };

/**
 * A provider entry is one of two shapes:
 *
 * - **`native`** — the provider has its own `@ai-sdk/<name>` package which we
 *   instantiate directly. Used for endpoints that don't expose an OpenAI-
 *   compatible chat-completions surface (Anthropic, Google Generative AI,
 *   Google Vertex), and for OpenAI itself.
 *
 * - **`openai-compat`** — the provider exposes an OpenAI-compatible endpoint;
 *   we instantiate `@ai-sdk/openai` with the provider's `baseURL`. This keeps
 *   `LLM_PROVIDER` semantics intact for container-side scripts (which may
 *   read the provider name to pick API conventions) while collapsing 15
 *   `@ai-sdk/*` packages into a single shared dependency.
 *
 * Per Decision D-05 in `saifctl/features/release-readiness/specification.md`.
 */
type ProviderConfig =
  | {
      kind: 'native';
      apiKeyEnvVar: string;
      defaultModel: string;
      createProvider: CreateProviderFn;
      /** Default base URL — only set when the SDK's own default is wrong (rare for native). */
      baseURL?: string;
      /** Alternative prefixes that resolve to this provider (e.g. "gemini" → google). */
      aliases?: string[];
    }
  | {
      kind: 'openai-compat';
      apiKeyEnvVar: string;
      defaultModel: string;
      /** Required: base URL of the provider's OpenAI-compatible endpoint. */
      baseURL: string;
      aliases?: string[];
    };

/**
 * Canonical provider definitions, in auto-discovery priority order (first match wins).
 * Aliases are declared inline; a flat lookup map is built below.
 */
export const PROVIDERS: ProviderConfig[] = [
  {
    kind: 'native',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    createProvider: createAnthropic,
    aliases: ['anthropic'],
  },
  {
    kind: 'native',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'openai/gpt-5.4',
    createProvider: createOpenAI,
    aliases: ['openai'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4-6',
    baseURL: 'https://openrouter.ai/api/v1',
    aliases: ['openrouter'],
  },
  {
    kind: 'native',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    defaultModel: 'google/gemini-3.1-pro-preview',
    createProvider: createGoogleGenerativeAI,
    aliases: ['google', 'gemini'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'XAI_API_KEY',
    defaultModel: 'xai/grok-4-1-fast-reasoning',
    baseURL: 'https://api.x.ai/v1',
    aliases: ['xai'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral/mistral-large-2512',
    baseURL: 'https://api.mistral.ai/v1',
    aliases: ['mistral'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek/deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    aliases: ['deepseek'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'GROQ_API_KEY',
    defaultModel: 'groq/llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
    aliases: ['groq'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'COHERE_API_KEY',
    defaultModel: 'cohere/command-a-03-2025',
    baseURL: 'https://api.cohere.com/compatibility/v1',
    aliases: ['cohere'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    defaultModel: 'together/meta-llama/Llama-3.3-70B-Instruct',
    baseURL: 'https://api.together.xyz/v1',
    aliases: ['together', 'togetherai'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    defaultModel: 'fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    aliases: ['fireworks'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    defaultModel: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    aliases: ['deepinfra'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    defaultModel: 'cerebras/llama3.3-70b',
    baseURL: 'https://api.cerebras.ai/v1',
    aliases: ['cerebras'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'HF_TOKEN',
    defaultModel: 'huggingface/meta-llama/Llama-3.3-70B-Instruct',
    baseURL: 'https://router.huggingface.co/v1',
    aliases: ['huggingface', 'hf'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    defaultModel: 'moonshotai/kimi-k2.5',
    baseURL: 'https://api.moonshot.cn/v1',
    aliases: ['moonshotai', 'moonshot'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'alibaba/qwen3.5-plus',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    aliases: ['alibaba', 'dashscope'],
  },
  {
    kind: 'native',
    apiKeyEnvVar: 'GOOGLE_VERTEX_API_KEY',
    defaultModel: 'vertex/gemini-3.1-pro-preview',
    createProvider: createVertex,
    aliases: ['vertex'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'BASETEN_API_KEY',
    defaultModel: 'baseten/Qwen/Qwen3-235B-A22B-Instruct-2507',
    baseURL: 'https://inference.baseten.co/v1',
    aliases: ['baseten'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: 'PERPLEXITY_API_KEY',
    defaultModel: 'perplexity/sonar-pro',
    baseURL: 'https://api.perplexity.ai',
    aliases: ['perplexity'],
  },
  {
    kind: 'openai-compat',
    apiKeyEnvVar: '',
    defaultModel: 'ollama/llama3.1',
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
 * **Throws** if no API key can be found for the resolved provider. Use this
 * only for agents that perform LLM inference directly on the host process
 * (e.g. `vague-specs-check`, `pr-summarizer`, designer agents). For agents
 * whose credentials are forwarded into a container, use
 * {@link resolveAgentLlmConfigForContainer} instead.
 *
 * @param agentName - Canonical agent name (e.g. "coder", "vague-specs-check") used in `--model` agent=model parts.
 * @param llm - Effective LLM overrides (merged layers; see `mergeLlmOverridesLayers`).
 */
export function resolveAgentLlmConfig(agentName: string, llm: LlmOverrides): LlmConfig {
  return resolveAgentLlmConfigInternal({ agentName, llm, requireApiKey: true });
}

/**
 * Resolves LLM configuration for an agent whose credentials are forwarded into
 * a container rather than used by the host process directly (i.e. `coder` and
 * `reviewer`).
 *
 * Behaves identically to {@link resolveAgentLlmConfig} except it **never throws
 * for a missing API key** — it falls back to `'sk-none'` instead. This is
 * correct because:
 *   - The host process itself never calls the LLM for these agents.
 *   - Users may use a keyless local endpoint, a custom proxy, or an agent that
 *     authenticates via `--agent-secret` (e.g. Cursor) and ignores `LLM_API_KEY`.
 *   - API key presence inside the container is the container's own concern.
 *
 * All other resolution (model string, provider, base URL) is identical to
 * {@link resolveAgentLlmConfig}.
 *
 * @param agentName - Canonical agent name (e.g. "coder", "reviewer").
 * @param llm - Effective LLM overrides.
 */
export function resolveAgentLlmConfigForContainer(agentName: string, llm: LlmOverrides): LlmConfig {
  return resolveAgentLlmConfigInternal({ agentName, llm, requireApiKey: false });
}

function resolveAgentLlmConfigInternal(opts: {
  agentName: string;
  llm: LlmOverrides;
  requireApiKey: boolean;
}): LlmConfig {
  const { agentName, llm, requireApiKey } = opts;
  if (!isSupportedAgentName(agentName)) {
    throw new Error(
      `Unknown agent "${agentName}". Supported: ${SUPPORTED_AGENT_NAMES.join(', ')}.`,
    );
  }
  // 1. Per-agent CLI flag
  const agentModelRaw = llm.agentModels?.[agentName];
  // 2. Global CLI flag
  const globalModelRaw = llm.globalModel;

  const modelRaw = agentModelRaw ?? globalModelRaw;

  let fullModelString: string;
  let apiKey: string;

  if (modelRaw) {
    fullModelString = modelRaw.replace(':', '/');
    const { provider } = parseModelString(fullModelString);
    apiKey = requireApiKey ? resolveApiKey(provider) : resolveApiKeyOptional(provider);
  } else {
    // 3. Zero-config auto-discovery
    const defaults = getZeroConfigDefault();
    if (!defaults) {
      if (requireApiKey) {
        const envList = PROVIDERS.filter((c) => c.apiKeyEnvVar)
          .map((c) => c.apiKeyEnvVar)
          .join(', ');
        throw new Error(
          `No AI credentials found. Set one of: ${envList}. ` +
            'Or specify a model explicitly with --model <provider/model>.',
        );
      }
      // No credentials and no explicit model — fall back to a no-op placeholder.
      return {
        modelId: 'none',
        provider: 'ollama',
        fullModelString: 'ollama/none',
        apiKey: 'sk-none',
      };
    }
    fullModelString = defaults.model;
    apiKey = requireApiKey
      ? (process.env[defaults.apiKeyEnv]?.trim() ?? resolveApiKey(''))
      : (process.env[defaults.apiKeyEnv]?.trim() ?? 'sk-none');
  }

  const { provider, modelId } = parseModelString(fullModelString);

  // Base URL: per-agent override → global override → provider default
  const baseURL =
    llm.agentBaseUrls?.[agentName] ??
    llm.globalBaseUrl ??
    PROVIDER_LOOKUP[provider.toLowerCase()]?.baseURL;

  return { modelId, provider, fullModelString, apiKey, baseURL };
}

/**
 * Like {@link resolveApiKey} but returns `'sk-none'` instead of throwing when
 * the key is absent. Used for container-forwarded agents where the host need
 * not validate key presence.
 */
function resolveApiKeyOptional(provider: string): string {
  const cfg = PROVIDER_LOOKUP[provider.toLowerCase()];
  const knownVar = cfg?.apiKeyEnvVar;
  if (knownVar === '') return 'sk-none';
  if (knownVar) {
    return process.env[knownVar]?.trim() ?? 'sk-none';
  }
  for (const envVar of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
    const val = process.env[envVar]?.trim();
    if (val) return val;
  }
  return 'sk-none';
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
 * Dispatch (per Decision D-05):
 *
 * - **Native**: Anthropic, OpenAI, Google, Google Vertex use their own SDKs
 *   (none of them expose an OpenAI-compatible chat-completions surface, except
 *   OpenAI itself which is the SDK we'd use anyway).
 * - **OpenAI-compatible**: every other registered provider routes through
 *   `@ai-sdk/openai` with the provider's `baseURL`.
 * - **Unknown provider**: same as openai-compatible, using the user-supplied
 *   baseURL only (no built-in default).
 *
 * The user can override any provider's baseURL via `--base-url`; that value
 * (set on `LlmConfig.baseURL`) takes precedence over the registered default.
 */
export function createProviderModel(config: LlmConfig): LanguageModelV3 {
  const cfg = PROVIDER_LOOKUP[config.provider.toLowerCase()];

  if (cfg?.kind === 'native') {
    const opts = {
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    };
    // Default function call — for `@ai-sdk/openai` this means the Responses API,
    // which is OpenAI-only. The openai-compat branch below deliberately uses
    // `.chat()` instead because third-party "OpenAI-compatible" endpoints
    // implement Chat Completions, not Responses. Do not normalise these two
    // branches without preserving that split.
    return cfg.createProvider(opts)(config.modelId);
  }

  // openai-compat (registered) or unknown provider — both route through @ai-sdk/openai.
  // Precedence for baseURL: explicit override on LlmConfig > registered cfg.baseURL.
  const baseURL = config.baseURL ?? (cfg?.kind === 'openai-compat' ? cfg.baseURL : undefined);
  const opts = {
    apiKey: config.apiKey,
    ...(baseURL ? { baseURL } : {}),
  };
  // `.chat()` is required here — see the comment in the native branch above.
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
 * @param llm - Effective LLM overrides (merged layers; see `mergeLlmOverridesLayers`).
 */
export function resolveAgentModel(agentName: string, llm: LlmOverrides): LanguageModelV3 {
  return createProviderModel(resolveAgentLlmConfig(agentName, llm));
}
