/**
 * Cross-agent drop-privileges contract (release-readiness/X-08-P7 enforcement, release-readiness/X-08-P8 ratchet).
 *
 * Today, dropping privileges in `agent.sh` is required only for `claude`
 * (Claude Code 2.x refuses `--dangerously-skip-permissions` as root). The
 * other 14 agent profiles run as root by design.
 *
 * **Symmetric drop-privileges across all agents** is the right long-term
 * default (least-privilege; a bug or prompt-injection in any agent shouldn't
 * have root in the workspace). It is filed as **release-readiness/X-08-P8** — deferred until
 * release-readiness/X-01's smoke matrix exercises every agent end-to-end. See
 * release-readiness/X-08 §4.1 for the plan.
 *
 * This test is the ratchet that prevents the contract from drifting in the
 * meantime. It enforces three facts:
 *
 *   1. **Explicit per-agent decision.** Every agent profile under
 *      `src/agent-profiles/` must appear in **either** the
 *      `DROPS_PRIVILEGES` set (its `agent.sh` `runuser`s into
 *      `$SAIFCTL_UNPRIV_USER`) **or** the `ROOT_OK_ALLOWLIST` set (a
 *      conscious decision to keep the agent running as root for now,
 *      tracked under release-readiness/X-08-P8).
 *      Adding a new agent profile fails this test until the maintainer
 *      lists it in one of the two sets — forcing the question
 *      "should this agent run as root?" at PR time, instead of letting
 *      it slip in by default.
 *
 *   2. **No half-measures.** Every agent in `DROPS_PRIVILEGES` must also
 *      include the Linux UID-realignment block (`usermod -u` against the
 *      bind-mount owner). A `runuser` without realignment works on macOS
 *      Docker Desktop (UID translation) but breaks on Linux strict 1:1
 *      UID mapping — so allowing one without the other is a CI footgun.
 *
 *   3. **Claude is canonical.** `claude` must remain in `DROPS_PRIVILEGES`.
 *      A regression that simplifies `claude/agent.sh` and removes the
 *      `runuser` call would re-introduce the original P2 hang.
 *
 * **How to add a new agent profile:**
 *   - If the agent works fine as root (typical): add its id to
 *     `ROOT_OK_ALLOWLIST` below.
 *   - If the agent must drop privileges (root-incompatible CLI, like
 *     Claude): add its id to `DROPS_PRIVILEGES` and ensure its `agent.sh`
 *     uses `runuser -l "$SAIFCTL_UNPRIV_USER"` plus the UID realignment
 *     block (copy from `src/agent-profiles/claude/agent.sh`).
 *
 * **How to graduate an agent from root to drop-privileges (release-readiness/X-08-P8):**
 *   Move its id from `ROOT_OK_ALLOWLIST` to `DROPS_PRIVILEGES`, rewrite
 *   its `agent.sh` + `agent-install.sh` accordingly, run the integration
 *   harness against it.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSaifctlRoot } from '../constants.js';

const PROFILES_DIR = join(getSaifctlRoot(), 'src', 'agent-profiles');

/**
 * Agent profiles whose `agent.sh` drops privileges to `$SAIFCTL_UNPRIV_USER`
 * for the actual agent invocation. Required for any agent CLI that refuses
 * to run as root (Claude Code 2.x is the load-bearing case); also the
 * default for every agent post release-readiness/X-08-P8 (least-privilege hygiene).
 */
const DROPS_PRIVILEGES = new Set<string>([
  'aider',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'deepagents',
  'forge',
  'gemini',
  'kilocode',
  'mini-swe-agent',
  'opencode',
  'openhands',
  'qwen',
  'terminus',
]);

/**
 * Agent profiles that intentionally run as root. The `debug` profile is the
 * only remaining one — it ships a minimal no-LLM agent that's used by the
 * release-readiness/X-08 integration harness to validate Docker plumbing without burning LLM
 * tokens, and it intentionally exercises the root code path so a regression
 * there surfaces in P1 instead of going unnoticed.
 *
 * Any new agent profile must end up in either `DROPS_PRIVILEGES` (default
 * for any agent that does real work) or here. The test below fails when an
 * unlisted profile dir exists — the failure message tells the maintainer
 * which set to add it to.
 */
