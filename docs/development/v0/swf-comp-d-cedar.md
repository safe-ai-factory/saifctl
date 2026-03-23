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

When using Leash to wrap our Coder Agent, we can configure rules around:

### 1. File System Operations

- **Actions:** `Action::"ReadFile"`, `Action::"WriteFile"`, `Action::"DeleteFile"`
- **Resources:** Specific files (`File::"/workspace/package.json"`) or entire directories (`Directory::"/workspace/src/"`).
- **Configuration Power:** You can allow an agent to read the whole repo to gain context, but strictly restrict its write access to only the folder containing the feature it is building.

### 2. Network Traffic

- **Actions:** `Action::"NetworkConnect"`
- **Resources:** IP addresses (`IP::"192.168.1.0/24"`) or Hostnames (`Host::"registry.npmjs.org"`).
- **Configuration Power:** You can block the agent from scanning your internal VPC or exfiltrating data to unknown servers, while still allowing it to hit npm to install dependencies.

### 3. Tool Usage (MCP - Model Context Protocol)

- **Actions:** `Action::"ExecuteTool"`
- **Resources:** Specific tool names (`Tool::"github_pr_create"`, `Tool::"execute_sql"`).
- **Configuration Power:** You can give an agent an MCP server with 50 tools, but use Cedar to restrict a specific agent to only use the 2 tools relevant to its current task.

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

### Example: The Ideal Factory Policy (`agent-sandbox.cedar`)

```cedar
// --------------------------------------------------------
// PERMISSIONS (What the agent needs to do its job)
// --------------------------------------------------------

// Allow reading any file in the workspace
permit (
    principal == User::"coder-agent",
    action == Action::"ReadFile",
    resource in Directory::"/workspace/"
);

// Allow writing to the source code and config files
permit (
    principal == User::"coder-agent",
    action == Action::"WriteFile",
    resource in Directory::"/workspace/src/"
);

permit (
    principal == User::"coder-agent",
    action == Action::"WriteFile",
    resource == File::"/workspace/package.json"
);

// Allow network connections to standard package registries
permit (
    principal == User::"coder-agent",
    action == Action::"NetworkConnect",
    resource in [Host::"registry.npmjs.org", Host::"github.com"]
);

// --------------------------------------------------------
// FORBIDDEN (Absolute boundaries that override any permits)
// --------------------------------------------------------

// PREVENT REWARD HACKING: Do not let the agent modify tests
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/openspec/"
);

// PREVENT INFRASTRUCTURE CORRUPTION: Protect Git and CI/CD
forbid (
    principal,
    action in [Action::"WriteFile", Action::"DeleteFile"],
    resource in [Directory::"/workspace/.git/", Directory::"/workspace/.github/"]
);

// PREVENT SSRF / CLOUD METADATA EXFILTRATION
forbid (
    principal,
    action == Action::"NetworkConnect",
    resource in [IP::"169.254.169.254", IP::"127.0.0.1", IP::"10.0.0.0/8"]
);
```
