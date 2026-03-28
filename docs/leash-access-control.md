# Access control with Leash and Cedar

An agent that can read and write the whole workspace and reach any host on the internet can exfiltrate secrets, rewrite tests to pass without fixing code, pull in malicious packages, or hammer paid APIs—often without you noticing until later.

[Leash](https://github.com/strongdm/leash) enforces limits inside the agent container. [Cedar](https://www.cedarpolicy.com/) is the policy language (`permit` / `forbid`). You point the CLI at a file policy with **`--cedar`**.

---

## How to use

Save as `saifctl/policies/allowlist.cedar` (paths and hostnames are yours to tune):

```cedar
// Filesystem + ProcessExec: same shape as src/orchestrator/policies/default.cedar (Leash schema).
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/", Dir::"/tmp/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/saifctl/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/.git/" ]
};

permit (
    principal,
    action == Action::"ProcessExec",
    resource
) when {
    resource in [ Dir::"/" ]
};

// Network: hostname allowlist (not Host::"*" )
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
saifctl feat run -n your-feature --cedar policies/allowlist.cedar
```

## Default policy

Omit `--cedar` to use the default policy:

```bash
saifctl feat run -n your-feature
```

In this repository the bundled file is `src/orchestrator/policies/default.cedar` (published inside the npm package).

Default policy:

- **Network:** `NetworkConnect` for `Host::"*"`
- **Filesystem:** `FileOpen` / `FileOpenReadOnly` under `Dir::"/"`; `FileOpenReadWrite` under `Dir::"/workspace/"` and `Dir::"/tmp/"`; `FileOpenReadWrite` forbidden under `Dir::"/workspace/saifctl/"` and `Dir::"/workspace/.git/"`
- **ProcessExec:** permitted under `Dir::"/"` (shell and tools on `PATH`)

---

## More examples

Policies usually live in your repo (e.g. `policies/`). Adjust hostnames and directories for your stack.

### 1. Deny all outbound network

No `NetworkConnect` `permit` → everything outbound is denied. Good for checking enforcement; pair with `--agent debug` (HTTP probe) unless `SAIFCTL_SKIP_NETWORK_PROBE=1`.

`policies/no-network.cedar`:

```cedar
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/", Dir::"/tmp/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/saifctl/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/.git/" ]
};

permit (
    principal,
    action == Action::"ProcessExec",
    resource
) when {
    resource in [ Dir::"/" ]
};
```

```bash
saifctl feat run -n your-feature --agent debug --cedar policies/no-network.cedar
```

### 2. Network allowlist

Add `Host::"..."` entries for your LLM API, GitHub, `npm.jsr.io`, and any other hostnames you need to reach.

```bash
saifctl feat run -n your-feature --cedar policies/network-allowlist.cedar
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

Read opens on `Dir::"/"` (bootstrap and system libs); `FileOpenReadWrite` only under `/workspace/src/` and `/tmp/` (change paths for your layout). Add more `FileOpenReadWrite` permits or `File::` entries if the agent must edit repo-root files.

`policies/fs-writes-src-only.cedar`:

```cedar
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/src/", Dir::"/tmp/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/saifctl/" ]
};

forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/.git/" ]
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
    resource in [ Host::"*" ]
};
```

```bash
saifctl feat run -n your-feature --cedar policies/fs-writes-src-only.cedar
```

---

## Policy basics

Cedar is **default-deny**: no matching `permit` means denied. A matching **`forbid`** beats a `permit`.

Cedar policies are built around three concepts: **Principal** (who), **Action** (what they do), **Resource** (what they do it to).

The authoritative list of actions and resource types for Leash is the [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md).

### Filesystem

Under Leash: **`FileOpen`**, **`FileOpenReadOnly`**, **`FileOpenReadWrite`** — not `ReadFile` / `WriteFile`.  
Resources: **`File::"/path"`** or **`Dir::"/path/"`** (trailing slash for directory trees).

```cedar
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/src/", Dir::"/tmp/" ]
};
```

### Network

Actions: **`NetworkConnect`**  
Resources: **`Host::"hostname"`**, **`Host::"host:port"`**, or **`Host::"*"`** for allow-all.

```cedar
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [ Host::"registry.npmjs.org", Host::"github.com" ]
};
```

SSRF / metadata blocking may require **`Host::`-style rules** and proxy behavior; Leash v1 has limited **`IP::`/CIDR** support — see the [Leash Cedar reference](https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md).

### MCP tools

Actions: **`McpCall`**  
Resources: **`MCP::Server::"..."`**, **`MCP::Tool::"..."`** (enforcement semantics are version-specific; see Leash docs).

```cedar
forbid (
    principal,
    action == Action::"McpCall",
    resource == MCP::Tool::"risky-tool"
) when {
    resource in [ MCP::Server::"mcp.example.com" ]
};
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
