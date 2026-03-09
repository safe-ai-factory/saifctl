# Terminus 2

[Terminus](https://pypi.org/project/terminus-ai/) is Harbor's reference agent. Uses a single tmux session as its only tool — sends keystrokes and reads the screen. Installed via pipx.

**Usage:** `saif feat run --agent terminus`

## How we call it

```bash
terminus \
  "$(cat "$FACTORY_TASK_PATH")" \
  --model "$LLM_MODEL" \
  --parser json \
  --temperature 0.7
```

`--api-base "$LLM_BASE_URL"` when set.

## Notes

- **Python 3.12+ and tmux required** — Installed via pipx. Terminus uses tmux for all interaction; we try to install tmux if missing (apt/dnf/pacman).
- **LLM_MODEL required** — Terminus has no default model. Must be set.
- **Model format** — litellm format (e.g. `anthropic/claude-sonnet-4-5`, `openrouter/...`).
- **API keys** — `LLM_API_KEY` mapped to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. When using `LLM_BASE_URL`, `OPENAI_API_KEY` is used for OpenAI-compatible endpoints.
- **Autonomous by design** — No yolo flag; Terminus never prompts for confirmation.
