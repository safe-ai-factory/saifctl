# Security Assessment of the Orchestrator

_Initial assessment: 27/02/2026. Last updated: 02/03/2026 (findings 6–7 added and resolved)._

---

## Executive Summary

The architectural concept of the Orchestrator — specifically the **"Mutual Verification"**, **"Fail2Pass"** check, and the physical separation of holdout tests from the agent's workspace — is excellent. It effectively mitigates "reward hacking" (where an AI alters tests to pass them) and establishes a solid theoretical sandbox.

The original design document contained several Critical and High vulnerabilities. All five have now been addressed in the implementation. The current status of each finding is documented below.

---

## Findings

### 1. Host Command Injection via Unsanitized `stderr` Feedback

**Original severity:** CRITICAL  
**Current status:** ✅ Resolved

**The original flaw:** The design fed raw test runner `stderr` back to OpenHands via a **synchronous** subprocess call (`execSync`) with shell string interpolation, allowing a malicious agent to inject arbitrary shell commands on the host.

**How it was fixed:**

- Raw test runner output is **never forwarded** to OpenHands. Instead, the orchestrator emits a deliberately vague message: `"An external service attempted to use this project and failed."` The Vague Specs Checker may append a sanitized behavioral hint, but never raw stderr.
- OpenHands is invoked with `spawn(cmd, args, ...)` where `taskPrompt` is an array element, not a shell-interpolated string. Shell injection via the task string is structurally impossible.
- Leash mode further runs OpenHands inside a monitored container with Cedar policy enforcement.

---

### 2. Arbitrary Code Execution via Malicious Patch Application (`git apply`)

**Original severity:** CRITICAL  
**Current status:** ✅ Resolved

**The original flaw:** The agent could craft a `patch.diff` containing a `.git/hooks/pre-commit` entry. When the host applied the patch and immediately ran `git commit`, the injected hook would execute on the host machine.

**How it was fixed (two layers):**

1. **Patch filter (`modes.ts`)** — `.git/hooks/**` is included in the default `patchExclude` rules passed to `extractPatch()`. The patch filtering stage in `sandbox.ts` strips any matching file section before `patch.diff` is written, so the hook never reaches the host.

2. **Last-resort guard in `applyPatchToHost` (`modes.ts`)** — Before calling `git apply`, the function reads `patch.diff` and throws hard if a `.git/hooks/` path is present:
   ```typescript
   if (/^diff --git.*\.git\/hooks\//m.test(patchContent)) {
     throw new Error('[orchestrator] Patch rejected: contains changes to .git/hooks/. ...');
   }
   ```
   This covers the `test` mode path, which applies an externally-supplied patch that may not have gone through the filter.

**Note:** `.github/` is intentionally **not** excluded. The agent is permitted to create PR templates, workflows, and other GitHub-facing files as part of legitimate feature work.

---

### 3. Root Privilege Escalation via Docker Socket Mount

**Original severity:** CRITICAL  
**Current status:** ✅ Resolved

**The original flaw:** The design suggested mounting `/var/run/docker.sock` to allow the Test Runner to test CLI containers, giving any container root-level control over the host Docker daemon.

**How it was fixed:** The Docker socket is never mounted. The Test Runner communicates with the Staging container exclusively over HTTP via an injected sidecar server (`orchestrator/sidecar`). The sidecar is compiled to a self-contained CJS bundle and injected into the container via `putArchive` — no socket, no `docker exec`.

---

### 4. Path Traversal & Shell Injection via `featureName`

**Original severity:** HIGH  
**Current status:** ✅ Resolved

**The original flaw:** `featureName` was passed directly into shell commands and file paths without sanitization, enabling path traversal (`../../../etc`) or shell injection (`feature; rm -rf /`).

**How it was fixed:**

- `validateFeatureName()` in `src/cli/utils.ts` enforces kebab-case / safe path segments at the CLI boundary. Any name containing path-traversal characters, spaces, or shell metacharacters is rejected immediately with a clear error.
- This applies to all input paths: `--name`/`-n` flag and the interactive `saifac feat new` prompt (which already had the regex).
- Shell commands that use `featureName` quote paths (e.g. `"${sandboxBasePath}"`) as a secondary layer, but the primary control is at the boundary.

---

### 5. Default Container Capabilities (root, unrestricted privileges)

**Original severity:** HIGH  
**Current status:** ✅ Resolved