const ROOT_OK_ALLOWLIST = new Set<string>(['debug']);

interface AgentProfileFiles {
  id: string;
  agentScriptPath: string;
  agentScriptContent: string;
}

async function loadAgentProfiles(): Promise<AgentProfileFiles[]> {
  const out: AgentProfileFiles[] = [];
  const entries = await readdir(PROFILES_DIR);
  for (const name of entries) {
    const dir = join(PROFILES_DIR, name);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) continue;
    const agentScriptPath = join(dir, 'agent.sh');
    const ds = await stat(agentScriptPath).catch(() => null);
    if (!ds?.isFile()) continue;
    const agentScriptContent = await readFile(agentScriptPath, 'utf-8');
    out.push({ id: name, agentScriptPath, agentScriptContent });
  }
  return out;
}

function dropsPrivileges(content: string): boolean {
  return /\brunuser\b/.test(content) || /SAIFCTL_UNPRIV_USER\b/.test(content);
}

function realignsUid(content: string): boolean {
  // Two acceptable shapes:
  //   - inline `usermod -u <uid> <user>` (legacy, before release-readiness/X-08-P8 helper)
  //   - sourcing the shared helper at /saifctl/saifctl-agent-helpers.sh
  //     and calling either `saifctl_realign_unpriv_uid` or
  //     `saifctl_drop_privs_init` (the latter calls the former).
  // A stub that only mentions realignment in a comment fails — load-bearing
  // calls only.
  if (/\busermod\s+-u\b/.test(content)) return true;
  const sourcesHelper = /source\s+\/saifctl\/saifctl-agent-helpers\.sh/.test(content);
  const callsRealign =
    /\bsaifctl_realign_unpriv_uid\b/.test(content) || /\bsaifctl_drop_privs_init\b/.test(content);
  return sourcesHelper && callsRealign;
}

