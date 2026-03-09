# LLM configuration

The factory uses multiple AI agents at different points in the workflow. Each can be configured independently, or all at once with a single flag `--model`.

**Supported providers:** Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Groq, Cohere, Together, Fireworks, DeepInfra, Cerebras, Hugging Face, Moonshot AI, Alibaba, Vertex, Baseten, Perplexity, Vercel, OpenRouter, and Ollama.

## Quick start

Set one API key and everything works — no other config needed:

```sh
# picks claude-sonnet-4-6
export ANTHROPIC_API_KEY=sk-ant-...

# picks gpt-5.4
export OPENAI_API_KEY=sk-...

# picks openrouter/anthropic/claude-sonnet-4-6
export OPENROUTER_API_KEY=sk-or-...

saif feat run
```

To use a specific model, add `--model` to any command:

```sh
saif feat design-specs --model anthropic/claude-opus-4-5

saif feat run --model openai/gpt-4o
```

---

## Model string format

Models are specified as `provider/model`:

| Format                      | Example                                | Meaning                  |
| --------------------------- | -------------------------------------- | ------------------------ |
| `provider/model`            | `anthropic/claude-sonnet-4-6`          | Anthropic native API     |
| `provider/model`            | `openai/gpt-5.4`                       | OpenAI native API        |
| `provider/model`            | `google/gemini-3.1-pro-preview`        | Google Gemini native API |
| `openrouter/provider/model` | `openrouter/meta-llama/llama-3.1-405b` | Any model via OpenRouter |
| `model` (no prefix)         | `gpt-4o`                               | Treated as OpenAI model  |

The provider prefix determines which SDK and API key are used:

| Provider prefix | SDK                     | API key env var         | Default model                                                 |
| --------------- | ----------------------- | ----------------------- | ------------------------------------------------------------- |
| `alibaba`       | `@ai-sdk/alibaba`       | `DASHSCOPE_API_KEY`     | `alibaba/qwen3.5-plus`                                        |
| `anthropic`     | `@ai-sdk/anthropic`     | `ANTHROPIC_API_KEY`     | `anthropic/claude-sonnet-4-6`                                 |
| `baseten`       | `@ai-sdk/baseten`       | `BASETEN_API_KEY`       | `baseten/Qwen/Qwen3-235B-A22B-Instruct-2507`                  |
| `cerebras`      | `@ai-sdk/cerebras`      | `CEREBRAS_API_KEY`      | `cerebras/llama3.3-70b`                                       |
| `cohere`        | `@ai-sdk/cohere`        | `COHERE_API_KEY`        | `cohere/command-a-03-2025`                                    |
| `deepinfra`     | `@ai-sdk/deepinfra`     | `DEEPINFRA_API_KEY`     | `deepinfra/meta-llama/Llama-3.3-70B-Instruct`                 |
| `deepseek`      | `@ai-sdk/deepseek`      | `DEEPSEEK_API_KEY`      | `deepseek/deepseek-chat`                                      |
| `fireworks`     | `@ai-sdk/fireworks`     | `FIREWORKS_API_KEY`     | `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` |
| `google`        | `@ai-sdk/google`        | `GEMINI_API_KEY`        | `google/gemini-3.1-pro-preview`                               |
| `groq`          | `@ai-sdk/groq`          | `GROQ_API_KEY`          | `groq/llama-3.3-70b-versatile`                                |
| `huggingface`   | `@ai-sdk/huggingface`   | `HF_TOKEN`              | `huggingface/meta-llama/Llama-3.3-70B-Instruct`               |
| `mistral`       | `@ai-sdk/mistral`       | `MISTRAL_API_KEY`       | `mistral/mistral-large-2512`                                  |
| `moonshotai`    | `@ai-sdk/moonshotai`    | `MOONSHOT_API_KEY`      | `moonshotai/kimi-k2.5`                                        |
| `openai`        | `@ai-sdk/openai`        | `OPENAI_API_KEY`        | `openai/gpt-5.4`                                              |
| `openrouter`    | `@ai-sdk/openai`        | `OPENROUTER_API_KEY`    | `openrouter/anthropic/claude-sonnet-4-6`                      |
| `ollama`        | `@ai-sdk/openai`        | _(none)_                | `ollama/llama3.1`                                             |
| `perplexity`    | `@ai-sdk/perplexity`    | `PERPLEXITY_API_KEY`    | `perplexity/sonar-pro`                                        |
| `together`      | `@ai-sdk/togetherai`    | `TOGETHER_API_KEY`      | `together/meta-llama/Llama-3.3-70B-Instruct`                  |
| `vercel`        | `@ai-sdk/vercel`        | `VERCEL_API_KEY`        | `vercel/v0-1.5-md`                                            |
| `vertex`        | `@ai-sdk/google-vertex` | `GOOGLE_VERTEX_API_KEY` | `vertex/gemini-3.1-pro-preview`                               |
| `xai`           | `@ai-sdk/xai`           | `XAI_API_KEY`           | `xai/grok-4-1-fast-reasoning`                                 |
| _(no prefix)_   | `@ai-sdk/openai`        | `OPENAI_API_KEY`        | _(same as openai)_                                            |

---

## CLI flags

All LLM-using commands accept these flags.

### `--model <provider/model>`

Set the model for **all agents** in the command.

```sh
# Use Claude for the entire design pipeline
saif feat design --model anthropic/claude-sonnet-4-6

# Use GPT-4o for the coding agent loop
saif feat run --model openai/gpt-4o

# Use OpenRouter to route to any model
saif feat run --model openrouter/meta-llama/llama-3.1-405b
```

