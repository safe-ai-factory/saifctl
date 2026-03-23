// Test policy: same filesystem rules as leash-policy.cedar; outbound network is
// default-deny except registry.npmjs.org.
// Everything else stays denied for NetworkConnect.
//
// Try with the debug agent (HTTP probe):
//   saifac feat run ... --agent debug --cedar src/orchestrator/policies/leash-policy.deny-network.cedar

// ── Filesystem (aligned with leash-policy.cedar) ────────────────────────────

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

// ── Network ─────────────────────────────────────────────────────────────────
// Allow installs from the default npm registry only (pnpm/npm). Leash matches
// NetworkConnect with Host:: (not Domain::). Add Host:: entries for npm.jsr.io,
// GitHub tarballs, etc. if installs need them.

permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [ Host::"registry.npmjs.org" ]
};
