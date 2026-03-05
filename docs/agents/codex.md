# Codex

[Codex](https://github.com/openai/codex) is OpenAI's CLI coding agent. Uses the `exec` subcommand for headless, non-interactive runs.

**Usage:** `pnpm agents feat:run my-feature --agent codex`

## How we call it

```bash
codex exec \
  --model "$LLM_MODEL" \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  --ephemeral \
  - < "$FACTORY_TASK_PATH"
```

## Notes

- **API key** — `OPENAI_API_KEY` or fallback to `LLM_API_KEY`.
- **Base URL** — `LLM_BASE_URL` is forwarded as `OPENAI_BASE_URL` for custom endpoints.
- **Pre-installed in Leash image** — If you supply custom `--coder-image`, you will need to install Codex yourself.
