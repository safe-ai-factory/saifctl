/**
 * CLI execution wrapper for the saifctl command-line tool.
 *
 * Two execution modes:
 * - Background (spawnUserCmdCapture): Quick, non-interactive commands — list runs,
 *   finish feature, remove run. Output parsed without disturbing the workspace.
 * - Terminal (vscode.window.createTerminal): Long-running agent tasks — run,
 *   design, validate. User sees streaming output and can interact.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { resolveCliInvocation, type ResolverLog } from './binaryResolver';
import { logger, saifctlOutputChannel } from './logger';
import { spawnUserCmdCapture } from './userCmdCapture.js';

/** Run artifact shape when reading from .saifctl/runs/*.json */
interface RunArtifact {
  runId: string;
  status: 'failed' | 'completed' | 'running' | 'paused';
  config: { featureName: string; projectDir?: string; [k: string]: unknown };
  specRef?: string;
  updatedAt?: string;
}

export class SaifctlCliService {
  private terminals: Map<string, vscode.Terminal> = new Map();
  private resolvedInvocationCache = new Map<string, string>();

  /** Drop cached `saifctl` invocation strings (e.g. after install or settings change). */
  public invalidateCache(): void {
    this.resolvedInvocationCache.clear();
  }

  private makeResolverLog(verbose: boolean): ResolverLog {
    return verbose
      ? {
          trace: (m) => logger.trace(m),
          debug: (m) => logger.debug(m),
          info: (m) => logger.info(m),
        }
      : { info: (m) => logger.info(m) };
  }

  private async getCliInvocation(cwd: string): Promise<string> {
    const verbose = vscode.workspace.getConfiguration('saifctl').get<boolean>('verbose', false);
    const log = this.makeResolverLog(verbose);

    const cached = this.resolvedInvocationCache.get(cwd);
    if (cached !== undefined) {
      logger.info(`CLI invocation (cached): ${JSON.stringify(cached)} (cwd=${cwd})`);
      return cached;
    }

    const userPath = vscode.workspace.getConfiguration('saifctl').get<string>('binaryPath', '');
    const override = (userPath ?? '').trim();
    const resolved = await resolveCliInvocation({
      cwd,
      userBinaryPath: userPath ?? '',
      log,
    });

    logger.info(`CLI invocation resolved: ${JSON.stringify(resolved)} (cwd=${cwd})`);

    if (resolved === 'saifctl' && !override) {
      logger.info(
        'No local saifctl binary under cwd or parents; using plain "saifctl" (global PATH). Set saifctl.binaryPath or install locally.',
      );
    }

    this.resolvedInvocationCache.set(cwd, resolved);
    return resolved;
  }

  /** Full shell command: resolved prefix + subcommands and arguments. */
  private async cliCommand(cwd: string, subcommandsAndArgs: string): Promise<string> {
    const p = await this.getCliInvocation(cwd);
    return subcommandsAndArgs ? `${p} ${subcommandsAndArgs}` : p;
  }

