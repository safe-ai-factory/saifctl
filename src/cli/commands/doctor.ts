#!/usr/bin/env tsx
/**
 * Doctor CLI — environment health checks.
 *
 * Usage: saifctl doctor
 *
 * Checks:
 *   1. Docker is running and reachable.
 *   2. Leash CLI (`@strongdm/leash`) is installed (required for default agent mode).
 *   3. Leash daemon image present locally or reachable on the registry.
 *   4. Default coder + test runner images present locally or reachable on the registry.
 *   5. Default Cedar policy file structurally lints (exists, non-empty, has rules).
 *   6. At least one LLM provider API-key env var is set.
 *   7. HATCHET_CLIENT_TOKEN — if unset, reports local mode; if set, tests
 *      gRPC connectivity to HATCHET_SERVER_URL (gated by SAIFCTL_EXPERIMENTAL_HATCHET).
 *   8. Argus reviewer binary download endpoint is reachable (network-only;
 *      does not download). The reviewer binary is fetched on-demand from
 *      GitHub Releases on first use; doctor surfaces unreachability up front.
 */

import { resolve as resolvePath } from 'node:path';

import { defineCommand, runMain } from 'citty';
import { colors } from 'consola/utils';

import { DEFAULT_LEASH_IMAGE, getSaifctlRoot } from '../../constants.js';
import { resolveLeashCliPath } from '../../engines/docker/index.js';
import { PROVIDERS } from '../../llm-config.js';
import { consola } from '../../logger.js';
import { probeArgusReleaseEndpoint } from '../../orchestrator/sidecars/reviewer/argus.js';
import { DEFAULT_SANDBOX_PROFILE } from '../../sandbox-profiles/index.js';
import { DEFAULT_TEST_PROFILE } from '../../test-profiles/index.js';
import { pathExists, readUtf8, spawnCapture, spawnWait } from '../../utils/io.js';

function ok(msg: string) {
  consola.success(msg);
}
function warn(msg: string) {
  consola.warn(msg);
}
function fail(msg: string) {
  consola.error(msg);
}

async function checkDocker(): Promise<boolean> {
  try {
    await spawnCapture({ command: 'docker', args: ['info'], cwd: process.cwd() });
    ok('Docker is running');
    return true;
  } catch {
    fail('Docker is not running or not reachable. Start Docker and try again.');
    return false;
  }
}

async function checkLeashCli(): Promise<boolean> {
  let leashPath: string;
  try {
    leashPath = resolveLeashCliPath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
    return false;
  }
  if (!(await pathExists(leashPath))) {
    fail(`Leash CLI path does not exist: ${leashPath}`);
    return false;
  }
  ok(`Leash CLI OK (${leashPath})`);
  return true;
}

