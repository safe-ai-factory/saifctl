/**
 * LLM API key env names and .env parsing (no vscode dependency — safe for unit tests).
 */

/** API key env vars supported by saifctl LLM resolution (mirrors core llm-config providers). */
export const LLM_SECRET_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'DEEPINFRA_API_KEY',
  'CEREBRAS_API_KEY',
  'HF_TOKEN',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'GOOGLE_VERTEX_API_KEY',
  'BASETEN_API_KEY',
  'PERPLEXITY_API_KEY',
  'VERCEL_API_KEY',
] as const;

export type LlmSecretKeyName = (typeof LLM_SECRET_KEY_NAMES)[number];

/** Short labels for QuickPick (env var → provider hint). */
export const LLM_SECRET_KEY_LABELS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Anthropic (Claude)',
  OPENAI_API_KEY: 'OpenAI',
  OPENROUTER_API_KEY: 'OpenRouter',
  GEMINI_API_KEY: 'Google Gemini',
  XAI_API_KEY: 'xAI (Grok)',
  MISTRAL_API_KEY: 'Mistral',
  DEEPSEEK_API_KEY: 'DeepSeek',
  GROQ_API_KEY: 'Groq',
  COHERE_API_KEY: 'Cohere',
  TOGETHER_API_KEY: 'Together AI',
  FIREWORKS_API_KEY: 'Fireworks',
  DEEPINFRA_API_KEY: 'DeepInfra',
  CEREBRAS_API_KEY: 'Cerebras',
  HF_TOKEN: 'Hugging Face',
  MOONSHOT_API_KEY: 'Moonshot / Kimi',
  DASHSCOPE_API_KEY: 'Alibaba DashScope',
  GOOGLE_VERTEX_API_KEY: 'Google Vertex',
  BASETEN_API_KEY: 'Baseten',
  PERPLEXITY_API_KEY: 'Perplexity',
  VERCEL_API_KEY: 'Vercel AI',
};

/** Parse KEY=value lines; supports # comments, optional export, simple quoted values. */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export function hasAnyKnownLlmKeyInEnv(env: NodeJS.ProcessEnv): boolean {
  for (const name of LLM_SECRET_KEY_NAMES) {
    const v = env[name];
    if (typeof v === 'string' && v.trim().length > 0) return true;
  }
  return false;
}
