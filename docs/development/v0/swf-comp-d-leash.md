# Software Factory Component D2: Leash by StrongDM

## What is Leash?

Provision safe Docker containers for AI agents. All network and filesystem
access is monitored and can be restricted via Cedar.

**[Leash](https://github.com/strongdm/leash)** is an open-source security framework built by StrongDM specifically designed to provide authorization, visibility, and control over autonomous AI agents.

While tools like Docker provide basic containerization (keeping the agent off your host filesystem), Leash acts as a **Policy Enforcement Engine**. It intercepts an agent's runtime activity in real-time—including file system access, network requests, and Model Context Protocol (MCP) tool usage—and evaluates them against fine-grained security policies.

## How It Works (Architecture)

Leash wraps the AI agent's execution environment. It uses **[Cedar](https://www.cedarpolicy.com/)** to define strict, readable rules about what the agent is allowed to do.

1. **Interception:** As the agent runs (e.g., executing a bash script, making an HTTP request, or
   modifying a file), Leash intercepts the underlying system calls or API requests.
2. **Evaluation:** Leash instantly evaluates the action against the active Cedar policies.
3. **Enforcement:** If the action is permitted, it executes normally. If the action is forbidden (e.g.,
   an agent trying to delete `/saifac/` or curl a crypto-mining IP), Leash instantly blocks the action
   and returns an error (like `HTTP 403 Forbidden` or a file permission error) back to the agent.
4. **Telemetry:** Every action, permitted or denied, is logged, giving developers and security teams
   perfect observability into the "black box" of the agent's thought process.

See Cedar rules available for Leash [here](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.
md).

## WHY We Are Using It

In an autonomous Software Factory, the Coder Agent is placed in a continuous looping environment (often
10 to 50 iterations) with no human supervision. This presents immense risks:

- **Reward Hacking:** The easiest way for an LLM to make a test pass is to rewrite the test itself.
  Leash physically prevents the agent from modifying holdout tests or the test runner infrastructure.
- **Supply Chain Security:** Agents run `npm install` blindly. If an agent hallucinates a package name
  or installs a compromised package, Leash's network policies can block malicious post-install scripts
  from phoning home to bad actors.
- **Runaway Cost & Destruction:** If an agent gets stuck in a loop deleting project files or spamming
  external APIs, Leash's boundaries ensure the damage is contained and instantly flagged.
- **MCP Governance:** As we add more tools to our agents via Model Context Protocol, Leash provides a
  centralized way to authorize which agent can use which tool.

## Usage

When Leash is enabled, the Orchestrator runs the **Leash CLI** (`@strongdm/leash`) with the same argv shape as below.

```bash
leash --no-interactive --verbose
      --image saifac-coder-node-pnpm-python:latest
      --volume /tmp/saifac/sandboxes/<feat>-<runId>/code:/workspace
      --policy policies/default.cedar
      --env LLM_MODEL=... --env LLM_API_KEY=... [--env LLM_PROVIDER=...] [--env LLM_BASE_URL=...] --env SAIFAC_WORKSPACE_BASE=/workspace
      /saifac/coder-start.sh
```

To try the same from a shell, use e.g. `pnpm exec leash …` or `npx --package @strongdm/leash leash …` from a directory where dependencies are installed.

Leash spawns two containers:

1. **Leash manager container** (`agents-leash`) — runs `leashd`, enforces Cedar policy, monitors activity, serves the Control UI at `http://localhost:18080`.
2. **Target container** (`agents`) — runs our custom `saifac-coder` image with OpenHands inside. Mounts `/workspace` (the sandbox copy).

Leash is a **CLI wrapper**. You do not pull or run any StrongDM Docker image yourself — Leash manages its own Docker containers when you invoke it.

## Current Integration Status

**Leash is enabled by default** for `saifac feat run` and `saifac run resume`. The integration is complete and working.

### Custom Coder Image

StrongDM's reference `public.ecr.aws/s5i7k8t3/strongdm/coder` image bundles several npm-based CLIs; **our published `saifac-coder-*` images do not use that base.** Each profile's `Dockerfile.coder` starts from an upstream image (Node, Python, golang, rust, Miniconda, etc.). Node-based agents (Claude Code, Codex, Gemini CLI, …) are installed at run time by their `agent-install.sh` via `npm install -g` when missing, or you can bake them into a custom `--coder-image`.

**Default image `saifac-coder-node-pnpm-python:latest`** includes Node 25, pnpm, Python 3, pipx, and uv (see `src/sandbox-profiles/node-pnpm-python/Dockerfile.coder`). **OpenHands** is installed by `agent-install.sh` when you use the openhands agent profile (not baked into the image).

**Build:** `pnpm docker build coder` (uses the sandbox profile's `Dockerfile.coder`; default: node-pnpm-python).
**Default:** Images are published to GHCR. Docker pulls them automatically when not present locally.

### Network enforcement

Leash enforces outbound connectivity using its MITM proxy and Cedar `NetworkConnect` rules (see [Leash Cedar design](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) — resources use `Host::"hostname"`). HTTPS clients inside the target container must trust the Leash CA (the harness configures this where needed so tools like `pnpm`/`curl` can reach allowed hosts). Tighten or relax allowlists by editing the active Cedar file (`--cedar`, default `src/orchestrator/policies/default.cedar`). For experiments, see `src/orchestrator/policies/deny-network.cedar`.

### What Leash Provides (Active)

| Layer                 | Mechanism                                                                      | Status |
| --------------------- | ------------------------------------------------------------------------------ | ------ |
| Container isolation   | OpenHands runs inside a Docker container; host repo is never touched           | Active |
| Filesystem monitoring | Leash logs file access; Cedar policy can forbid writes to `/workspace/saifac/` | Active |
| Network policy        | Cedar `NetworkConnect` + Leash proxy / kernel path                             | Active |
| Control UI            | `http://localhost:18080` — audit trail, telemetry                              | Active |

### What We Rely On

- **Pure file copy sandbox** — `rsync` copies the repo to `/tmp/saifac/sandboxes/.../code`; agent only sees that copy.
- **Cedar policy** — `src/orchestrator/policies/default.cedar` permits read/write in `/workspace`, forbids writes to `/workspace/saifac/`, and (by default) permits outbound `NetworkConnect` broadly; use a stricter policy when you want hostname allowlists.
- **Patch filtering** — any `saifac/` changes are dropped before the patch is applied to the host.

---

## Cedar Policy (Default)

We ship default policies under `src/orchestrator/policies/` (`default.cedar`, `deny-network.cedar`):

- **Read/write** — allowed anywhere in `/workspace`
- **Forbid** — writes to `/workspace/saifac/`
- **Network** — default policy permits broad outbound access; override with `--cedar` for hostname-scoped rules

Override with `--cedar <path>` when running `saifac feat run` or `saifac run resume`.

---

## CLI Options

| Option                | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `--dangerous-debug`   | Skip Leash; run OpenHands directly on the host (filesystem sandbox only). Use for debugging.             |
| `--cedar <path>`      | Custom Cedar policy file (default: `src/orchestrator/policies/default.cedar`).                        |
| `--coder-image <tag>` | Custom target container image (default: from `--profile`, e.g. `saifac-coder-node-pnpm-python:latest`). |

---

## Installation & Day-to-Day

### Leash

Leash is an npm **dependency** of safe-ai-factory (`@strongdm/leash`). The orchestrator resolves `bin/leash.js` from that package and runs it with **`node`**, so it works when safe-ai-factory is installed as a dependency and when `cwd` is the sandbox. Optional override: **`SAIFAC_LEASH_BIN`**. Prebuilt native pieces ship for darwin/linux amd64/arm64.

### OpenHands

OpenHands must be on PATH for the target container. It is pre-installed in `saifac-coder`. For `--dangerous-debug` mode, install on the host:

```bash
uv tool install openhands --python 3.12
```

### First Run

1. **Test Runner image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/saifac-test-node-vitest:latest`).
2. **Coder image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/saifac-coder-node-pnpm-python:latest` for the default sandbox profile).

---

## Telemetry & Debugging

- **Control UI:** `http://localhost:18080` when Leash is running.
- **Target logs:** `docker logs -f agents`
- **Leash logs:** `docker logs -f agents-leash`
- **Stop:** `docker rm -f agents agents-leash`

---

## Reference: Cedar Rules

See [Leash Cedar design](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) for action types (`ReadFile`, `WriteFile`, `NetworkConnect`, `ProcessExec`, etc.) and entity types (`Directory::"/path"`, `Host::"example.com"`, etc.).
