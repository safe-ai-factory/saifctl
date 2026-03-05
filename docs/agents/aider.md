# Aider

[Aider](https://github.com/Aider-AI/aider) is an AI pair-programming tool that edits code in your terminal. It uses litellm, so it works with OpenAI, Anthropic, OpenRouter, Gemini, and many other providers.

**Usage:** `pnpm agents feat:run my-feature --agent aider`

## How we call it

```bash
aider \
  --model "$LLM_MODEL" \
  --message-file "$FACTORY_TASK_PATH" \
  --yes \
  --no-auto-commits \
  --no-check-update \
  --no-suggest-shell-commands
```

## Notes

- **Python + pipx required** — Node-only images will fail.
- **No auto-commits** — Aider normally commits its changes. The factory relies on git diffs so we pass `--no-auto-commits`.
- **Model format** — Use whatever litellm expects for your provider (e.g. `anthropic/claude-sonnet-4-5`, `gpt-4o`). Set `LLM_MODEL` or `--model`.
- **API keys** — Factory forwards `LLM_API_KEY`; we map it to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. If you already set a provider-specific key, it takes precedence.
