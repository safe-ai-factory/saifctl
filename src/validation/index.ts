/**
 * Check pipeline — Types, Lint, Dead Code, Format, Tests & Coverage, Custom Constraints.
 * Used by CI and for local verification before commit/push.
 *
 * Exported as runCheck() for use by the commands CLI.
 */

import { consola } from '../logger.js';
import { spawnUserCmd, spawnUserCmdCapture } from '../utils/io.js';

const phases = [
  { name: 'Types', command: 'npx tsc --noEmit' },
  { name: 'Lint', command: 'npm run lint' },
  { name: 'Lint Workflows', command: 'npm run lint:workflows' },
  { name: 'Dead Code', command: 'npm run knip' },
  { name: 'Format', command: 'npm run format:check' },
  { name: 'Custom Constraints', command: 'npm run validate' },
  { name: 'Tests & Coverage', command: 'npm run coverage' },
];

async function runPhase(opts: {
  name: string;
  command: string;
  captureOutput: boolean;
}): Promise<string> {
  const { name, command, captureOutput } = opts;
  if (captureOutput) {
    try {
      return await spawnUserCmdCapture(command, { cwd: process.cwd() });
    } catch (error: unknown) {
      const err = error as { output?: string; code?: number; command?: string };
      throw { name, command, output: err.output ?? '', code: err.code ?? 1 };
    }
  }
  try {
    await spawnUserCmd({ script: command, cwd: process.cwd(), stdio: 'inherit' });
    return '';
  } catch (error: unknown) {
    const err = error as Error & { code?: number };
    throw { name, command, output: err.message ?? '', code: err.code ?? 1 };
  }
}

/**
 * Run the check pipeline with optional agent reporter mode.
 * When reporter=agent, stdout is JSON only (status, phase, command, details).
 */
export async function runCheck(opts: { reporter?: string }): Promise<void> {
  const isAgentReporter = opts.reporter === 'agent';

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseName = `Phase ${i + 1}: ${phase.name}`;
    try {
      if (!isAgentReporter) {
        consola.log(`\n--- Running ${phaseName} ---`);
      }
      await runPhase({ name: phaseName, command: phase.command, captureOutput: isAgentReporter });
    } catch (error) {
      const err = error as { code: number; output: string; name: string; command: string };
      if (isAgentReporter) {
        const output = err.output;
        const lines = output.split('\n');
        const lastLines = lines.slice(-50).join('\n').trim();
        consola.log(
          JSON.stringify({
            status: 'FAILED',
            phase: phaseName,
            command: phase.command,
            details: lastLines || 'No output',
          }),
        );
        process.exit(1);
      } else {
        consola.error(`\n❌ ${phaseName} failed with exit code ${err.code}`);
        process.exit(1);
      }
    }
  }

  if (isAgentReporter) {
    consola.log(JSON.stringify({ status: 'PASSED' }));
  } else {
    consola.log('\n✅ All phases passed successfully.');
  }
}
