# CLI Agent Integrations

**Agent integrations** are pluggable CLI tools (Aider, OpenHands, Claude Code, etc.). `safe-ai-factory` runs them in a safe, spec-driven loop.

The CLI tools receive the task and they edit files in the workspace.

---

## Choosing an agent

### Built-in profiles

Use `--agent <id>`:

```bash
saif feat run --agent aider
saif feat run --agent claude
```

| ID                                      | Name                | Project URL                                         |
| --------------------------------------- | ------------------- | --------------------------------------------------- |
| [`openhands`](./openhands.md)           | OpenHands (default) | [Link](https://github.com/OpenHands/OpenHands)      |
| [`aider`](./aider.md)                   | Aider               | [Link](https://github.com/Aider-AI/aider)           |
| [`claude`](./claude.md)                 | Claude Code         | [Link](https://code.claude.com)                     |
| [`forge`](./forge.md)                   | Forge Code          | [Link](https://forgecode.dev)                       |
| [`copilot`](./copilot.md)               | GitHub Copilot CLI  | [Link](https://github.com/github/copilot-cli)       |
| [`terminus`](./terminus.md)             | Terminus 2          | [Link](https://pypi.org/project/terminus-ai/)       |
| [`codex`](./codex.md)                   | Codex               | [Link](https://github.com/openai/codex)             |
| [`gemini`](./gemini.md)                 | Gemini              | [Link](https://github.com/google-gemini/gemini-cli) |
| [`qwen`](./qwen.md)                     | Qwen                | [Link](https://github.com/QwenLM/qwen-code)         |
| [`opencode`](./opencode.md)             | OpenCode            | [Link](https://github.com/opencode-ai/opencode)     |
| [`kilocode`](./kilocode.md)             | Kilo Code CLI       | [Link](https://github.com/Kilo-Org/kilocode)        |
| [`mini-swe-agent`](./mini-swe-agent.md) | mini-SWE-agent      | [Link](https://github.com/SWE-agent/mini-swe-agent) |
| [`deepagents`](./deepagents.md)         | Deep Agents CLI     | [Link](https://github.com/langchain-ai/deepagents)  |

---

### Custom agent script

For any CLI not in the list:

```bash
saif feat run \
  --agent-script ./my-agent-runner.sh \
  --agent-log-format raw
```

Your script must read from `$FACTORY_TASK_PATH` and invoke the agent.

---

## Agent's environment variables

The factory forwards these into the agent container:

| Variable            | Purpose                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `LLM_MODEL`         | Model string (e.g. `anthropic/claude-sonnet-4-5`, `gpt-4o`). <br/>Overridable via `--model`.       |
| `LLM_API_KEY`       | API key.<br/>Agents may map this to provider-specific vars (e.g. `OPENAI_API_KEY`).                |
| `LLM_PROVIDER`      | Provider ID (e.g. `anthropic`, `openrouter`).<br/>Some agents that need it for base URL / routing. |
| `LLM_BASE_URL`      | Base URL (e.g. `https://openrouter.ai/api/v1`).<br/>Overridable via `--base-url`.                  |
| `FACTORY_TASK_PATH` | Path to the task markdown file. Agent script must read from here.                                  |
| `WORKSPACE_BASE`    | Path to the workspace (`/workspace` or host path).                                                 |

Additional vars from `--agent-env` and `--agent-env-file` are forwarded to the container.

See [Environment variables](../env-vars.md) for details.

---

## See Also

- [Agents (development guide)](../development/agents.md)
- [Environment variables](../env-vars.md)
