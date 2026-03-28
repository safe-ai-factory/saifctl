// Test policy: same filesystem + ProcessExec rules as default.cedar; outbound network is
// default-deny except registry.npmjs.org.
// Everything else stays denied for NetworkConnect.
//
// Try with the debug agent (HTTP probe):
//   saifctl feat run ... --agent debug --cedar src/orchestrator/policies/deny-network.cedar

// ── Filesystem (aligned with default.cedar) ───────────────────────────────

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

// ── Network ─────────────────────────────────────────────────────────────────
// Allow installs from the default npm registry only (pnpm/npm). Leash matches
// NetworkConnect with Host::. Add Host:: entries for npm.jsr.io, GitHub tarballs,
// etc. if installs need them.

permit (
    principal,
    action == Action::"NetworkConnect",
    resource
) when {
    resource in [ Host::"registry.npmjs.org" ]
};