describe('agent drop-privileges contract (X-08-P7 / X-08-P8 ratchet)', () => {
  it('every agent profile is classified (DROPS_PRIVILEGES or ROOT_OK_ALLOWLIST)', async () => {
    const profiles = await loadAgentProfiles();
    const unclassified: string[] = [];
    for (const p of profiles) {
      const isDrop = DROPS_PRIVILEGES.has(p.id);
      const isRootOk = ROOT_OK_ALLOWLIST.has(p.id);
      if (!isDrop && !isRootOk) unclassified.push(p.id);
    }
    expect(
      unclassified,
      `New agent profile(s) without an explicit root/non-root decision: ${unclassified.join(', ')}\n` +
        `  Open src/agent-profiles/drop-privileges-contract.test.ts and add each id to either:\n` +
        `    DROPS_PRIVILEGES — if the agent CLI refuses to run as root (and update agent.sh accordingly)\n` +
        `    ROOT_OK_ALLOWLIST — if it's fine running as root for now (release-readiness/X-08-P8 will revisit)`,
    ).toEqual([]);
  });

  it('no classified-but-missing profile id (sets must reflect what is on disk)', async () => {
    // Catches stale allowlists: an entry in DROPS_PRIVILEGES or
    // ROOT_OK_ALLOWLIST that no longer exists as a profile dir. Forces
    // explicit cleanup when an agent profile is removed.
    const profiles = await loadAgentProfiles();
    const onDisk = new Set(profiles.map((p) => p.id));
    const stale: string[] = [];
    for (const id of DROPS_PRIVILEGES) {
      if (!onDisk.has(id)) stale.push(`DROPS_PRIVILEGES contains "${id}"`);
    }
    for (const id of ROOT_OK_ALLOWLIST) {
      if (!onDisk.has(id)) stale.push(`ROOT_OK_ALLOWLIST contains "${id}"`);
    }
    expect(
      stale,
      `Stale entries in drop-privileges-contract.test.ts (no matching agent profile dir):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('claude is canonical (must always be in DROPS_PRIVILEGES)', () => {
    expect(
      DROPS_PRIVILEGES.has('claude'),
      'claude must remain in DROPS_PRIVILEGES — it is the load-bearing case for release-readiness/X-08-P7. ' +
        'If you intend to remove drop-privileges from claude, you are about to re-introduce ' +
        'the P2 hang documented in release-readiness/X-08-P7. Read that row first.',
    ).toBe(true);
  });

  it('every agent in DROPS_PRIVILEGES has a runuser-using agent.sh', async () => {
    const profiles = await loadAgentProfiles();
    const offenders: string[] = [];
    for (const p of profiles) {
      if (!DROPS_PRIVILEGES.has(p.id)) continue;
      if (!dropsPrivileges(p.agentScriptContent)) {
        offenders.push(p.agentScriptPath);
      }
    }
    expect(
      offenders,
      `Agents listed in DROPS_PRIVILEGES whose agent.sh does not actually call runuser:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every agent in DROPS_PRIVILEGES also realigns UID (Linux/macOS portability)', async () => {
    const profiles = await loadAgentProfiles();
    const offenders: string[] = [];
    for (const p of profiles) {
      if (!DROPS_PRIVILEGES.has(p.id)) continue;
      if (!realignsUid(p.agentScriptContent)) {
        offenders.push(p.agentScriptPath);
      }
    }
    expect(
      offenders,
      `Agents drop privileges without realigning UID (works on macOS, breaks on Linux CI):\n  ${offenders.join('\n  ')}\n` +
        `Copy the "Linux UID realignment" block from src/agent-profiles/claude/agent.sh.`,
    ).toEqual([]);
  });

  it('every DROPS_PRIVILEGES agent cds into the workspace inside its runuser shell', async () => {
    // Why this exists: `runuser -l` runs the target user's *login shell*,
    // which sets the cwd to that user's $HOME (e.g. `/home/saifctl`)
    // regardless of the parent process's cwd. Most agent CLIs resolve
    // task-prompt relative paths against their cwd — without an explicit
    // `cd` into `$SAIFCTL_WORKSPACE_BASE`, an agent told to read
    // `saifctl/features/foo/spec.md` will look for
    // `/home/saifctl/saifctl/features/foo/spec.md` and report "file does
    // not exist". Observed live in release-readiness/X-08 P2: claude found nothing, gave up
    // after 16s with "I cannot find the specification file".
    //
    // Acceptable shapes (any one satisfies the test):
    //   1. `cd "${SAIFCTL_WORKSPACE_BASE:-/workspace}"` — preferred, uses
    //      the orchestrator-set env var with a hardcoded fallback.
    //   2. `cd "$SAIFCTL_WORKSPACE_BASE"` — also fine; env var is always
    //      set by buildCoderContainerEnv.
    //   3. `cd /workspace` — literal fallback. Discouraged (couples the
    //      script to the bind-mount path) but semantically correct.
    const profiles = await loadAgentProfiles();
    const offenders: { id: string; path: string }[] = [];

    for (const p of profiles) {
      if (!DROPS_PRIVILEGES.has(p.id)) continue;
      const usesEnv = /cd\s+"?\$\{?SAIFCTL_WORKSPACE_BASE/.test(p.agentScriptContent);
      const usesLiteral = /cd\s+["']?\/workspace["']?\s*(?:#|$)/m.test(p.agentScriptContent);
      if (!usesEnv && !usesLiteral) {
        offenders.push({ id: p.id, path: p.agentScriptPath });
      }
    }

    expect(
      offenders,
      `Agents that drop privileges without cd-ing into the workspace inside the runuser shell:\n` +
        offenders.map((o) => `  ${o.path}`).join('\n') +
        `\n\nAdd as the first line of the inline shell (right after \`export PATH=…\`):\n` +
        `  cd "\${SAIFCTL_WORKSPACE_BASE:-/workspace}"\n` +
        `Also ensure SAIFCTL_WORKSPACE_BASE is in the runuser whitelist (it's in ` +
        `\`saifctl_unpriv_env_whitelist\`'s default output). See the cwd gotcha in ` +
        `src/orchestrator/scripts/saifctl-agent-helpers.sh.`,
    ).toEqual([]);
  });

  it('every DROPS_PRIVILEGES agent forwards TLS env across the runuser boundary', async () => {
    // Why this exists: `runuser -l` resets the environment to a clean
    // login shell, stripping NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
    // REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE. Those vars carry Leash's MITM
    // CA wiring; without them, any outbound HTTPS from the unprivileged
    // shell (npm, pip, the agent CLI's own HTTP client) fails with
    // `SELF_SIGNED_CERT_IN_CHAIN`. Observed live in release-readiness/X-08 P2 — the orchestrator
    // hung 15 min before vitest's testTimeout fired (and again at 74s once
    // the L1/L2 deadlock fix exposed the underlying agent-install failure).
    //
    // Acceptable shapes (any one satisfies the test):
    //   1. `--whitelist-environment="$(saifctl_unpriv_env_whitelist)…"` — the
    //      central helper threads SAIFCTL_TLS_ENV_NAMES into its output.
    //      Recommended; future-proofs the script against new factory env vars.
    //   2. `--whitelist-environment="${SAIFCTL_TLS_ENV_NAMES},…"` — explicit
    //      reference to the constant. Acceptable for scripts that have a
    //      reason to NOT use the central helper (smaller blast radius).
    //   3. All four var names listed literally in the whitelist string.
    //      Discouraged — bypasses the constant, easy to drift — but
    //      semantically correct, so we accept it rather than forcing churn.
    const profiles = await loadAgentProfiles();
    const offenders: { id: string; path: string; reason: string }[] = [];

    const profileFiles = await Promise.all(
      profiles
        .filter((p) => DROPS_PRIVILEGES.has(p.id))
        .flatMap((p) => {
          const installPath = p.agentScriptPath.replace(/\bagent\.sh$/, 'agent-install.sh');
          return [
            { id: p.id, path: p.agentScriptPath, content: p.agentScriptContent },
            // agent-install.sh is optional — load when present.
            stat(installPath)
              .then((s) => (s.isFile() ? readFile(installPath, 'utf-8') : null))
              .catch(() => null)
              .then((content) =>
                content === null ? null : { id: p.id, path: installPath, content },
              ),
          ];
        }),
    );

    for (const file of profileFiles) {
      if (!file) continue;
      // Skip files that don't actually invoke runuser (e.g. an
      // agent-install.sh that just calls `apt-get` as root).
      if (!/--whitelist-environment\b/.test(file.content)) continue;
      const usesHelper = /\$\(saifctl_unpriv_env_whitelist\)/.test(file.content);
      const usesConstant = /\$\{?SAIFCTL_TLS_ENV_NAMES\}?/.test(file.content);
      const usesAllLiteral =
        /NODE_EXTRA_CA_CERTS\b/.test(file.content) &&
        /SSL_CERT_FILE\b/.test(file.content) &&
        /REQUESTS_CA_BUNDLE\b/.test(file.content) &&
        /CURL_CA_BUNDLE\b/.test(file.content);
      if (usesHelper || usesConstant || usesAllLiteral) continue;
      offenders.push({
        id: file.id,
        path: file.path,
        reason: 'whitelist does not include TLS env (helper / constant / 4 literal names)',
      });
    }

    expect(
      offenders,
      `Agent scripts that drop privileges without forwarding Leash's MITM CA env across the runuser boundary:\n` +
        offenders.map((o) => `  ${o.path} — ${o.reason}`).join('\n') +
        `\n\nFix: replace the literal whitelist with \`$(saifctl_unpriv_env_whitelist)\` (preferred) or ` +
        `prepend \`\${SAIFCTL_TLS_ENV_NAMES},\` to the existing list. ` +
        `See src/orchestrator/scripts/saifctl-agent-helpers.sh for the constant + helper.`,
    ).toEqual([]);
  });

  it('no agent in ROOT_OK_ALLOWLIST silently drops privileges (must be deliberate)', async () => {
    // If an agent.sh adds a runuser call without graduating into
    // DROPS_PRIVILEGES, the allowlist comment becomes a lie. Force the
    // maintainer to move the id explicitly.
    const profiles = await loadAgentProfiles();
    const drift: string[] = [];
    for (const p of profiles) {
      if (!ROOT_OK_ALLOWLIST.has(p.id)) continue;
      if (dropsPrivileges(p.agentScriptContent)) {
        drift.push(`${p.id} (move from ROOT_OK_ALLOWLIST to DROPS_PRIVILEGES)`);
      }
    }
    expect(
      drift,
      `Agents in ROOT_OK_ALLOWLIST whose agent.sh now drops privileges:\n  ${drift.join('\n  ')}`,
    ).toEqual([]);
  });
});
