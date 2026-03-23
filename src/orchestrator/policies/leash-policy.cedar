// Default Leash Cedar policy for the Software Factory agent sandbox.
//
// Security model:
//   - Filesystem writes are restricted to /workspace (the mounted sandbox copy).
//   - Writes to /workspace/saifac/ are explicitly DENIED — belt-and-suspenders
//     on top of the patch filter in sandbox.ts (reward-hacking prevention).
//   - Network is unrestricted. The agent needs to reach LLM APIs, npm/PyPI
//     registries, GitHub, and arbitrary CDNs during normal operation. The
//     real isolation boundary is the filesystem, not the network.
//
// Override with --cedar <path> to supply a project-specific policy.

// ── Filesystem ──────────────────────────────────────────────────────────────

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

// … except the saifac directory (reward-hacking prevention).
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/saifac"
);

// … and except the .git directory (sandbox-escape prevention).
// If the agent rewrites .git/config (e.g. core.fsmonitor, diff.external) the
// malicious hooks will be evaluated by the host orchestrator when it runs
// `git add` / `git diff` in extractPatch — giving the agent arbitrary host
// command execution outside the Leash container.
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);

// ── Network ─────────────────────────────────────────────────────────────────

// Allow all outbound network connections.
// The agent needs to reach LLM APIs, npm/PyPI/apt registries, GitHub, and
// arbitrary tool CDNs. Restricting network adds friction without meaningful
// security benefit given the filesystem sandbox already contains the blast radius.
permit (
    principal,
    action == Action::"NetworkConnect",
    resource
);
