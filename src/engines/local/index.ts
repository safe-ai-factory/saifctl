/**
 * LocalEngine — runs the coding agent on the host (no container / Leash).
 *
 * Used when `environments.coding.engine` is `local` (e.g. via `--engine local`).
 * Staging and tests still use {@link DockerEngine} or a future HelmEngine.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { consola } from '../../logger.js';
import type {
  Engine,
  EnginePauseInfraOpts,
  EngineResumeInfraOpts,
  EngineSetupOpts,
  EngineSetupResult,
  EngineTeardownOpts,
  EngineVerifyResumeInfraOpts,
  RunAgentEngineResult,
  RunAgentOpts,
  RunTestsEngineResult,
  RunTestsOpts,
  StartStagingOpts,
  StartStagingResult,
} from '../types.js';

const LOCAL_INFRA = { engine: 'local' as const };

export class LocalEngine implements Engine {
  readonly name = 'local' as const;

  async setup(_opts: EngineSetupOpts): Promise<EngineSetupResult> {
    return { infra: LOCAL_INFRA };
  }

  async teardown(opts: EngineTeardownOpts): Promise<void> {
    if (opts.infra === null) {
      // If we got here, setup() failed before returning infra.
      // Which obviously is irrelevant for local engine.
      return;
    }
    // Nothing else to tear down for host coding.
  }

  async pauseInfra(_opts: EnginePauseInfraOpts): Promise<void> {
    // noop
  }

  async resumeInfra(_opts: EngineResumeInfraOpts): Promise<void> {
    // Host coding — no compose stack to unpause (orchestrator still calls this on fromArtifact resume).
  }

  async verifyInfraToResume(_opts: EngineVerifyResumeInfraOpts): Promise<boolean> {
    // Host coding has no external infra; the sandbox directory check in runResumeCore is sufficient.
    return true;
  }

  async startStaging(_opts: StartStagingOpts): Promise<StartStagingResult> {
    throw new Error(
      '[engine] LocalEngine does not support staging. Use docker or helm for environments.staging.',
    );
  }

  async runTests(_opts: RunTestsOpts): Promise<RunTestsEngineResult> {
    throw new Error(
      '[engine] LocalEngine does not support tests. Use docker or helm for environments.staging.',
    );
  }

  async runAgent(opts: RunAgentOpts): Promise<RunAgentEngineResult> {
    if (opts.inspectMode) {
      throw new Error(
        '[engine] run inspect needs a container coding engine. Use --engine coding=docker (or omit --engine local) for inspect.',
      );
    }

    const {
      codePath,
      containerEnv,
      saifctlPath,
      signal,
      onAgentStdout,
      onAgentStdoutEnd,
      onLog,
      runId,
    } = opts;

    const coderStartHost = join(saifctlPath, 'coder-start.sh');
    const cmd = 'bash';
    const args = [coderStartHost];
    const argsForPrint = [coderStartHost];

    consola.log('[agent-runner] Mode: local engine (host execution, filesystem sandbox only)');

    consola.debug(`[agent-runner] containerEnv (public): ${JSON.stringify(containerEnv.env)}`);
    consola.debug(
      `[agent-runner] containerEnv.secret keys: ${Object.keys(containerEnv.secretEnv).sort().join(', ')}`,
    );

    consola.log(`[agent-runner] Starting agent (run ID: ${runId})`);
    consola.log(
      `[agent-runner] Command: ${cmd} ${argsForPrint.map((s) => s.slice(0, 100)).join(' ')}`,
    );

    const spawnEnv: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
      ),
      ...containerEnv.env,
      ...containerEnv.secretEnv,
    };

    const timeoutMs = 20 * 60 * 1000;

    const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
      (resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: codePath,
          env: spawnEnv,
          stdio: ['inherit', 'pipe', 'pipe'],
        });

        let collected = '';
        const endAgentStdout = (): void => onAgentStdoutEnd?.();

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          collected += text;
          onAgentStdout(text);
        });

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          onLog({ source: 'coder', stream: 'stderr', raw: text });
          collected += text;
        });

        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          clearTimeout(timer);
          const abortReason =
            signal?.reason != null ? ` (reason: ${String(signal.reason)})` : '';
          reject(new Error(`Agent step cancelled via abort signal${abortReason}`));
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        child.on('error', (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          endAgentStdout();
          reject(err);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          endAgentStdout();
          resolve({ exitCode: code ?? 1, output: collected });
        });
      },
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      consola.error(`[agent-runner] Process error: ${msg}`);
      return { exitCode: 1, output: msg };
    });

    consola.log(`[agent-runner] Finished with exit code ${exitCode}`);
    return {
      agent: { success: exitCode === 0, exitCode, output },
      infra: opts.infra,
    };
  }
}