**The original flaw:** Containers were created without restricting the default root user or Linux capabilities, enabling privilege escalation attempts and crypto-mining from within the container.

**How it was fixed** — both the Staging container and the Test Runner container now receive:

```typescript
User: 'node',                            // non-root uid 1000; ships in all official node images
HostConfig: {
  SecurityOpt: ['no-new-privileges'],    // blocks setuid/setgid escalation
  CapDrop: ['ALL'],                      // drops all Linux capabilities
}
```

Additional (postgres, redis, etc.) containers receive `SecurityOpt: ['no-new-privileges']`. `CapDrop: ALL` is omitted for them since database images may legitimately require certain capabilities, and they do not run agent-controlled code.

**Accepted trade-off:** The Test and Test Runner containers retain outbound network access. OpenHands requires it for npm installs during the coding phase, and the Test Runner needs it to reach the Staging container over the shared Docker network. This is a known and accepted limitation.

---

### 6. Host Command Injection via Malicious `.git/config` in Sandbox

**Original severity:** CRITICAL  
**Current status:** ✅ Resolved

**The flaw:** The agent runs inside the Leash container with write access to `/workspace` (which maps to the sandbox's `code` directory on the host). The sandbox contains a `.git` directory initialized by the orchestrator. If the agent modifies `/workspace/.git/config` (e.g., setting `diff.external` or `core.fsmonitor` to a malicious script), those settings will be executed by the orchestrator when it runs `git add .` and `git diff HEAD` on the host during `extractPatch`. This allows the agent to break out of the Leash container and execute arbitrary commands on the host machine.

**How it was fixed:**

A `forbid` rule was added to `src/orchestrator/policies/default.cedar` denying writes to `/workspace/.git`:

```
forbid (
    principal,
    action == Action::"WriteFile",
    resource in Directory::"/workspace/.git"
);
```

This is belt-and-suspenders: the sandbox's `.git` directory is owned by the orchestrator and must not be writable by the agent code regardless of what git commands the agent tries to run.

---

### 7. Shell Injection via CLI Image Flags

**Original severity:** LOW
**Current status:** ✅ Resolved

**The flaw:** The orchestrator accepts user input for Docker image tags via CLI flags like `--test-image` and `--coder-image`. Early designs interpolated these strings into **shell** one-liners (e.g. `execSync(\`docker build ... -t "${tag}"\`)`). A human user could supply a malicious flag containing double quotes and shell metacharacters (e.g., `--test-image 'my-image"; rm -rf /; "'`) to execute arbitrary commands on their own host machine. Because this requires the user to self-sabotage, it is low severity, but it violates defense-in-depth principles. The implementation avoids this by validating tags and using non-shell **`spawn(command, args, …)`**-style invocation where possible.

**How it was fixed:**

Validation was added at two layers:

1. **CLI boundary (`src/cli/utils.ts`)** — `validateImageTag()` enforces `^[a-zA-Z0-9_.\-:/@]+$` (covers all valid Docker image reference characters) for `--test-image` and `--coder-image`. Invalid values exit immediately with a clear error before any shell command is executed.

2. **Library boundary** — `assertSafeImageTag()` (same regex) is called before starting the test runner container, so callers that bypass the CLI (e.g. tests, direct API usage) are also protected.

---

## Summary

| #   | Finding                                  | Original Severity | Status                                                            |
| --- | ---------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| 1   | `stderr` → shell injection via sync `exec` | CRITICAL       | ✅ Resolved — `spawn()` + sanitized feedback                      |
| 2   | `git apply` hook injection               | CRITICAL          | ✅ Resolved — patch filter + pre-apply guard                      |
| 3   | Docker socket mount → host root          | CRITICAL          | ✅ Resolved — HTTP sidecar, no socket mount                       |
| 4   | Path traversal via `featureName`         | HIGH              | ✅ Resolved — strict regex at CLI boundary                        |
| 5   | Default container capabilities (root)    | HIGH              | ✅ Resolved — `User: node`, `CapDrop: ALL`, `no-new-privileges`   |
| 6   | Host command injection via `.git/config` | CRITICAL          | ✅ Resolved — `forbid` write to `/workspace/.git` in Cedar policy |
| 7   | Shell injection via CLI image flags      | LOW               | ✅ Resolved — `validateImageTag` at CLI + library boundaries      |
