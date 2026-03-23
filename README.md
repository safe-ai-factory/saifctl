# SAIFAC: Safety harness for autonomous AI agents

[![Website](https://img.shields.io/badge/Website-safeaifactory.com-blue)](https://safeaifactory.com)
[![license](https://img.shields.io/npm/l/safe-ai-factory)](https://github.com/JuroOravec/safe-ai-factory/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/safe-ai-factory)](https://www.npmjs.com/package/safe-ai-factory)
[![npm downloads](https://img.shields.io/npm/dm/safe-ai-factory)](https://www.npmjs.com/package/safe-ai-factory)
[![GitHub stars](https://img.shields.io/github/stars/JuroOravec/safe-ai-factory)](https://github.com/JuroOravec/safe-ai-factory)

**Spec-driven AI factory. Use with any agentic CLI. Language-agnostic. Safe by design.**

_Like [GasTown](https://github.com/steveyegge/gastown), but agents can't cheat, leak, wreak havoc._

Full feature preview at:

[![Visit safeaifactory.com](https://img.shields.io/badge/Visit_Website-safeaifactory.com-00CC66?style=for-the-badge)](https://safeaifactory.com)

> ⚠️ **Status: Alpha.** SAIFAC is under active development. See the [Roadmap](https://github.com/users/JuroOravec/projects/3) for what's coming next.
>
> _[**Sponsor this project**](https://github.com/sponsors/JuroOravec)_

---

## Stop Coding. Start Spec'ing.

**`safe-ai-factory` implements state-of-the-art (early 2026) architecture for Agentic engineering.**

**SAIFAC Guarantee:**

- **The AI builds _exactly_ what you asked for.**
  - The agent is locked in a loop and physically cannot stop until your new TDD tests pass.
- **The AI can't break previously-built features.**
  - All features built with SAIFAC are protected by tests. AI can't break or change them. Regressions are mechanically impossible.
- **The AI breaks _nothing_ on your machine.**
  - The agent runs in a zero-trust, sandboxed Docker environment. Your existing codebase is safe.

Read more on [Security & Isolation](./docs/security.md).

## The Gauntlet: Merge with Confidence

The AI agent is trapped in a rigorous convergence loop. Every time it writes code, it must survive three stages before opening a PR:

1. **The Gate:** Your linters, type-checkers, and other static analysis tools.
2. **The Reviewer:** Adversarial AI that scrutinizes the diff to ensure it matches the spec without taking shortcuts.
3. **Holdout Tests:** Hidden tests. Agent can't see them. Can't fake a pass.

You only get notified when the code emerges victorious.

## Batteries-Included

SAIFAC supports out of the box:

- All major LLM providers + OpenRouter + OpenAI-compatible APIs
- 14 Agentic CLI tools
- 4 Programming languages (Node.js, Python, Go, Rust)
- All major Git providers

## Deployment

SAIFAC runs as a CLI that spins up coding agents in ephemeral Docker containers on your machine. Self-hosted and Kubernetes (Helm) deployment support is underway.

<youtube video>

## Try it out now

**SAIFAC is currently in active development. The Docker isolation environment and VSCode extension are dropping in a few weeks.**

Star the repository to get notified of the Alpha drop, or [Join the Design Partner Waitlist](https://safeaifactory.com) to get early access.

### Step-by-step guide

See the [Step-by-step guide](docs/usage.md) for a detailed walkthrough of the workflow.

## VSCode extension

The SAIFAC VSCode extension provides a dedicated sidebar panel to manage your entire AI engineering workflow directly from your editor.

**What the extension does:**

- **Manage Features:** Visual tree view of your features. Create new features, or manage existing ones through GUI.
- **Design & Run:** One-click actions to generate specs (`saifac feat design`), start the coding swarm (`saifac feat run`), or drop into a debug container (`saifac feat debug`).
- **Track Runs:** A Kubernetes-style dashboard of all your agent runs. See status (success/failed), view run configs, and instantly resume failed runs or clear old ones.

## Requirements

- Node.js 22+
- Python 3.12+
- Docker
- Git
- LLM API key
- Linux or MacOS (Windows is not supported yet)

## A fully customizable factory

Every component of SAIFAC is fully modular. You can swap, customize, or disable to fit your team's needs:

- Want to use a different LLMs for coding and designing agents? Easy.
- Want to use your custom Playwright setup for testing? Done.
- Need to enforce strict filesystem rules? It's built in.

Dive into the details of what you can customize in the [Features guide](./docs/features.md).

## Reference

- [Usage](./docs/usage.md)
- [Configuration](./docs/config.md)
- [Agents](docs/agents/README.md)
- [Security & Isolation](./docs/security.md)
- [Access control with Cedar](./docs/leash-access-control.md)
- [Environments and Infrastructure](./docs/services.md)
- [Sandbox profiles](./docs/sandbox-profiles.md)
- [Test profiles](./docs/test-profiles.md)
- [Semantic reviewer](./docs/reviewer.md)
- [Spec designers](./docs/designers/README.md)
- [Codebase indexers](./docs/indexer/README.md)
- [Source control integrations](docs/source-control.md)
- [Commands](docs/commands/README.md)
- [Environment variable](docs/env-vars.md)

## Development

See our [Development guides](docs/development/)

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/JuroOravec/safe-ai-factory.git
```

## License

MIT