  /**
   * Checks if the saifctl CLI is installed and reachable using the configured command.
   * Returns true when SAIF_MOCK_RUNS=1 (allows UI testing without the CLI).
   */
  public async isCliInstalled(cwd: string): Promise<boolean> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return true;
    }
    try {
      await spawnUserCmdCapture(await this.cliCommand(cwd, 'version'), { cwd });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Executes a command silently in the background.
   * Use for quick commands where we need output or success confirmation.
   */
  private async executeInBackground(command: string, cwd: string): Promise<string> {
    try {
      logger.info(`Executing: ${command}`);
      logger.debug(`CWD: ${cwd}`);

      const out = await spawnUserCmdCapture(command, { cwd });
      logger.trace(`Output: ${out}`);
      return out.trim();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error(`Command failed: ${command}`);
      logger.error(`Error details: ${message}`);
      if (stack) logger.error(stack);

      const selection = await vscode.window.showErrorMessage(
        'SaifCTL error: Failed to execute command.',
        'View Logs',
      );
      if (selection === 'View Logs') {
        saifctlOutputChannel.show();
      }
      throw error;
    }
  }

  /**
   * Executes a command in a visible VS Code Terminal.
   * Use for long-running agent processes (run, design, validate).
   */
  private executeInTerminal(opts: { command: string; terminalName: string; cwd: string }): void {
    const { command, terminalName, cwd } = opts;
    let terminal = this.terminals.get(terminalName);

    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({
        name: terminalName,
        cwd,
      });
      this.terminals.set(terminalName, terminal);
    }

    terminal.show(false);
    terminal.sendText(command);
  }

  // ============================================================================
  // Feature Management
  // ============================================================================

  public async createFeature(featureName: string, cwd: string): Promise<void> {
    await this.executeInBackground(
      await this.cliCommand(cwd, `feat new -y -n ${escapeArg(featureName)}`),
      cwd,
    );
    vscode.window.showInformationMessage(`Created new feature: ${featureName}`);
  }

  public async runFeature(featureName: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `feat run -n ${escapeArg(featureName)}`),
      terminalName: `SaifCTL run: ${featureName}`,
      cwd,
    });
  }

  public async designFeature(featureName: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `feat design -y -n ${escapeArg(featureName)}`),
      terminalName: `SaifCTL design: ${featureName}`,
      cwd,
    });
  }

  public async designFeatureSpecsOnly(featureName: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `feat design-specs -y -n ${escapeArg(featureName)}`),
      terminalName: `SaifCTL design-specs: ${featureName}`,
      cwd,
    });
  }

  public async validateFeatureTests(featureName: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `feat design-fail2pass -y -n ${escapeArg(featureName)}`),
      terminalName: `SaifCTL validate tests: ${featureName}`,
      cwd,
    });
  }

  // ============================================================================
  // Run Management
  // ============================================================================

  /**
   * Lists Runs by reading .saifctl/runs/*.json directly.
   * Avoids relying on CLI --json output.
   *
   * When SAIF_MOCK_RUNS=1, returns hardcoded mock data for UI testing without
   * the saifctl CLI or .saifctl/runs/ present.
   */
  public async listRuns(cwd: string): Promise<RunArtifact[]> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return this.getMockRuns(cwd);
    }

    const runsDir = join(cwd, '.saifctl', 'runs');
    let files: string[];
    try {
      files = await readdir(runsDir);
    } catch {
      return [];
    }

    const results: RunArtifact[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const filePath = join(runsDir, f);
        const raw = await readFile(filePath, 'utf8');
        const artifact = JSON.parse(raw) as RunArtifact;
        if (artifact.runId && artifact.config?.featureName != null) {
          results.push(artifact);
        }
      } catch {
        // Skip malformed files
      }
    }
    return results.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** TEMP: Mock runs for UI testing. Use SAIF_MOCK_RUNS=1 when launching. */
  private getMockRuns(_cwd: string): RunArtifact[] {
    return [
      {
        runId: 'run-abc-123',
        status: 'completed',
        config: {
          featureName: 'Agent_Auth_Attempt_1',
          projectDir: 'project-alpha',
          model: 'gpt-4o',
          temp: '0.7',
          agents: '2',
        },
        specRef: 'add-authentication',
      },
      {
        runId: 'run-def-456',
        status: 'failed',
        config: {
          featureName: 'Agent_Auth_Attempt_2',
          projectDir: 'project-alpha',
          model: 'claude-3-5-sonnet',
          temp: '0.2',
        },
        specRef: 'add-authentication',
      },
      {
        runId: 'run-xyz-789',
        status: 'running',
        config: {
          featureName: 'Memory_Refactor',
          projectDir: 'project-agents',
          model: 'gpt-4o',
          agents: '5',
        },
        specRef: 'add-memory-module',
      },
    ] as RunArtifact[];
  }

  public async fromArtifact(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run start ${escapeArg(runId)}`),
      terminalName: `SaifCTL fromArtifact: ${runId}`,
      cwd,
    });
  }

  public async removeRun(runId: string, cwd: string): Promise<void> {
    await this.executeInBackground(await this.cliCommand(cwd, `run rm ${escapeArg(runId)}`), cwd);
    vscode.window.showInformationMessage(`Removed run: ${runId}`);
  }

  public async clearAllRuns(cwd: string): Promise<void> {
    await this.executeInBackground(await this.cliCommand(cwd, 'run clear'), cwd);
    vscode.window.showInformationMessage('Cleared all SaifCTL runs.');
  }
}

/** Escapes a string for safe use in shell commands. */
function escapeArg(s: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
