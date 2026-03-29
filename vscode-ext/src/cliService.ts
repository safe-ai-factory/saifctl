/**
 * CLI execution wrapper for the saifctl command-line tool.
 *
 * Two execution modes:
 * - Background (spawnUserCmdCapture): Quick, non-interactive commands — list runs,
 *   finish feature, remove run. Output parsed without disturbing the workspace.
 * - Terminal (vscode.window.createTerminal): Long-running agent tasks — run,
 *   debug, design. User sees streaming output and can interact.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { saifctlLogger } from './logger';
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

  /**
   * Checks if the `saifctl` CLI is installed and accessible in the system PATH.
   * Returns true when SAIF_MOCK_RUNS=1 (allows UI testing without the CLI).
   */
  public async isCliInstalled(): Promise<boolean> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return true;
    }
    try {
      await spawnUserCmdCapture('saifctl --help', { cwd: process.cwd() });
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
      saifctlLogger.info(`Executing: ${command}`);
      saifctlLogger.debug(`CWD: ${cwd}`);

      const out = await spawnUserCmdCapture(command, { cwd });
      saifctlLogger.trace(`Output: ${out}`);
      return out.trim();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      saifctlLogger.error(`Command failed: ${command}`);
      saifctlLogger.error(`Error details: ${message}`);
      if (stack) saifctlLogger.error(stack);

      const selection = await vscode.window.showErrorMessage(
        'SaifCTL error: Failed to execute command.',
        'View Logs',
      );
      if (selection === 'View Logs') {
        saifctlLogger.show();
      }
      throw error;
    }
  }

  /**
   * Executes a command in a visible VS Code Terminal.
   * Use for long-running agent processes (run, debug, design).
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
    await this.executeInBackground(`saifctl feat new -y -n ${escapeArg(featureName)}`, cwd);
    vscode.window.showInformationMessage(`Created new feature: ${featureName}`);
  }

  public runFeature(featureName: string, cwd: string): void {
    this.executeInTerminal({
      command: `saifctl feat run ${escapeArg(featureName)}`,
      terminalName: `SaifCTL run: ${featureName}`,
      cwd,
    });
  }

  public designFeature(featureName: string, cwd: string): void {
    this.executeInTerminal({
      command: `saifctl feat design ${escapeArg(featureName)}`,
      terminalName: `SaifCTL design: ${featureName}`,
      cwd,
    });
  }

  // ============================================================================
  // Run Management
  // ============================================================================

  /**
   * Lists stored runs by reading .saifctl/runs/*.json directly.
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

  public fromArtifact(runId: string, cwd: string): void {
    this.executeInTerminal({
      command: `saifctl run start ${escapeArg(runId)}`,
      terminalName: `SaifCTL fromArtifact: ${runId}`,
      cwd,
    });
  }

  public async removeRun(runId: string, cwd: string): Promise<void> {
    await this.executeInBackground(`saifctl run rm ${escapeArg(runId)}`, cwd);
    vscode.window.showInformationMessage(`Removed run: ${runId}`);
  }

  public async clearAllRuns(cwd: string): Promise<void> {
    await this.executeInBackground('saifctl run clear', cwd);
    vscode.window.showInformationMessage('Cleared all SaifCTL runs.');
  }
}

/** Escapes a string for safe use in shell commands. */
function escapeArg(s: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
