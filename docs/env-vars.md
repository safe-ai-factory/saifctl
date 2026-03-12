# Environment variables

## LLM API keys

Set the API key for the provider you want to use. At least one must be present.
When no `--model` flag is given, the factory auto-detects which key is available
and picks a sensible default model for that provider.

| Variable                | Provider       |
| ----------------------- | -------------- |
| `ANTHROPIC_API_KEY`     | Anthropic      |
| `OPENAI_API_KEY`        | OpenAI         |
| `OPENROUTER_API_KEY`    | OpenRouter     |
| `GEMINI_API_KEY`        | Google Gemini  |
| `XAI_API_KEY`           | xAI Grok       |
| `MISTRAL_API_KEY`       | Mistral AI     |
| `DEEPSEEK_API_KEY`      | DeepSeek       |
| `GROQ_API_KEY`          | Groq           |
| `COHERE_API_KEY`        | Cohere         |
| `TOGETHER_API_KEY`      | Together AI    |
| `FIREWORKS_API_KEY`     | Fireworks AI   |
| `DEEPINFRA_API_KEY`     | DeepInfra      |
| `CEREBRAS_API_KEY`      | Cerebras       |
| `HF_TOKEN`              | Hugging Face   |
| `MOONSHOT_API_KEY`      | Moonshot AI    |
| `DASHSCOPE_API_KEY`     | Alibaba (Qwen) |
| `GOOGLE_VERTEX_API_KEY` | Google Vertex  |
| `BASETEN_API_KEY`       | Baseten        |
| `PERPLEXITY_API_KEY`    | Perplexity     |
| `VERCEL_API_KEY`        | Vercel AI      |

**Quick start:** set `ANTHROPIC_API_KEY` in your `.env` file — the factory
will default to `claude-sonnet-4-6` automatically. For the full provider
table and auto-discovery defaults, see [Models](models.md).

## Git provider env vars

[Git providers](./source-control.md) allow your AI agent to create a PR when it is done.

Each provider reads its token from env vars:

| Provider    | Env vars                                                 |
| ----------- | -------------------------------------------------------- |
| `github`    | `GITHUB_TOKEN`                                           |
| `gitlab`    | `GITLAB_TOKEN` (+ optional `GITLAB_URL`)                 |
| `gitea`     | `GITEA_TOKEN`, `GITEA_USERNAME` (+ optional `GITEA_URL`) |
| `bitbucket` | `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`                  |
| `azure`     | `AZURE_DEVOPS_TOKEN`                                     |

## Container variables

The following variables are **generated at runtime by the orchestrator** and
injected into the Leash coder container. Do not set them in your `.env` — they
will be overwritten.

| Variable       | Set from                                                               |
| -------------- | ---------------------------------------------------------------------- |
| `LLM_MODEL`    | Resolved from `--model` (global or agent=model parts) / auto-discovery |
| `LLM_PROVIDER` | Derived from the `provider/model` prefix                               |
| `LLM_API_KEY`  | Resolved from the provider's standard key env var                      |
| `LLM_BASE_URL` | Resolved from `--base-url` (global or agent=url parts)                 |

Agent shell scripts (`agent.sh`, `agent-start.sh`) read these variables to
configure the coding agent (e.g. `OPENAI_API_KEY` for Codex, `ANTHROPIC_API_KEY`
for Claude Code).

These are the **private** contract between the orchestrator and the
container — you should never need to set them directly.
