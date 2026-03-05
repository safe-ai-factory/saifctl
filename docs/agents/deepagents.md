# Deep Agents CLI

[Deep Agents CLI](https://github.com/langchain-ai/deepagents) is LangChain's terminal agent. Installed at runtime via uv, pipx, or pip with provider extras (anthropic, groq, openrouter).

**Usage:** `pnpm agents feat:run my-feature --agent deepagents`

## How we call it

```bash
deepagents \
  --agent factory \
  -n "$(cat "$FACTORY_TASK_PATH")" \
  --auto-approve \
  --shell-allow-list recommended
```
`--model "$LLM_MODEL"` is appended when `LLM_MODEL` is set (see model format below).

## Notes

- **Python required** — Installed via uv/pipx/pip. Node-only images will fail.
- **Model format** — Must be `provider:model` (e.g. `openai:gpt-4o`, `anthropic:claude-sonnet-4-5`).
  - If `LLM_MODEL` has no prefix and `LLM_PROVIDER` is set, we prepend the provider.
- **API keys** — `LLM_API_KEY` mapped to `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. Native keys take precedence.
- **Base URL** — No CLI flag. Base URL set via `base_url` field in deepagent's `config.toml`.
- **`--agent factory`** — Uses a separate config/memory dir so factory runs don't mix with your default agent.
