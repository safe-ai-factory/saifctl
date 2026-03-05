# mini-SWE-agent

[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) is a lightweight agent from Princeton & Stanford. Uses litellm. Installed via pipx — Python required.

**Usage:** `pnpm agents feat:run my-feature --agent mini-swe-agent`

## How we call it

```bash
mini \
  -t "$(cat "$FACTORY_TASK_PATH")" \
  --yolo \
  --exit-immediately
```
`-m "$LLM_MODEL"` when set; `-c mini.yaml -c <tmp_config>` appended when `LLM_BASE_URL` is set.

## Notes

- **Python + pipx required** — Installed via pipx. Node-only images will fail.
- **Model format** — litellm format (e.g. `anthropic/claude-sonnet-4-5`, `openrouter/anthropic/...`). Fallback: `MSWEA_MODEL_NAME`.
- **API keys** — `LLM_API_KEY` mapped to `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. Native keys take precedence.
- **Base URL** — No CLI flag. Base URL set via `model_kwargs.api_base` config field.
- **`MSWEA_COST_TRACKING=ignore_errors`** — Prevents litellm from aborting on unknown models or custom endpoints (no pricing data).
