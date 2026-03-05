# Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) is Google's terminal agent. Pre-installed in the Leash coder image.

**Usage:** `pnpm agents feat:run my-feature --agent gemini`

## How we call it

```bash
gemini \
  --model "$LLM_MODEL" \
  --yolo \
  --output-format stream-json \
  "$(cat "$FACTORY_TASK_PATH")"
```
The prompt is passed as a positional argument (not `-p`, which is `--profile`).

## Notes

- **API key** — `GEMINI_API_KEY` or fallback to `LLM_API_KEY`.
- **No base URL** — Gemini CLI does not support a base URL override. `LLM_BASE_URL` is not forwarded.
- **Pre-installed in Leash image** — If you supply custom `--coder-image`, you will need to install Gemini CLI yourself.
