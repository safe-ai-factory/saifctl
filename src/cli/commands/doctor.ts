#!/usr/bin/env tsx
/**
 * Doctor CLI — environment health checks.
 *
 * Usage: saifctl doctor
 *
 * Checks:
 *   1. Docker is running and reachable.
 *   2. Leash CLI (`@strongdm/leash`) is installed (required for default agent mode).
 *   3. HATCHET_CLIENT_TOKEN — if unset, reports local mode; if set, tests
 *      gRPC connectivity to HATCHET_SERVER_URL.
 */

import { defineCommand, runMain } from 'citty';
import { colors } from 'consola/utils';

import { resolveLeashCliPath } from '../../engines/docker/index.js';
import { consola } from '../../logger.js';
import { pathExists, spawnCapture } from '../../utils/io.js';

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

  if (!token) {
    warn(
      'HATCHET_CLIENT_TOKEN is not set — saifctl will run in local (in-process) mode.\n' +
        'To enable Hatchet durability + dashboard, see: docs/hatchet.md',
    );
    return true; // Not an error — local mode is a valid configuration.
  }

  ok('HATCHET_CLIENT_TOKEN is set');

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

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check environment health (Docker, Leash CLI, Hatchet)',
  },
  async run() {
    consola.log('');
    consola.log(colors.bold('saifctl doctor'));
    consola.log('');

    const results: boolean[] = [];

    results.push(await checkDocker());
    results.push(await checkLeashCli());
    results.push(await checkHatchet());

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
