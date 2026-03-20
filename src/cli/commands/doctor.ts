#!/usr/bin/env tsx
/**
 * Doctor CLI — environment health checks.
 *
 * Usage: saifac doctor
 *
 * Checks:
 *   1. Docker is running and reachable.
 *   2. HATCHET_CLIENT_TOKEN — if unset, reports local mode; if set, tests
 *      gRPC connectivity to HATCHET_SERVER_URL.
 */

import { execSync } from 'node:child_process';

import { defineCommand, runMain } from 'citty';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

function ok(msg: string) {
  process.stdout.write(`  ${GREEN}✔${RESET}  ${msg}\n`);
}
function warn(msg: string) {
  process.stdout.write(`  ${YELLOW}⚠${RESET}  ${msg}\n`);
}
function fail(msg: string) {
  process.stdout.write(`  ${RED}✘${RESET}  ${msg}\n`);
}

function checkDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    ok('Docker is running');
    return true;
  } catch {
    fail('Docker is not running or not reachable. Start Docker and try again.');
    return false;
  }
}

async function checkHatchet(): Promise<boolean> {
  const token = process.env.HATCHET_CLIENT_TOKEN;

  if (!token) {
    warn(
      'HATCHET_CLIENT_TOKEN is not set — saifac will run in local (in-process) mode.\n' +
        '         To enable Hatchet durability + dashboard, see: docs/hatchet.md',
    );
    return true; // Not an error — local mode is a valid configuration.
  }

  ok('HATCHET_CLIENT_TOKEN is set');

  const serverUrl = process.env.HATCHET_SERVER_URL ?? 'localhost:7077';

  try {
    // Lazy-import so users without the SDK installed still see the other checks.
    const { getHatchetClient } = await import('../../hatchet/client.js');
    const hatchet = getHatchetClient();
    if (!hatchet) {
      fail('Hatchet client could not be initialized (token set but SDK returned null).');
      return false;
    }
    ok(`Hatchet client initialized (server: ${serverUrl})`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Hatchet SDK error: ${message}`);
    fail(
      'Make sure HATCHET_SERVER_URL is correct and the Hatchet server is reachable.\n' +
        '         See: docs/hatchet.md',
    );
    return false;
  }
}

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check environment health (Docker, Hatchet connectivity)',
  },
  async run() {
    process.stdout.write(`\n${BOLD}saifac doctor${RESET}\n\n`);

    const results: boolean[] = [];

    results.push(checkDocker());
    results.push(await checkHatchet());

    const allPassed = results.every(Boolean);

    process.stdout.write('\n');
    if (allPassed) {
      process.stdout.write(`${GREEN}All checks passed.${RESET}\n\n`);
    } else {
      process.stdout.write(`${RED}One or more checks failed. See messages above.${RESET}\n\n`);
      process.exit(1);
    }
  },
});

export default doctorCommand; // export for `saifac` root CLI

// Allow running directly: `tsx src/cli/commands/doctor.ts`
if (process.argv[1]?.endsWith('doctor.ts') || process.argv[1]?.endsWith('doctor.js')) {
  await runMain(doctorCommand);
}