async function checkHatchet(): Promise<boolean> {
  const token = process.env.HATCHET_CLIENT_TOKEN;
  const experimental = process.env.SAIFCTL_EXPERIMENTAL_HATCHET === '1';

  if (!token) {
    warn(
      'HATCHET_CLIENT_TOKEN is not set — saifctl will run in local (in-process) mode.\n' +
        'To enable Hatchet durability + dashboard, see: docs/hatchet.md',
    );
    return true; // Not an error — local mode is a valid configuration.
  }

  // Token is set. v0.1.0 gates the Hatchet path behind SAIFCTL_EXPERIMENTAL_HATCHET=1
  // (per release-readiness Decision D-04). Without the flag, surface this proactively
  // so a green `doctor` doesn't mislead — `feat run` would otherwise throw at dispatch.
  if (!experimental) {
    warn(
      'HATCHET_CLIENT_TOKEN is set but Hatchet integration is gated for v0.1.0.\n' +
        '  Either unset HATCHET_CLIENT_TOKEN to use local (in-process) mode,\n' +
        '  or set SAIFCTL_EXPERIMENTAL_HATCHET=1 to opt in to the experimental path.',
    );
    return true; // Not a hard fail — user just needs to choose a mode.
  }

  ok('HATCHET_CLIENT_TOKEN is set');
  warn('SAIFCTL_EXPERIMENTAL_HATCHET=1 — using experimental Hatchet path (incomplete).');

  const serverUrl = process.env.HATCHET_SERVER_URL ?? 'localhost:7077';

  try {
    // Lazy-import so users without the SDK installed still see the other checks.
    const { getHatchetClient } = await import('../../hatchet/client.js');
    const { isLocal } = getHatchetClient();
    if (isLocal) {
      fail('Hatchet local mode initialized. Expected Hatchet server mode.');
      return false;
    }
    ok(`Hatchet client initialized (server: ${serverUrl})`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Hatchet SDK error: ${message}`);
    fail(
      'Make sure HATCHET_SERVER_URL is correct and the Hatchet server is reachable.\n' +
        'See: docs/hatchet.md',
    );
    return false;
  }
}

async function dockerImagePresentLocally(ref: string): Promise<boolean> {
  const r = await spawnWait({
    command: 'docker',
    args: ['image', 'inspect', ref],
    cwd: process.cwd(),
  });
  return r.code === 0;
}

async function dockerImageReachableRemote(ref: string): Promise<boolean> {
  // `docker buildx imagetools inspect` queries the registry without pulling.
  // Available on every modern Docker (buildx is bundled since 20.10).
  const r = await spawnWait({
    command: 'docker',
    args: ['buildx', 'imagetools', 'inspect', ref],
    cwd: process.cwd(),
  });
  return r.code === 0;
}

async function checkImage(ref: string, label: string): Promise<boolean> {
  if (await dockerImagePresentLocally(ref)) {
    ok(`${label} present locally (${ref})`);
    return true;
  }
  if (await dockerImageReachableRemote(ref)) {
    ok(`${label} not pulled yet but reachable on registry (${ref})`);
    return true;
  }
  warn(
    `${label} not present locally and not reachable on registry: ${ref}\n` +
      '  First `feat run` will fail. Build locally with `pnpm docker build` or pull manually.',
  );
  return true; // soft warning — doctor stays advisory
}

async function checkLeashDaemonImage(): Promise<boolean> {
  return checkImage(DEFAULT_LEASH_IMAGE, 'Leash daemon image');
}

async function checkSandboxImages(): Promise<boolean> {
  const coder = await checkImage(
    DEFAULT_SANDBOX_PROFILE.coderImageTag,
    `Default coder image (${DEFAULT_SANDBOX_PROFILE.id})`,
  );
  const testTag = `saifctl-test-${DEFAULT_TEST_PROFILE.id}:latest`;
  const test = await checkImage(testTag, `Default test runner image (${DEFAULT_TEST_PROFILE.id})`);
  return coder && test;
}

async function checkCedarPolicy(policyPath: string): Promise<boolean> {
  // Structural lint only — real Cedar parse validation requires either the leash
  // CLI (which has no validator subcommand) or @cedar-policy/cedar-wasm (~12 MB,
  // too heavy to bundle). The leash daemon itself parses Cedar at runtime; this
  // check just catches the obvious "wrong path / empty file / missing rules"
  // failure modes early. Real syntax validation is tracked for v1.0.
  if (!(await pathExists(policyPath))) {
    fail(`Cedar policy file not found: ${policyPath}`);
    return false;
  }
  let body: string;
  try {
    body = await readUtf8(policyPath);
  } catch (err) {
    fail(
      `Cedar policy file unreadable: ${policyPath} (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
  if (body.trim().length === 0) {
    fail(`Cedar policy file is empty: ${policyPath}`);
    return false;
  }
  // A valid Cedar policy file contains at least one permit/forbid rule.
  if (!/\b(permit|forbid)\s*\(/.test(body)) {
    warn(
      `Cedar policy file has no permit/forbid rules: ${policyPath}\n` +
        '  This file will compile to an effectively-empty policy (everything default-deny).\n' +
        '  Real syntax validation runs inside the Leash daemon at runtime.',
    );
    return true;
  }
  ok(`Cedar policy structurally valid (${policyPath})`);
  return true;
}

async function checkDefaultCedarPolicy(): Promise<boolean> {
  const defaultPolicy = resolvePath(getSaifctlRoot(), 'src/orchestrator/policies/default.cedar');
  return checkCedarPolicy(defaultPolicy);
}

async function checkLlmEnvVars(): Promise<boolean> {
  // Liveness probe (actual API call) is deferred to v1.0 — per-provider edge cases
  // (Vertex token mint, OpenRouter compat, Ollama local URL detection) and the
  // billing-surprise risk push real liveness past v0.1. This is a presence check:
  // is *any* provider env var from the canonical PROVIDERS table set, so the agent
  // has a key to authenticate with?
  const keyVars = Array.from(new Set(PROVIDERS.map((p) => p.apiKeyEnvVar))).sort();
  const present = keyVars.filter((k) => process.env[k] && process.env[k]!.trim().length > 0);
  if (present.length === 0) {
    // Show only the headline providers in the warning to keep it readable;
    // the full list lives in src/llm-config.ts.
    const headline = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
    ];
    warn(
      'No LLM provider API key env vars set. Agents will fail at first LLM call.\n' +
        '  Expected one of: ' +
        headline.join(', ') +
        ' (or any of the other supported providers — see src/llm-config.ts).',
    );
    return true; // soft warning
  }
  ok(`LLM provider key(s) present: ${present.join(', ')}`);
  return true;
}

async function checkArgusReleaseEndpoint(): Promise<boolean> {
  const probe = await probeArgusReleaseEndpoint();
  if (probe.ok) {
    ok(`Argus reviewer binary endpoint reachable (${probe.url})`);
    return true;
  }
  const detail = probe.status
    ? `HTTP ${probe.status}`
    : probe.error
      ? `network error: ${probe.error}`
      : 'unreachable';
  warn(
    `Argus reviewer binary endpoint not reachable (${detail}).\n` +
      `  Probed: ${probe.url}\n` +
      '  saifctl will try to download the binary on first reviewer run; if your network\n' +
      '  blocks GitHub Releases, the run will fail. Use --no-reviewer to skip the gate.',
  );
  return true; // Not a hard fail — reviewer can be skipped, and this can be a transient blip.
}

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check environment health (Docker, Leash CLI, Hatchet, Argus endpoint)',
  },
  async run() {
    consola.log('');
    consola.log(colors.bold('saifctl doctor'));
    consola.log('');

    const results: boolean[] = [];

    results.push(await checkDocker());
    results.push(await checkLeashCli());
    results.push(await checkLeashDaemonImage());
    results.push(await checkSandboxImages());
    results.push(await checkDefaultCedarPolicy());
    results.push(await checkLlmEnvVars());
    results.push(await checkHatchet());
    results.push(await checkArgusReleaseEndpoint());

    const allPassed = results.every(Boolean);

    consola.log('');
    if (allPassed) {
      consola.success('All checks passed.');
      consola.log('');
    } else {
      consola.error('One or more checks failed. See messages above.');
      consola.log('');
      process.exit(1);
    }
  },
});

export default doctorCommand; // export for `saifctl` root CLI

// Allow running directly: `tsx src/cli/commands/doctor.ts`
if (process.argv[1]?.endsWith('doctor.ts') || process.argv[1]?.endsWith('doctor.js')) {
  await runMain(doctorCommand);
}
