// Default Leash Cedar policy for the Software Factory agent sandbox.
//
// Security model:
//   - Agent can read all files in the container.
//   - Writes are restricted to `/workspace/` (mounted sandbox copy) and `/tmp/` (tool state).
//   - Writes to `/workspace/saifctl/` are explicitly DENIED (reward-hacking prevention).
//   - Network is unrestricted. The agent needs to reach LLM APIs, npm/PyPI
//     registries, GitHub, and arbitrary CDNs during normal operation. The
//     real isolation boundary is the filesystem, not the network.
//
// Override with --cedar <path> to supply a project-specific policy.
//
// Cedar shape matches StrongDM Leash (transpiler + linter):
//   https://github.com/strongdm/leash/blob/main/docs/design/CEDAR.md
//   - Filesystem: Action::"FileOpen" | "FileOpenReadOnly" | "FileOpenReadWrite" with Dir::"/path/"
//     (trailing slash = directory coverage per Leash).
//   - ProcessExec: Dir:: paths (broader / for system binaries on PATH).
//   - Network: Action::"NetworkConnect" with Host::"name" or Host::"*" for allow-all.

// ── Filesystem ──────────────────────────────────────────────────────────────

// All to read all files on the system
permit (
    principal,
    action in [Action::"FileOpen", Action::"FileOpenReadOnly"],
    resource
) when {
    resource in [ Dir::"/" ]
};

// Allow write only inside the workspace and in /tmp/
permit (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/", Dir::"/tmp/" ]
};

// Disallow write to the dir with user's specs and tests (reward-hacking prevention).
forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/saifctl/" ]
};

// Disallow write to .git (sandbox-escape prevention).
// If the agent rewrites .git/config (e.g. core.fsmonitor, diff.external) the
// malicious hooks will be evaluated by the host orchestrator when it runs
// `git add` / `git diff` in extractPatch — giving the agent arbitrary host
// command execution outside the Leash container.
forbid (
    principal,
    action == Action::"FileOpenReadWrite",
    resource
) when {
    resource in [ Dir::"/workspace/.git/" ]
};

// ── Process execution ───────────────────────────────────────────────────────
// Allow to call any process
// Match Leash bootstrap: agents need /bin/bash, /usr/bin/pnpm, node, python, etc.

permit (
    principal,
    action == Action::"ProcessExec",
    resource
) when {
    resource in [ Dir::"/" ]
};

// ── Network ─────────────────────────────────────────────────────────────────

// Allow all outbound network connections.
// The agent needs to reach LLM APIs, npm/PyPI/apt registries, GitHub, and
// arbitrary tool CDNs. Restricting network adds friction without meaningful
// security benefit given the filesystem sandbox already contains the blast radius.
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [ Host::"*" ]
};
