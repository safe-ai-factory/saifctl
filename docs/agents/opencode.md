# OpenCode

[OpenCode](https://github.com/opencode-ai/opencode) is an open-source coding agent with a TUI. Pre-installed in the Leash coder image.

**Usage:** `pnpm agents feat:run my-feature --agent opencode`

## How we call it

```bash
OPENCODE_PERMISSION='{"*":"allow"}' \
opencode run \
  --model "$LLM_MODEL" \
  --format json \
  "$(cat "$FACTORY_TASK_PATH")"
```

## Notes

- **API keys** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.; fallback to `LLM_API_KEY`.
- **Base URL** — No global env. When `LLM_BASE_URL` is set, we inject `OPENCODE_CONFIG_CONTENT` with a provider-scoped `baseURL`. Provider from `LLM_PROVIDER` or inferred from `LLM_MODEL` prefix (`provider/model`); set `--provider` when in doubt.
- **No `--yolo` flag** — Tool approval is controlled by `OPENCODE_PERMISSION`. We set `{"*":"allow"}` for headless.
- **Pre-installed in Leash image** — If you supply custom `--coder-image`, you will need to install OpenCode yourself.
