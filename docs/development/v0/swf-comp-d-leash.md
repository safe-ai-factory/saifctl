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
   an agent trying to delete `/openspec/` or curl a crypto-mining IP), Leash instantly blocks the action
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

When Leash is enabled, the Orchestrator runs:

```bash
npx leash --no-interactive --verbose
      --image factory-coder-node-pnpm-python:latest
      --volume /tmp/factory-sandbox/<feat>-<runId>/code:/workspace
      --policy leash-policy.cedar
      --agent-env LLM_MODEL=... --agent-env LLM_API_KEY=... [-e LLM_PROVIDER=...] [-e LLM_BASE_URL=...] --agent-env WORKSPACE_BASE=/workspace
      --agent-env LEASH_E2E=1 --agent-env LEASH_BOOTSTRAP_SKIP_ENFORCE=1
      openhands --headless --always-approve --override-with-envs --json -t "..."
```

Leash spawns two containers:

1. **Leash manager container** (`agents-leash`) — runs `leashd`, enforces Cedar policy, monitors activity, serves the Control UI at `http://localhost:18080`.
2. **Target container** (`agents`) — runs our custom `factory-coder` image with OpenHands inside. Mounts `/workspace` (the sandbox copy).

Leash is a **CLI wrapper**. You do not pull or run any StrongDM Docker image yourself — Leash manages its own Docker containers when you invoke it.

## Current Integration Status

**Leash is enabled by default** for `saif feat run` and `saif run resume`. The integration is complete and working.

### Custom Coder Image

Leash's default `coder` image includes `claude-code`, `codex`, `gemini-cli` — but not OpenHands. We provide **`factory-coder-node-pnpm-python:latest`** (and profile-specific variants), built from the sandbox profile's `Dockerfile.coder`. It extends `factory-coder-base` and adds:

- Python 3, uv, OpenHands
- Git
- A symlink from `/root/.local/bin/openhands` to `/usr/local/bin/openhands` so the binary is reachable in any shell context

**Build:** `pnpm docker build coder` (uses the sandbox profile's `Dockerfile.coder`; default: node-pnpm-python).
**Default:** Images are published to GHCR. Docker pulls them automatically when not present locally.

### Network Enforcement: Disabled

Leash's full network enforcement uses a MITM proxy that intercepts all outbound HTTPS. Clients (Python requests, git, npm) would need to route through it via `HTTP_PROXY`/`HTTPS_PROXY` and trust Leash's CA cert — OpenHands, LiteLLM, and git don't automatically pick this up. Rather than configuring each client, we **skip network enforcement** by setting:

- `LEASH_E2E=1`
- `LEASH_BOOTSTRAP_SKIP_ENFORCE=1`

(Both required; see `leashd/runtime.go` `skipEnforcement()`.) With these set, leashd skips iptables redirect, the MITM proxy, and LSM attachment. Network goes straight through. **Our security boundary is the filesystem**, not the network — see below.

### What Leash Provides (Active)

| Layer                 | Mechanism                                                                        | Status |
| --------------------- | -------------------------------------------------------------------------------- | ------ |
| Container isolation   | OpenHands runs inside a Docker container; host repo is never touched             | Active |
| Filesystem monitoring | Leash logs file access; Cedar policy can forbid writes to `/workspace/openspec/` | Active |
| Control UI            | `http://localhost:18080` — audit trail, telemetry                                | Active |

### What We Rely On

- **Pure file copy sandbox** — `rsync` copies the repo to `/tmp/factory-sandbox/.../code`; agent only sees that copy.
- **Cedar policy** — `leash-policy.cedar` permits read/write in `/workspace`, explicitly forbids writes to `/workspace/openspec/`.
- **Patch filtering** — any `openspec/` changes are dropped before the patch is applied to the host.

---

## Cedar Policy (Default)

We ship `leash-policy.cedar` in `src/orchestrator/`:

- **Read/write** — allowed anywhere in `/workspace`
- **Forbid** — writes to `/workspace/openspec/`
- **Network** — permit all (network enforcement is skipped; see above)

Override with `--cedar <path>` when running `saif feat run` or `saif run resume`.

---

## CLI Options

| Option                | Purpose                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `--dangerous-debug`   | Skip Leash; run OpenHands directly on the host (filesystem sandbox only). Use for debugging.             |
| `--cedar <path>`      | Custom Cedar policy file (default: `src/orchestrator/leash-policy.cedar`).                               |
| `--coder-image <tag>` | Custom target container image (default: from `--profile`, e.g. `factory-coder-node-pnpm-python:latest`). |

---

## Installation & Day-to-Day

### Leash

Leash is pulled in as an npm dependency (`@strongdm/leash`). The Orchestrator invokes `npx leash ...` — no global install required. The `leash` binary is bundled for darwin/linux amd64/arm64.

### OpenHands

OpenHands must be on PATH for the target container. It is pre-installed in `factory-coder`. For `--dangerous-debug` mode, install on the host:

```bash
uv tool install openhands --python 3.12
```

### First Run

1. **Test Runner image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/factory-test-node-vitest:latest`).
2. **Coder image** — pulled from GHCR when not present locally (e.g. `ghcr.io/JuroOravec/safe-ai-factory/factory-coder:latest`).

---

## Telemetry & Debugging

- **Control UI:** `http://localhost:18080` when Leash is running.
- **Target logs:** `docker logs -f agents`
- **Leash logs:** `docker logs -f agents-leash`
- **Stop:** `docker rm -f agents agents-leash`

---

## Reference: Cedar Rules

See [Leash Cedar design](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) for action types (`ReadFile`, `WriteFile`, `NetworkConnect`, `ProcessExec`, etc.) and entity types (`Directory::"/path"`, `Host::"example.com"`, etc.).