### `--base-url <url>`

Override the API endpoint for all agents. Use for local models, custom proxies, or self-hosted deployments.

```sh
# Local Ollama
saif feat run \
  --model ollama/qwen2.5-coder:32b \
  --base-url http://localhost:11434/v1

# Custom OpenAI-compatible proxy
saif feat design \
  --model myproxy/claude-3-5-sonnet \
  --base-url https://myproxy.example.com/v1
```

### `--agent-model <agent>=<provider/model>`

Override the model for a **single named agent**. Can be repeated.

```sh
# Use a cheaper model for PR summaries,
# keep the default for the coder
saif feat run \
  --model anthropic/claude-3-5-sonnet-latest \
  --agent-model pr-summarizer=openai/gpt-4o-mini

# Override two agents at once
saif feat run \
  --agent-model coder=openai/o3 \
  --agent-model results-judge=anthropic/claude-opus-4-5
```

### `--agent-base-url <agent>=<url>`

Override the API endpoint for a single agent.

```sh
saif feat run \
  --agent-model coder=qwen2.5-coder:32b \
  --agent-base-url coder=http://localhost:11434/v1
```

---

## Resolution order

For each agent, the model is resolved in this priority order:

1. `--agent-model <name>=<model>` — per-agent CLI flag (highest priority)
2. `--model <model>` — global CLI flag
3. Auto-discovery from available API keys (lowest priority)

Base URL follows the same cascade using `--agent-base-url` / `--base-url` / provider default.

---

## Auto-discovery defaults

When no `--model` flag is given, the factory inspects which API key is present
and picks a reasonable default:

| Key present             | Default model                                                 |
| ----------------------- | ------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | `anthropic/claude-sonnet-4-6`                                 |
| `OPENAI_API_KEY`        | `openai/gpt-5.4`                                              |
| `OPENROUTER_API_KEY`    | `openrouter/anthropic/claude-sonnet-4-6`                      |
| `GEMINI_API_KEY`        | `google/gemini-3.1-pro-preview`                               |
| `XAI_API_KEY`           | `xai/grok-4-1-fast-reasoning`                                 |
| `MISTRAL_API_KEY`       | `mistral/mistral-large-2512`                                  |
| `DEEPSEEK_API_KEY`      | `deepseek/deepseek-chat`                                      |
| `GROQ_API_KEY`          | `groq/llama-3.3-70b-versatile`                                |
| `COHERE_API_KEY`        | `cohere/command-a-03-2025`                                    |
| `TOGETHER_API_KEY`      | `together/meta-llama/Llama-3.3-70B-Instruct`                  |
| `FIREWORKS_API_KEY`     | `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` |
| `DEEPINFRA_API_KEY`     | `deepinfra/meta-llama/Llama-3.3-70B-Instruct`                 |
| `CEREBRAS_API_KEY`      | `cerebras/llama3.3-70b`                                       |
| `HF_TOKEN`              | `huggingface/meta-llama/Llama-3.3-70B-Instruct`               |
| `MOONSHOT_API_KEY`      | `moonshotai/kimi-k2.5`                                        |
| `DASHSCOPE_API_KEY`     | `alibaba/qwen3.5-plus`                                        |
| `GOOGLE_VERTEX_API_KEY` | `vertex/gemini-3.1-pro-preview`                               |
| `BASETEN_API_KEY`       | `baseten/Qwen/Qwen3-235B-A22B-Instruct-2507`                  |
| `PERPLEXITY_API_KEY`    | `perplexity/sonar-pro`                                        |
| `VERCEL_API_KEY`        | `vercel/v0-1.5-md`                                            |

Keys are checked in the order listed above; the first match wins.

---

## Agent reference

| Agent                             | ID              | Commands                                       |
| --------------------------------- | --------------- | ---------------------------------------------- |
| Coding agent<br/>(e.g. OpenHands) | `coder`         | `feat run`<br/>`feat continue`                 |
| Tests planner                     | `tests-planner` | `feat design-tests`<br/>`feat design`          |
| Tests cataloger                   | `tests-catalog` | `feat design-tests`<br/>`feat design`          |
| Tests writer                      | `tests-writer`  | `feat design-tests`<br/>`feat design`          |
| Results judge                     | `results-judge` | `feat run`<br/>`feat continue`<br/>`feat test` |
| PR summarizer                     | `pr-summarizer` | `feat run`<br/>`feat continue`<br/>`feat test` |

**Example — override every agent individually:**

```sh
saif feat run \
  --agent-model coder=openai/o3 \
  --agent-model results-judge=anthropic/claude-opus-4-5 \
  --agent-model pr-summarizer=openai/gpt-4o-mini \
  --agent-model tests-planner=anthropic/claude-sonnet-4-6 \
  --agent-model tests-catalog=anthropic/claude-sonnet-4-6 \
  --agent-model tests-writer=anthropic/claude-sonnet-4-6
```

**Typical pattern — strong model for reasoning, cheaper model for utility tasks:**

```sh
# Flagship model for the coder + results judge,
# mini model for PR summaries
saif feat run \
  --model anthropic/claude-sonnet-4-6 \
  --agent-model pr-summarizer=openai/gpt-4o-mini
```

---

## See also

- [Environment variables](env-vars.md) — API keys and container-injected vars
- [feat design-specs](commands/feat-design-specs.md) — Spec generation command
- [feat design-tests](commands/feat-design-tests.md) — Test generation command
- [feat run / feat continue](commands/README.md) — Coding agent loop commands
