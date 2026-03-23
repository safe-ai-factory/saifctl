# SWF Component C: OpenHands Deep Dive

This document provides a deep dive into OpenHands, describing what it is, why we use it in the Software Factory, how to install it, and day-to-day usage. It also explores how its architecture compares to test-driven flow methodologies.

---

## 1. What is OpenHands?

Alternative to aider, claude code, open code, or other tools that allow you to interact with AI models
and allow them to write coode.

[OpenHands](https://github.com/OpenHands/OpenHands) (formerly OpenDevin) is an open-source platform for developing AI agents that interact with the world similarly to human developers. It is built to write code, execute command-line instructions, and browse the web autonomously.

Its primary agent architecture, **CodeAct**, utilizes a continuous reasoning-action loop powered by state-of-the-art LLMs (like Claude 3.5 Sonnet). The agent observes the environment—reading bash output, inspecting file contents, and evaluating browser state—and takes actions such as running arbitrary shell commands, executing Python code, and editing files.

---

## 2. Why We Use It (Architecture & Benefits)

In the context of the Software Factory, we use OpenHands as the "execution engine" (the Coder Agent) because of its momentum, proven performance, and strong architectural boundaries:

1. **State-of-the-Art Performance:** CodeAct 2.1 resolves ~53% of SWE-Bench Verified out of the box. Instead of building a coder agent from scratch, we get world-class autonomous problem-solving capabilities for free.
2. **Clear Architecture Boundaries:** OpenHands strictly separates the Agent Server (the LLM reasoning brain) from the Runtime Workspace (the execution sandbox). This allows us to plug in our own isolated environments — we run OpenHands inside a Leash container with Cedar policies forbidding writes to `saifac/`.
3. **Pluggable & Extensible:** OpenHands provides a robust Python SDK and a CLI. It allows developers to define custom agents by restricting tools, changing system prompts, or creating multi-agent handoffs.
4. **Stateless by Default:** The architecture utilizes immutable Pydantic models with the conversation state being the only mutable entity. This deterministic execution makes it perfect for our automated, non-interactive convergence loop.

---

## 3. Step-by-Step Setup Guide

For the Software Factory and local development, you can run OpenHands in either its interactive CLI mode or "headless" mode for automation.

### Prerequisites

- **Python:** Version 3.12+
- **Docker Desktop:** Installed and running (ensure "Allow the default Docker socket to be used" is enabled in Advanced Settings for local testing). Windows requires WSL 2 integration.
- **API Keys:** An active API key for your LLM of choice (e.g., Anthropic or OpenAI).

### Option A: Quick Installation via CLI (Recommended for Day-to-Day)

The easiest way to install the OpenHands CLI is using `uv`:

```bash
# Install OpenHands globally using uv
uv tool install openhands --python 3.12
```

_(Alternatively, you can use the standalone installer: `curl -fsSL https://install.openhands.dev/install.sh | sh`)_

### Option B: Headless Setup for Orchestration (Software Factory)

When integrating OpenHands into the Software Factory loop, we run it headlessly via the CLI. By default (Leash enabled), OpenHands runs inside the Leash coder container; use `--dangerous-debug` to run it on the host (Python on host). Docker-based deployment is also available for alternative setups.

**Via Docker:**

```bash
export SAIFAC_WORKSPACE_BASE=$(pwd)
export LLM_MODEL="anthropic/claude-3-5-sonnet-20241022"
export LLM_API_KEY="your-api-key-here"
# Optional: export LLM_PROVIDER="anthropic"  # for opencode and similar agents when LLM_MODEL is not provider/model format
# Optional: export LLM_BASE_URL="https://openrouter.ai/api/v1"  # for custom endpoints

docker run -it --pull=always \
  -e SANDBOX_USER_ID=$(id -u) \
  -e WORKSPACE_MOUNT_PATH=$SAIFAC_WORKSPACE_BASE \
  -e LLM_API_KEY=$LLM_API_KEY \
  -e LLM_MODEL=$LLM_MODEL \
  ${LLM_PROVIDER:+-e LLM_PROVIDER=$LLM_PROVIDER} \
  ${LLM_BASE_URL:+-e LLM_BASE_URL=$LLM_BASE_URL} \
  -e LOG_ALL_EVENTS=true \
  -v $SAIFAC_WORKSPACE_BASE:/opt/SAIFAC_WORKSPACE_BASE \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ~/.openhands-state:/.openhands-state \
  --add-host host.docker.internal:host-gateway \
  docker.all-hands.dev/all-hands-ai/openhands:0.34 \
  python -m openhands.core.main -t "Implement plan.md"
```

_(Note: In the actual Factory loop, when Leash is enabled we run the Leash CLI with `--image saifac-coder-node-pnpm-python:latest --volume <sandbox>:/workspace --policy policies/default.cedar ... /saifac/coder-start.sh`. Leash wraps OpenHands in a sandboxed Docker container with Cedar policy enforcement. Use `--dangerous-debug` to run OpenHands directly on the host.)_

---

## 4. Day-to-Day Usage

Post-installation, developers can use the OpenHands CLI for everyday tasks. The CLI persists your configuration (LLM keys, agent settings, MCP servers) in `~/.openhands/`.

### Interactive Terminal Mode

Start an interactive terminal session where you can chat with the agent and assign it tasks:

```bash
openhands
```

### Headless Execution

For scripting, CI/CD, or automated factory loops, run a task headlessly:

```bash
openhands --headless -t "Refactor the database schema according to plan.md"
```

### Approval Modes (Security)

By default, OpenHands requires manual approval before executing bash commands. You can override this:

- `--always-approve` or `--yolo`: Auto-approves all actions (ideal for isolated sandboxes).
- `--llm-approve`: Uses an LLM to analyze proposed actions for safety before execution.

---

## 5. Ralph Wiggum loop - ask again until completion

[Ralph Wiggum](https://ralph-wiggum.ai/) is not an internal OpenHands agent class—it is a **stateless agentic coding loop** methodology.

The Ralph Wiggum approach solves "context window rot" by refusing to let an agent run indefinitely. Instead, it:

1. Reads the spec.
2. Does _one_ task.
3. Completely terminates the agent and wipes the context.
4. Starts a brand new agent with fresh context for the next task.

OpenHands pairs well with Ralph Wiggum because OpenHands has a headless SDK and CLI. You can effortlessly spin up a fresh OpenHands CodeAct instance for each iteration of a Ralph Wiggum loop.

---

## 6. TDFlow vs. OpenHands

**TDFlow** is a research pattern (Proposer → Test Runner → Debugger → Reviser) that achieved strong results on SWE-Bench by focusing entirely on _test resolution_.

They operate at different layers:

- **OpenHands** is the _Engine_ (the isolated Leash runtime, tool execution, base LLM integration).
- **TDFlow** is an _Orchestration Pattern_ you build _on top of_ an engine.

**Reference:** [TDFlow: Agentic Workflows for Test Driven Development](https://arxiv.org/abs/2510.23761)

### Should We Build a Custom TDFlow?

Given OpenHands' momentum (CodeAct 2.1 resolves ~53% of SWE-Bench Verified out of the box), we recommend **not** building a custom TDFlow team on day one.

#### Phase 1: Use OpenHands + CodeAct (Ralph Wiggum Style)

Instead of building a Proposer/Debugger/Reviser state machine, use OpenHands' CodeAct agent inside the Orchestrator loop:

1. Start CodeAct with `plan.md` and the task: _"Implement this plan."_
2. CodeAct finishes and shuts down.
3. The Orchestrator runs the black-box tests (Staging container & Test Runner).
4. If tests fail, the Orchestrator starts a **brand new** CodeAct agent with: _"The tests failed with this stderr output. Fix the code."_

This gives the stateless, fresh-context benefits of Ralph Wiggum while leveraging CodeAct as-is.

#### Phase 2: Gradual Multi-Agent (If Needed)

If the single CodeAct agent struggles when debugging complex test failures, we can use the OpenHands Python SDK to implement the TDFlow pattern. For example, define two custom agents:

- `ProposerAgent` (writes the initial patch)
- `DebuggerAgent` (focuses on test errors and writes fixes)

---

## 8. Summary

- **Do not build custom agents initially.**
- **Leverage CodeAct:** OpenHands' momentum is focused on making CodeAct a strong monolithic coder.
- **Black-Box Coder:** Treat OpenHands as an autonomous coder in our architecture. Feed it specs, grade it with our Test Runner, and simply restart it with fresh context when it fails.
