# Access control with Cedar

**[Cedar](https://www.cedarpolicy.com/)** is the policy language that defines what the coding agent is and isn't allowed to do inside its sandbox. Think of [Leash](https://github.com/strongdm/leash) as the enforcer and Cedar as the rulebook — Leash intercepts every action the agent attempts; Cedar decides whether to allow or deny it.

This page covers writing and customizing Cedar policies. For how Leash containers run and monitor agents, see the Leash documentation.

---

## Why Cedar

Cedar was chosen specifically for agentic workflows. Four properties make it the right fit:

1. **Default-deny** — If an action isn't explicitly permitted by a `permit` statement, it's automatically denied. There is no "allow by default" footgun. An agent with no policy can do nothing.

2. **`forbid` always wins** — A `forbid` statement overrides any matching `permit`. You can grant broad write access and then punch out specific protected paths — the forbids are guaranteed to hold regardless of what permits exist.

3. **Readable** — Policies are plain text that any engineer can audit. No JSON blobs, no YAML conditionals. Security rules that can't be read can't be trusted.

4. **Fast** — Cedar evaluates in microseconds. Leash can intercept thousands of file writes and network requests across a 50-iteration agent loop with no measurable slowdown.

---

## What you can control

Cedar policies are built around three concepts: **Principal** (who), **Action** (what they do), **Resource** (what they do it to).

Through Leash, three categories of agent behavior are controllable:

### Filesystem

Actions: `ReadFile`, `WriteFile`, `DeleteFile`  
Resources: `File::"/path/to/file"` or `Directory::"/path/to/dir"`

```cedar
// Allow reading the whole workspace
permit (
    principal,
    action == Action::"ReadFile",
    resource in Directory::"/workspace"
);

// Restrict writes to source code only
permit (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/src"
);
```

### Network

Actions: `NetworkConnect`  
Resources: `Domain::"hostname"` or `IP::"address/cidr"`

```cedar
// Allow only npm and GitHub
permit (
    principal,
    action == Action::"NetworkConnect",
    resource in [Domain::"registry.npmjs.org", Domain::"github.com"]
);

// Block cloud metadata endpoints (SSRF prevention)
forbid (
    principal,
    action == Action::"NetworkConnect",
    resource in [IP::"169.254.169.254", IP::"127.0.0.1"]
);
```

### MCP tools

Actions: `ExecuteTool`  
Resources: `Tool::"tool-name"`

```cedar
// Restrict a 50-tool MCP server to the 2 tools this agent actually needs
permit (
    principal,
    action == Action::"ExecuteTool",
    resource in [Tool::"read_file", Tool::"write_file"]
);
```

See the [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md) for the full list of available action and resource types.

---

## The default policy

The factory ships `src/orchestrator/leash-policy.cedar`. This is default policy that applies when you run [`run`](./commands/feat-run.md) or [`continue`](./commands/feat-continue.md) commands.

```cedar
// Default Leash Cedar policy for the Software Factory agent sandbox.
//
// Security model:
//   - Filesystem writes are restricted to /workspace (the mounted sandbox copy).
//   - Writes to /workspace/openspec/ are explicitly DENIED — belt-and-suspenders
//     on top of the patch filter in sandbox.ts (reward-hacking prevention).
//   - Network is unrestricted. The agent needs to reach LLM APIs, npm/PyPI
//     registries, GitHub, and arbitrary CDNs during normal operation. The
//     real isolation boundary is the filesystem, not the network.

// Allow full read anywhere in the workspace.
permit (
    principal,
    action == Action::"ReadFile",
    resource in Directory::"/workspace"
);

// Allow writes anywhere in the workspace …
permit (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace"
);

// … except the openspec directory (reward-hacking prevention).
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/openspec"
);

// … and except the .git directory (sandbox-escape prevention).
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);

// Allow all outbound network connections.
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
);
```

**Why openspec writes are forbidden:** The agent must never modify specs or tests — that's reward hacking. The `openspec/` directory contains the test suite and spec files. The Cedar `forbid` is a second layer on top of the patch filter in `sandbox.ts`.

**Why `.git` writes are forbidden:** If the agent rewrites `.git/config` (e.g. `core.fsmonitor`, `diff.external`), those hooks run on the host when the orchestrator calls `git add` / `git diff` to extract the patch — giving the agent arbitrary command execution outside the Leash container.

**Why network is unrestricted:** The agent needs to reach LLM APIs, npm/PyPI/apt registries, GitHub, and arbitrary CDNs. Restricting network traffic adds friction without meaningful security gain — the filesystem sandbox already contains the blast radius.

---

## Using a custom policy

Pass `--cedar` to supply your own policy file:

```bash
saif feat run --cedar ./my-policy.cedar
pnpm agents feat:continue --cedar ./my-policy.cedar
```

The path must be absolute or relative to the repo root. The file is read at run time — no rebuild needed.

Custom policies are useful when you want to tighten the default (e.g. restrict network to specific registries) or loosen it for a specific feature (e.g. allow writes to a generated assets directory).

---

## See Also

- [Sandbox profiles](./sandbox-profiles.md)
- [Environment variables](./env-vars.md)
- [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md)
