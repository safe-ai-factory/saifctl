# Features

## Any language, any agent, any model

`safe-ai-factory` was designed to work with your codebase:

1. **Language-agnostic:**
   - Included: NodeJS (default), Python, Go, Rust
   - How: `--profile <id>` or supply custom Docker images and installation scripts to adapt.
   - See [Sandbox profiles →](./sandbox-profiles.md)
   ```bash
   saif feat run --profile python-uv
   ```
2. **Any agentic CLI:**
   - Included: OpenHands (default), Aider, Claude Code, Forge, GitHub Copilot CLI, Terminus, Codex, Gemini, Qwen, OpenCode, KiloCode, mini-SWE-agent, Deep Agents.
   - How: `--agent <id>` or supply a custom agent script.
   - See [Agents →](./agents/README.md)
   ```bash
   saif feat run --agent aider
   ```
3. **Any LLM provider:**
   - Included: Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Groq, Cohere, Together, Fireworks, DeepInfra, Cerebras, Hugging Face, Moonshot AI, Alibaba, Vertex, Baseten, Perplexity, Vercel, OpenRouter, and Ollama.
   - Set the matching API key (e.g. `ANTHROPIC_API_KEY`) — the factory picks a default model automatically.
   - Set single model globally or target individual agents.
   - See [LLM configuration →](./models.md)
   ```bash
   saif feat run --model openai/o3
   ```
4. **Connect to any repository**
   - Included: Github, Gitlab, Gitea, Bitbucket, and Azure Repos
   - How: `--git-provider <id>`. To connect, pass your API token as env vars (e.g. `GITHUB_TOKEN`, ...)
   - See [Source control →](./source-control.md)
   ```bash
   saif feat run --git-provider github
   ```

_Missing an integration? [Open an issue](https://github.com/JuroOravec/safe-ai-factory/issues)_

## Agent CLIs

You aren't locked into a single AI coding tool. Use any CLI agent you prefer — we wrap it in our safety loop and handle the Docker isolation and testing. 

Included: OpenHands (default), Aider, Claude Code, Forge, GitHub Copilot CLI, Terminus, Codex, Gemini, Qwen, OpenCode, KiloCode, mini-SWE-agent, Deep Agents.

Use `--agent <id>` to switch:

```bash
saif feat run --agent aider
```

See [Agents docs](./agents/README.md) for the full list and configuration options.

## Models

Simply set the API key — the factory auto-detects the provider and picks a sensible default model:

```bash
# → claude-sonnet-4-6
export ANTHROPIC_API_KEY=sk-ant-...

# → gpt-5.4
export OPENAI_API_KEY=sk-...

# → anthropic/claude-sonnet-4-6
export OPENROUTER_API_KEY=sk-or-...
```

Set a single model for the entire command:

```bash
saif feat run --model openai/o3
```

Target a specific agent while keeping defaults for the rest:

```bash
# Use o3 for the coding agent,
# keep defaults for other agents
saif feat run --model coder=openai/o3

# Cheap model for PR summaries,
# strong model for everything else
saif feat run --model anthropic/claude-sonnet-4-6,pr-summarizer=openai/gpt-4o-mini
```

See [Models](./models.md) for the full reference and available agents.

## Sandbox profiles: Configure coding containers

The AI agent is placed inside a container with Node.js + pnpm + Python (default profile).

You can pick and switch between language and package manager combinations using **sandbox profiles**.

You don't need to build anything. The factory ships pre-built coder and stage images for Node, Python, Go, and Rust.

Use `--profile` CLI option:

```bash
saif feat run --profile python-uv
```

[See all available profiles and step-by-step usage →](./sandbox-profiles.md)

## Test profiles: Configure testing containers

Tests run in an isolated container, separate from the sandbox.

You can easily configure in which language + framework to run your tests in with **test profiles**.

Use `--test-profile` CLI option:

```bash
pnpm agents feat:test --test-profile python-playwright
```

| Profile                 | Language + framework    |
| ----------------------- | ----------------------- |
| `node-vitest` (default) | TypeScript + Vitest     |
| `node-playwright`       | TypeScript + Playwright |
| `python-pytest`         | Python + pytest         |
| `python-playwright`     | Python + Playwright     |
| `go-gotest`             | Go + gotest             |
| `go-playwright`         | Go + Playwright         |
| `rust-rusttest`         | Rust + cargo test       |
| `rust-playwright`       | Rust + Playwright       |

See [Test profiles →](./test-profiles.md) for step-by-step usage.

## Connect to any repository

SAIF natively integrates with your source control. You can configure it to automatically open a PR or push to a remote branch when the tests finally pass.

Use `--push origin --pr` when running the agent:

```bash
saif feat run --push origin --pr
```

Included integrations: Github, Gitlab, Gitea, Bitbucket, and Azure Repos.

See [Source control docs](./source-control.md) for details and configuration.

## Security & Isolation

SAIF runs agents in a zero-trust, sandboxed environment. Docker isolation, hidden tests, Cedar policies, and prompt-injection defenses ensure the agent cannot cheat, reward-hack, or break out.

See [Security & Isolation](./security.md) for the full architecture.

## Access control with Cedar

The coding agents' have restricted filesystem and network access.

This is controlled by [Cedar](https://www.cedarpolicy.com/) policies, enforced by [Leash](https://github.com/strongdm/leash).

By default, the coding agents' permissions are:

- Filesystem:
  - Read and write anywhere in the workspace.
  - Except `saif/` (reward-hacking prevention) and `.git/` (sandbox-escape prevention).
- Network:
  - Unrestricted.

Override with `--cedar` to supply your own Cedar policy:

```bash
saif feat run --cedar ./my-policy.cedar
```

[See the full default policy and customization guide here](./cedar-access-control.md).

## Configure spec generation

The factory uses [Shotgun](https://app.shotgun.sh/) to turn your feature proposal into a full technical spec before any coding agent runs. Write one paragraph - get back `plan.md`, `specification.md`, `research.md`, and `tasks.md`, all grounded in your existing codebase patterns.

Just like other parts of `safe-ai-factory`, this step is swappable.

Use `--designer` to switch:

```bash
# Default:
saif feat design

# Explicit:
saif feat design --designer shotgun
```

| Designer          | Switch with          |
| ----------------- | -------------------- |
| Shotgun (default) | `--designer shotgun` |

[See available designers and step-by-step usage →](./designers/README.md)

_NOTE: Currently Shotgun is the only supported option. If you want to add your tool, [write an issue](https://github.com/JuroOravec/safe-ai-factory/issues)_

## Codebase indexing

By default the factory uses [Shotgun](https://app.shotgun.sh/) to index your codebase before generating specs.

The indexer gives the Architect Agent accurate knowledge of your existing patterns, so it writes specs that reference real files and conventions, not guesses.

Use `--indexer` to switch or disable:

```bash
# Index is built automatically during init:
saif init

# Use during spec generation:
saif feat design --indexer shotgun

# Disable:
saif feat design --indexer none
```

| Indexer           | Switch with         |
| ----------------- | ------------------- |
| Shotgun (default) | `--indexer shotgun` |

[See all available indexers and step-by-step usage here](./indexer/README.md).

_NOTE: Currently Shotgun is the only supported option. If you want to add your tool, [write an issue](https://github.com/JuroOravec/safe-ai-factory/issues)_
