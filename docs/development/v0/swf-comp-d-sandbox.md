# Software Factory Component D: The Execution Sandbox

## What is the Execution Sandbox?

The **Execution Sandbox** is the secure, isolated environment where the Coder Agent writes code, installs dependencies, and runs tests during the Convergence Loop.

Because the Coder Agent operates autonomously—often running 50+ iterations of trial-and-error without human supervision—it is highly prone to making destructive mistakes (e.g., deleting the workspace, running a bad database migration) or engaging in "Reward Hacking" (cheating the tests). The Sandbox provides the physical and policy-based constraints to prevent this.

## The Core Challenge: Reward Hacking

If an LLM is told "make this test pass," its easiest path is often to cheat.

- If a test asserts `expect(response).toBe("Success")`, the LLM might just hardcode `return "Success"` instead of building the required database connection.
- If the LLM has access to the test file itself, it might simply rewrite the test to `expect(true).toBe(true)`.

To build a true Software Factory, the validation engine must act as a **perfect black box**.

## Why Same-Language & Same-Machine Testing Fails

### Vitest/Jest: The Shared-Language Problem

If the test harness (Vitest) and the production code (TypeScript) run in the same memory space and language runtime, the agent has infinite ways to cheat.

- **The Hack:** The agent can write `vi.mock('fs')` or `Object.defineProperty(global, 'fetch', ...)` inside the _production_ code. When the test runner executes the code, the production code hijacks the test runner's environment, forces the assertion to pass, and the agent gets a "green" build without actually solving the problem.
- **The Lesson:** White-box unit testing is fundamentally unsafe for autonomous agent loops.

### CLI / Same-Machine: The Shared-OS Problem

Even if we use a CLI tool to test the app from the "outside," if the test runner and the agent's code share the same OS environment, the agent can still cheat.

- **The Hack:** The agent could modify bash aliases, rewrite the test binary, hijack `stdout` at the OS level, or modify system commands to always return the exact string the test expects.
- **The Lesson:** Process-level isolation is not enough if the agent has root or write access to the environment where the test is executed.

### The Only Real Safe Way: The Serialization Layer & The Outside Test Runner

To achieve a **perfect black box**, we must enforce an **air gap** between the agent's execution environment and the test runner's execution environment.

- **Serialization Layer:** The only way in or out of the agent's container is over a strict serialization protocol: **HTTP, gRPC, or WebDriver (HTML/DOM)**.
- **Agent Cannot Cheat:** The agent cannot pass memory references, mock objects, or OS-level overrides across a network boundary. It is forced to serialize real data (e.g., JSON, HTML) and send it over a port.
- **Test Runner Runs Outside:** The test runner (e.g., Playwright or Postman) runs on the host machine or in a _separate_ secure container. It sends HTTP requests or browser clicks over the network to the agent's container. The agent's code processes the request and returns a response. The test runner evaluates the response.
- **Why This Is Un-Hackable:** The agent cannot use `vi.mock()` because the test runner is in a different Node.js process on a different machine. It cannot rewrite the test files because they do not exist in its container. It cannot hijack the OS because the test runner runs on a different OS. The _only_ way to pass is to actually build a server that binds to the port, accepts the HTTP request, processes the logic, and returns the correct JSON or HTML.

This architecture—**Network-Isolated Black-Box Testing**—is the blueprint used by frontier AI labs for SWE-bench evaluation and by StrongDM's Software Factory.

### Test Runner Interface: HTTP Wrappers & Sidecars

