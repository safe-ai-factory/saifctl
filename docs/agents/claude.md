# Claude Code

[Claude Code](https://code.claude.com) is Anthropic's CLI for AI-assisted coding. Runs headlessly with `-p` (print mode).

**Usage:** `pnpm agents feat:run my-feature --agent claude`

## How we call it

```bash
claude \
  -p "$(cat "$FACTORY_TASK_PATH")" \
  --model "$LLM_MODEL" \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  --no-session-persistence \
  --disable-slash-commands
```

## Notes

- **API key** — `ANTHROPIC_API_KEY` or fallback to `LLM_API_KEY`.
- **No generic base URL** — Claude Code has no `LLM_BASE_URL`-style override.
- **`--disable-slash-commands`** — Prevents task text from being interpreted as Claude Code slash commands.
- **Pre-installed in Leash image** — If you supply custom `--coder-image`, you will need to install Claude Code yourself.
