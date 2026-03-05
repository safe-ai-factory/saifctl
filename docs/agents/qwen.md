# Qwen Coder

[Qwen Code](https://github.com/QwenLM/qwen-code) is Alibaba's terminal agent. Pre-installed in the Leash coder image.

**Usage:** `pnpm agents feat:run my-feature --agent qwen`

## How we call it

```bash
qwen \
  --prompt "$(cat "$FACTORY_TASK_PATH")" \
  --model "$LLM_MODEL" \
  --yolo \
  --output-format stream-json
```

## Notes

- **API keys** — Supports DASHSCOPE (native Qwen), OpenAI-compatible, Anthropic, Google. We map `LLM_API_KEY` to `DASHSCOPE_API_KEY` and `OPENAI_API_KEY`.
- **Base URL** — `LLM_BASE_URL` forwarded as `OPENAI_BASE_URL` (OpenRouter, proxies, etc.).
- **Pre-installed in Leash image** — If you supply custom `--coder-image`, you will need to install Qwen yourself.