The serialization layer must bridge the Test Runner container and the Staging container (where the agent's code runs).

**Testing Web Apps & Complex Systems (HTTP)**
For web applications, the Test Runner simply sends HTTP requests to the web server the agent built. The web server serializes the response as JSON or HTML. The Test Runner needs no special privileges—just network access to the Staging container.

**Testing CLI Tools: The Sidecar / HTTP Wrapper Pattern**
Historically, benchmarking tools used `docker exec` from the host or a test runner container to test CLI applications. However, **mounting the Docker socket into the Test Runner container is a critical security vulnerability**, as it grants the Test Runner (and potentially the agent, if it hacks the Test Runner) root-level control over the host daemon.

Instead, we use a **Sidecar Pattern (HTTP Wrapper)**:

1. The Orchestrator injects a lightweight HTTP server (the "Wrapper") into the Staging container alongside the agent's compiled CLI tool.
2. This Wrapper listens on a port (e.g., 8080) and accepts JSON payloads containing the command to run: `{ "cmd": "my-cli --help" }`.
3. The Wrapper executes the CLI locally within the Staging container using `child_process.exec` and returns the `stdout`, `stderr`, and `exit_code` as an HTTP response.
4. The Test Runner container sends an HTTP POST request to the Staging container's Wrapper.

**Why It's Safe:** The Test Runner never needs the Docker socket. The code inside the Staging container has no access to the Test Runner. The HTTP protocol serializes the output. If the agent hardcodes the output for one command, the hidden holdout tests will catch it.

**Our Design:** We support both Web Apps and CLI testing entirely over standard HTTP networks, eliminating the need for privileged Docker access during the Mutual Verification loop.

## How We Prevent Test Hacking & Ensure Isolation

We implement three layers of defense to ensure the agent actually writes working software rather than faking responses.

### 1. Stateful Scenarios & The Digital Twin

A simple HTTP test is easy to fake. To prevent the agent from hardcoding responses, tests must be **Stateful and Multi-Step**.

- **Scenario Testing:** A test must prove state mutation. (e.g., Request 1 creates a user $\rightarrow$ Request 2 verifies the user exists $\rightarrow$ Request 3 deletes the user). It is mathematically harder for the LLM to write a complex in-memory state machine to fake all these responses than it is to just use the actual database connection.
- **The Digital Twin:** We do not test against mocks. The sandbox spins up "Digital Twins"—ephemeral, behavioral clones of real databases (PostgreSQL, Redis) or third-party APIs. The agent is forced to interact with real infrastructure.

### 2. Strict File System Permissions (Leash + Patch Filter)

The agent must **never** have write access to the test files.

- **[Leash by StrongDM](https://github.com/strongdm/leash)** wraps OpenHands in a Docker container with Cedar policy. Our `leash-policy.cedar` forbids writes to `/workspace/openspec/`, so Leash blocks such attempts in real time.
- **Patch filtering (belt-and-suspenders):** After the agent finishes, `extractPatch()` in `sandbox.ts` captures `git diff`. Any hunks touching `openspec/` are stripped before the patch is applied to the host. Dropped paths are logged. See [swf-comp-d-leash.md](./swf-comp-d-leash.md) for details.

### 3. The Holdout Set (Hidden Tests)

Borrowing from machine learning training principles, we use "Mutual Verification" (as seen in frameworks like SWE-Playground).

- **Public Tests:** The agent is given a subset of tests it can read to understand the goal and debug its code.
- **Hidden Tests:** The Orchestrator keeps a "Holdout Set" of tests completely hidden from the agent. Before the agent runs, _all_ `hidden/` directories under `saifac/features/` (for every feature, not just the current one) are removed from the code copy. The agent therefore never sees holdout tests from any feature.
- **Final Verification:** When the agent claims the public tests are passing, the Orchestrator steps in. It takes _only_ the agent's source code patch, applies it to a clean checkout of the `main` branch, and runs the hidden tests outside of the agent's container. If the agent hardcoded a fake response to pass the public test, it will instantly fail the hidden test.

---

## Infrastructure Implementation

To achieve this isolation, the Sandbox relies on ephemeral containerization and a **three-container architecture**:

1. **Three-Container Architecture:**
   - **Coder container** (Leash; `Dockerfile.coder`): Runs OpenHands, secured by Leash. The agent writes code in a sandbox mounted at `/workspace`. Cedar policy forbids writes to `openspec/`. Use `--dangerous-debug` to run OpenHands on the host instead.
   - **Staging container:** (`Dockerfile.staging`) Git changes from the coder are copied into a plain Node.js container. Runs the application the Coder Agent built — a web server (port 3000) or a CLI wrapped in a Sidecar. Test files and the test runner do _not_ exist here.
   - **Test Runner container:** (`Dockerfile.test`) Runs vitest against the staging container. Communicates strictly via **HTTP/browser** (for web apps) or via an **HTTP Wrapper / Sidecar** (for CLI tools), and evaluates the serialized response.
     - _Security Note:_ We do **not** use `docker exec` from the Test Runner to run CLI commands, as that would require mounting the highly privileged `/var/run/docker.sock` into the Test Runner. The Sidecar pattern preserves the air gap securely.
2. **Docker / WASM Isolation:** Every tests run, a fresh staging container is spun up. Previous failures never pollute the context of the next attempt.
3. **State Reset:** If the agent crashes the server or corrupts the local database during iteration #14, iteration #15 spins up a completely clean staging container.
4. **Telemetry & Network Blocking:** The sandbox intercepts every network request. If the agent tries to `curl` a malicious external IP or download an unapproved npm package, the connection is blocked, ensuring supply chain security even during autonomous development.

---

## Open-Source Runtimes: OpenHands & TDFlow

We can leverage existing open-source evaluation infrastructure rather than building the sandbox from scratch. Here is how **OpenHands** and **TDFlow** fit into our design, and what we must customize.

### Integrating Leash with OpenHands

**Our integration:** We use **Leash as a CLI wrapper** around a custom coder image (`saifac-coder-node-pnpm-python:latest` or profile-specific) that includes OpenHands. Instead of running `openhands ...` directly on the host, the Orchestrator runs:

```bash
npx leash --no-interactive --image saifac-coder-node-pnpm-python:latest \
  --volume /path/to/sandbox:/workspace --policy leash-policy.cedar \
  openhands --headless --always-approve -t "Implement plan.md"
```

Leash manages its own containers; we never pull StrongDM images. Use `--dangerous-debug` to skip Leash and run OpenHands directly on the host (no container during the agent phase). See [swf-comp-d-leash.md](./swf-comp-d-leash.md) for full details.

**Alternative (Remote Sandbox):** OpenHands also supports `RUNTIME=remote` with `SANDBOX_REMOTE_RUNTIME_API_URL` for pluggable runtimes. That model would require a Leash-compatible Sandbox API; our current implementation uses `npx leash --image saifac-coder-node-pnpm-python:latest ... openhands ...`. See [Runtime Overview](https://docs.all-hands.dev/usage/runtimes/overview) for reference.

### Host-to-Docker Code Flow (Local vs Remote)

**Our Factory:** We use a **pure file copy** approach. The Orchestrator uses `rsync` (honoring `.gitignore`) to copy the repo to a disposable `/tmp/saifac/{feature}-{runId}/code` directory. After rsync, _all_ `hidden/` directories under `saifac/features/` are recursively removed from the code copy so the agent cannot see holdout tests from any feature. This guarantees the agent cannot corrupt the host's `.git` or files, and cannot read hidden tests. OpenHands uses this directory as its workspace. By default (Leash enabled), OpenHands runs inside the Leash coder container; with `--dangerous-debug` it runs on the host.

**OpenHands' traditional flow (for reference):**

- **Environment Variable:** `SANDBOX_VOLUMES="/Users/you/my-project:/workspace"` — the orchestrator mounts the host folder into the agent's container.
- **Benchmark Mode:** For strict isolation (e.g., SWE-Bench), the harness clones the repo _inside_ the container instead of mounting the host, preventing accidental damage to the host filesystem.

### Final Artifact: The Git Diff

The output of these runtimes is not a fully committed repo but a **patch (`.diff` file)**.

- When the agent finishes, the orchestrator runs `git diff HEAD` against the base commit _inside_ the sandbox.
- **Patch filtering:** Before the diff is saved or applied, any hunks that touch the `openspec/` directory (configurable via `--openspec-dir`) are stripped. This prevents reward hacking — the agent cannot modify test specs, constraints, or holdout definitions to "pass" tests. Dropped paths are logged as a warning.
- The filtered patch is written to `patch.diff`; the sandbox is reset for the next iteration.
- **Our Factory:** The orchestrator applies the filtered patch to our real repository and opens a Pull Request.

### Evaluation Harness: Prescriptive vs Bring Your Own

**SWE-Bench / OpenHands Evaluation Harness (out-of-the-box):**

- **Prescriptive:** The harness is built for specific Python repos (Django, Pandas). It hard-codes which `pytest` or `tox` commands to run.
- **Holdout Tests:** The harness has the historical "gold patch" and the hidden test file. It hides the test from the agent during coding, then injects it to grade the agent's patch.
- **Limitation:** Cannot directly test arbitrary TypeScript/Node or custom test runners without a custom evaluation script.

**Custom Pipelines (Commit0, OpenHands Benchmarks):**

- OpenHands supports custom evaluation pipelines where you supply your own repo, tests, and build commands.
- We must write a custom evaluation script that tells the harness _how_ to run our specific test runner (e.g., Playwright, Newman, or HTTP requests to the Sidecar).

### TDFlow vs OpenHands

**OpenHands** is a general-purpose agent platform: it can browse the web, read files, write code. We use it as the _Execution Sandbox_ and the _Coder Agent_.

**TDFlow** is a **workflow pattern** for test resolution, not a standalone runtime:

- It orchestrates a state machine: `Proposer -> TestRunner -> Debugger -> Reviser`.
- It still relies on a sandboxed test runner (often SWE-bench infrastructure) to execute tests and return `stderr` to the Debugger agent.
- We can implement the TDFlow pattern _on top of_ OpenHands (or our own Mastra workers) by wrapping the Coder Agent in the Proposer/Debugger/Reviser loop.

### Building Our Factory Floor

To realize the workflow we designed, we do not merely install SWE-Bench and click go. We:

1. Use **OpenHands** in headless mode as the Execution Sandbox and Coder Agent.
2. Write a **custom orchestrator script** that:
   - Copies the repo to a disposable sandbox via `rsync`; removes _all_ `hidden/` dirs under `saifac/features/` from the code copy before the agent runs, so holdout tests from every feature are physically absent from the agent's workspace.
   - Triggers OpenHands with the task (`plan.md` contents).
   - Extracts the `patch.diff` when OpenHands finishes.
   - Runs the hidden tests via the three-container Black-Box flow (Test Runner over HTTP to Staging container) against a clean checkout with the patch applied (Mutual Verification).
3. If all holdout tests pass, apply the patch to our repo and open a PR.
