# Software Factory Component D3: Cedar Policy Language

## What is Cedar?

Spec to define what resources (filesystem, network, etc) the AI agent is permitted/denied from accessing.

**[Cedar](https://www.cedarpolicy.com/)** is an open-source policy language and evaluation engine designed for defining and enforcing fine-grained access control permissions.

In the context of our Software Factory, **Leash** (Component D2) acts as the _enforcement mechanism_ (the bouncer), but **Cedar** acts as the _rulebook_ (the guest list).

When the Coder Agent attempts an action inside the Sandbox, Leash pauses the action, translates it into a Cedar request, and asks the Cedar engine: _"Is this Principal allowed to perform this Action on this Resource?"_ The engine replies with either `Allow` or `Deny`.

See Cedar rules available for Leash [here](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md).

## WHY We Are Using It

Instead of hardcoding security rules in TypeScript or using complex JSON configurations, Cedar provides several massive advantages for agentic workflows:

1. **Default-Deny Architecture:** In Cedar, if an action is not explicitly permitted by a `permit` statement, it is automatically denied. This is the only safe way to run autonomous agents.
2. **Formal Verification:** Cedar is mathematically proven to be safe. Automated reasoning tools can analyze your policies to guarantee that they don't contain logical contradictions (e.g., accidentally allowing an agent to delete the whole repo).
3. **High Performance:** Cedar evaluates policies in microseconds, meaning Leash can intercept thousands of file writes or network requests during a 50-iteration convergence loop without slowing down the agent.
4. **Readability:** Security rules for AI must be auditable by human engineers. Cedar policies read almost like plain English.

---

## What is Configurable via Cedar?

Cedar policies are built around three core concepts: **Principal** (Who), **Action** (What they are doing), and **Resource** (What they are doing it to).

When using **Leash** to wrap our Coder Agent, author policies against the [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) (Leash transpiles Cedar to eBPF + HTTP proxy rules; not every generic Cedar tutorial applies).

### 1. File System Operations

- **Actions:** `Action::"FileOpen"`, `Action::"FileOpenReadOnly"`, `Action::"FileOpenReadWrite"` (Leash maps these to file open / read-only / read-write semantics).
- **Resources:** `File::"/path"` or directories `Dir::"/path/"` (trailing `/` means directory coverage; the transpiler normalizes paths).
- **Configuration Power:** You can permit read-only opens broadly and `FileOpenReadWrite` only under specific `Dir::` trees, with `forbid` on sensitive subtrees.

### 2. Network Traffic

- **Actions:** `Action::"NetworkConnect"`
- **Resources:** `Host::"hostname"` or `Host::"host:port"`; wildcard apex `Host::"*.example.com"`; allow-all bootstrap uses `Host::"*"`. (Leash v1: hostname enforcement goes through the MITM proxy; the kernel path is IP-oriented — see upstream docs.)
- **Configuration Power:** Allowlist registries and LLM API hosts, or use `Host::"*" ` when the filesystem sandbox is the main boundary.

### 3. Process Execution

- **Actions:** `Action::"ProcessExec"`
- **Resources:** `Dir::"/path/"` or `File::"/path"` to executables.
- **Configuration Power:** Our default permits `ProcessExec` under `Dir::"/"` so shells and tools in `/usr/bin` work.

### 4. Tool Usage (MCP - Model Context Protocol)

- **Actions:** `Action::"McpCall"`
- **Resources:** `MCP::Server::"host"`, `MCP::Tool::"tool-name"` (see Leash docs; v1 deny enforcement details differ from permits).
- **Configuration Power:** Restrict which MCP servers/tools the agent may call when Leash observes MCP traffic.

---

## How it is Source Controlled & Passed to Leash

Cedar policies are just plain text files, typically saved with a `.cedar` extension.

### Source Control

Because they are plain text, **Cedar policies must be checked into Git** right alongside your Orchestrator scripts. This ensures that your security posture is version-controlled and evolves with your architecture.

```text
/my-monorepo/
  |- docs/
      |- development/
          |- v0/
  |- src/
      |- orchestrator/
          |- policies/
          |   |- default.cedar
          |- run-factory.ts
  |- policies/
      |- agent-sandbox.cedar      <-- Source-controlled policy file
```

### Passing Policies to Leash

We use the Leash CLI wrapper (`leash openhands ...`). Policy can be passed via the `--policy` flag or via Leash config (see [Leash CONFIG.md](https://github.com/strongdm/leash/blob/main/docs/CONFIG.md)):

```bash
leash run --policy ./policies/agent-sandbox.cedar -- npm run my-agent
```

For `leash openhands`, configure the policy path in `~/.config/leash/config.toml` or via the `LEASH_POLICY_FILE` environment variable. Leash reads the Cedar file and enforces it during sandbox execution.

---

## Best Practices: The Software Factory Policy

For an autonomous Coder Agent running inside our Factory Convergence Loop, the Cedar policy should balance the agent's need to compile code with the absolute necessity of preventing Reward Hacking and Infrastructure Corruption.

### What MUST Be Permitted

Because Cedar is default-deny, if you don't explicitly allow these, the agent will crash immediately.

1. **Read-Only Access Everywhere:** The agent needs to read the whole repo to understand imports and existing architecture.
2. **Write Access to `src/`:** The agent must be able to write the actual implementation code.
3. **Write Access to `package.json` / `pnpm-lock.yaml`:** If the feature requires a new dependency, the agent must be able to install it.
4. **Network Access to Package Registries:** The agent must be able to hit `registry.npmjs.org` or `github.com` to download libraries.

### What MUST Be Forbidden

We use explicit `forbid` statements to create impenetrable boundaries. In Cedar, a `forbid` statement always overrides a `permit` statement.

1. **Test Modification (Anti-Reward Hacking):** The agent must NEVER be allowed to write to the tests directory or modify the `cctr` corpus files. If it can rewrite the test, it will cheat.
2. **Git History Corruption:** The agent must not be able to modify the `.git/` folder to erase its history or mess with worktrees.
3. **CI/CD Injection:** The agent must not be able to write to `.github/workflows/` to spawn malicious GitHub Actions on the host.
4. **Internal Network Scanning:** The agent must be blocked from accessing localhost or private IP ranges (e.g., AWS Metadata endpoints `169.254.169.254`) to prevent Server-Side Request Forgery (SSRF) during the loop.

### Example: Stricter factory-style policy (`agent-sandbox.cedar`)

Illustrative only — validate against your Leash version (`/api/policies/validate` or Control UI). Leash v1 does not support arbitrary `IP::`/CIDR resources the same way; use `Host::` rules and upstream guidance for metadata / SSRF-style denies.

```cedar
// Read-oriented opens on the whole container (bootstrap, libs, /etc)
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

// Write opens only under src/ and selected files (tighten/expand for your layout)
permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/src/", File::"/workspace/package.json" ]
};

// Belt-and-suspenders: deny writes even if permits are extended later
forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/openspec/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/.git/", Dir::"/workspace/.github/" ]
};

permit (
    principal,
    action == Action::"ProcessExec",
    resource
) when {
    resource in [ Dir::"/" ]
};

permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [ Host::"registry.npmjs.org", Host::"github.com" ]
};
```

**Note:** The shipped `default.cedar` uses read-only opens on `Dir::"/"`, `FileOpenReadWrite` on `Dir::"/workspace/"` and `Dir::"/tmp/"`, and `forbid`s `FileOpenReadWrite` under `saifctl/` and `.git/`. Start from that file when you want parity with `saifctl feat run` defaults.
