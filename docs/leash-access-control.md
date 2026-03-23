# Access control with Leash and Cedar

An agent that can read and write the whole workspace and reach any host on the internet can exfiltrate secrets, rewrite tests to pass without fixing code, pull in malicious packages, or hammer paid APIs—often without you noticing until later.

[Leash](https://github.com/strongdm/leash) enforces limits inside the agent container. [Cedar](https://www.cedarpolicy.com/) is the policy language (`permit` / `forbid`). You point the CLI at a file policy with **`--cedar`**.

---

## How to use

Save as `saifac/policies/allowlist.cedar` (paths and hostnames are yours to tune):

```cedar
// Filesystem: same as leash-policy.cedar
permit (
    principal,
    action == Action::"ReadFile",
    resource in Directory::"/workspace"
);

permit (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/saifac"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);

// Network: allowlist of hostnames
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [
        Host::"registry.npmjs.org",
        Host::"example.com"
        // Host::"api.anthropic.com",
        // Host::"github.com",
    ]
};
```

Run with that policy:

```bash
saifac feat run -n your-feature --cedar policies/allowlist.cedar
```

## Default policy

Omit `--cedar` to use the default policy:

```bash
saifac feat run -n your-feature
```

In this repository the bundled file is `src/orchestrator/policies/leash-policy.cedar` (published inside the npm package).

Default policy:

- Network: Everything is allowed
- Filesystem: Deny writes to `${workspace}/saifac` and `${workspace}/.git` directories

---

## More examples

Policies usually live in your repo (e.g. `policies/`). Adjust hostnames and directories for your stack.

### 1. Deny all outbound network

No `NetworkConnect` `permit` → everything outbound is denied. Good for checking enforcement; pair with `--agent debug` (HTTP probe) unless `SAIFAC_SKIP_NETWORK_PROBE=1`.

`policies/no-network.cedar`:

```cedar
permit (
    principal,
    action == Action::"ReadFile",
    resource in Directory::"/workspace"
);

permit (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/saifac"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);
```

```bash
saifac feat run -n your-feature --agent debug --cedar policies/no-network.cedar
```

### 2. Network allowlist

Add `Host::"..."` entries for your LLM API, GitHub, `npm.jsr.io`, and any other hostnames you need to reach.

```bash
saifac feat run -n your-feature --cedar policies/network-allowlist.cedar
```

`policies/network-allowlist.cedar`:

```cedar
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [
      Host::"registry.npmjs.org",
      Host::"example.com",
      // Host::"api.anthropic.com",
      // Host::"github.com",
    ]
};
```

### 3. Filesystem: writes only under `src/`

Reads all of `/workspace`; writes only `/workspace/src` (change path for your layout). Add more `WriteFile` permits if the agent must touch repo-root files.

`policies/fs-writes-src-only.cedar`:

```cedar
permit (
    principal,
    action == Action::"ReadFile",
    resource in Directory::"/workspace"
);

// Writes only under src/ (adjust path to your project)
permit (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/src"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/saifac"
);

forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);

permit (
    principal,
    action == Action::"NetworkConnect",
    resource
);
```

```bash
saifac feat run -n your-feature --cedar policies/fs-writes-src-only.cedar
```

---

## Policy basics

Cedar is **default-deny**: no matching `permit` means denied. A matching **`forbid`** beats a `permit`.

Cedar policies are built around three concepts: **Principal** (who), **Action** (what they do), **Resource** (what they do it to).

The authoritative list of actions and resource types for Leash is the [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md).

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
Resources: `Host::"hostname"`

```cedar
// Allow only npm and GitHub
permit (
    principal,
    action == Action::"NetworkConnect",
    resource in [Host::"registry.npmjs.org", Host::"github.com"]
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

## Control UI and logs

Leash serves a small web app from the manager container (`agents-leash`).

While a run is using Leash, open [http://localhost:18080](http://localhost:18080) to inspect what the agent is doing.

The website shows:
- Policy state
- Allowed and denied actions
- Telemetry Leash records (filesystem and network decisions)

Read more on [Leash Control UI](https://github.com/strongdm/leash).

## Docker containers

Leash spawns two containers:
- `agents` is the coding agent container
- `agents-leash` enforces the Cedar policy and serves the Control UI

## Why Cedar

Cedar was chosen specifically for agentic workflows:

1. **Default-deny** — If an action isn't explicitly permitted by a `permit` statement, it's automatically denied. An agent with no policy can do nothing.

2. **`forbid` always wins** — A `forbid` statement overrides any matching `permit`. You can grant broad write access and then punch out specific protected paths.

---

## See also

- [Access control with Cedar](./leash-access-control.md)
- [Development: Leash component](./development/v0/swf-comp-d-leash.md)
- [feat run](./commands/feat-run.md)
- [Environment variables](./env-vars.md)
