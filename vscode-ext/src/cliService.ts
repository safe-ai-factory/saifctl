/**
 * CLI execution wrapper for the saifctl command-line tool.
 *
 * Two execution modes:
 * - Background (spawnUserCmdCapture): Quick, non-interactive commands — list runs,
 *   finish feature, remove run. Output parsed without disturbing the workspace.
 * - Terminal (vscode.window.createTerminal): Long-running agent tasks — run,
 *   design, validate. User sees streaming output and can interact.
 */

import { basename, join } from 'node:path';

import * as vscode from 'vscode';

import { resolveCliInvocation, type ResolverLog } from './binaryResolver';
import { logger, saifctlOutputChannel } from './logger';
import { spawnUserCmdCapture } from './userCmdCapture.js';

/** One row from `saifctl run list --format json` */
export interface RunListEntry {
  runId: string;
  featureName: string;
  specRef: string;
  status:
    | 'failed'
    | 'completed'
    | 'running'
    | 'paused'
    | 'inspecting'
    | 'starting'
    | 'pausing'
    | 'stopping'
    | 'resuming';
  startedAt: string;
  updatedAt: string;
  taskId?: string;
}

/** Full artifact from `saifctl run get` (includes runCommits[].diff). */
export interface RunFullArtifact {
  runId: string;
  /** Git commit the run started from (file blobs via `git show <sha>:path`). */
  baseCommitSha?: string;
  runCommits: Array<{ message: string; diff: string; author?: string }>;
  config?: Record<string, unknown>;
  specRef?: string;
  status?: string;
  basePatchDiff?: string;
  [k: string]: unknown;
}

type MockRunRow = RunListEntry & { onlyBasename?: string };

const MOCK_RUN_ROWS: MockRunRow[] = [
  {
    runId: 'run-abc-123',
    featureName: 'Agent_Auth_Attempt_1',
    specRef: 'add-authentication',
    status: 'completed',
    startedAt: '2026-03-20T08:00:00.000Z',
    updatedAt: '2026-03-20T09:15:30.000Z',
    onlyBasename: 'project-alpha',
  },
  {
    runId: 'run-def-456',
    featureName: 'Agent_Auth_Attempt_2',
    specRef: 'add-authentication',
    status: 'failed',
    startedAt: '2026-03-19T17:00:00.000Z',
    updatedAt: '2026-03-19T18:00:00.000Z',
    onlyBasename: 'project-alpha',
  },
  {
    runId: 'run-xyz-789',
    featureName: 'Memory_Refactor',
    specRef: 'add-memory-module',
    status: 'running',
    startedAt: '2026-03-21T12:00:00.000Z',
    updatedAt: '2026-03-21T14:02:00.000Z',
    onlyBasename: 'project-agents',
  },
  {
    runId: 'run-pause-demo',
    featureName: 'Paused_Demo',
    specRef: 'add-memory-module',
    status: 'paused',
    startedAt: '2026-03-21T10:00:00.000Z',
    updatedAt: '2026-03-21T10:30:00.000Z',
    onlyBasename: 'project-agents',
  },
];

function stripMockFilter(r: MockRunRow): RunListEntry {
  const { onlyBasename: _b, ...e } = r;
  return e;
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

  /** Like {@link executeInBackground} but no UI error dialog — for optional fetches (tree expand). */
  private async executeInBackgroundSilent(command: string, cwd: string): Promise<string | null> {
    try {
      logger.info(`Executing (silent): ${command}`);
      const out = await spawnUserCmdCapture(command, { cwd });
      return out.trim();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Command failed (silent): ${command} — ${message}`);
      return null;
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
   * Lists runs via `saifctl run list --format json` (works with any configured storage).
   * When SAIF_MOCK_RUNS=1, returns mock list entries for UI testing.
   */
  public async listRuns(cwd: string): Promise<RunListEntry[]> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return this.getMockRunList(cwd);
    }

    const out = await this.executeInBackground(
      await this.cliCommand(cwd, 'run list --format json --no-pretty'),
      cwd,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(out) as RunListEntry[] | null;
    } catch {
      logger.warn('run list --format json returned non-JSON');
      return [];
    }
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) return [];
    return parsed as RunListEntry[];
  }

  /** Subset JSON from `saifctl run info` (no commit diffs). */
  public async getRunInfo(runId: string, cwd: string): Promise<Record<string, unknown> | null> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return this.getMockRunInfo(runId);
    }
    const out = await this.executeInBackgroundSilent(
      await this.cliCommand(cwd, `run info ${escapeArg(runId)} --no-pretty`),
      cwd,
    );
    if (out === null) return null;
    try {
      return JSON.parse(out) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Full artifact from `saifctl run get` (includes runCommits[].diff). */
  public async getRunFull(runId: string, cwd: string): Promise<RunFullArtifact | null> {
    if (process.env.SAIF_MOCK_RUNS === '1') {
      return this.getMockRunFull(runId);
    }
    const out = await this.executeInBackgroundSilent(
      await this.cliCommand(cwd, `run get ${escapeArg(runId)} --no-pretty`),
      cwd,
    );
    if (out === null) return null;
    try {
      return JSON.parse(out) as RunFullArtifact;
    } catch {
      return null;
    }
  }

  private getMockRunList(cwd: string): RunListEntry[] {
    const key = basename(cwd);
    return MOCK_RUN_ROWS.filter((r) => !r.onlyBasename || r.onlyBasename === key).map(
      stripMockFilter,
    );
  }

  private getMockRunInfo(runId: string): Record<string, unknown> | null {
    const row = MOCK_RUN_ROWS.map(stripMockFilter).find((r) => r.runId === runId);
    if (!row) return null;
    return {
      runId: row.runId,
      status: row.status,
      specRef: row.specRef,
      config: {
        featureName: row.featureName,
        model: 'gpt-4o',
        projectDir: row.runId.includes('abc') ? '/tmp/project-alpha' : '/tmp/project-agents',
      },
    };
  }

  private getMockRunFull(runId: string): RunFullArtifact | null {
    const info = this.getMockRunInfo(runId);
    if (!info) return null;
    const samplePatch = `diff --git a/src/mock.ts b/src/mock.ts
index 111..222 100644
--- a/src/mock.ts
+++ b/src/mock.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
 unchanged
diff --git /dev/null b/readme-mock.md
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/readme-mock.md
@@ -0,0 +1,1 @@
+# mock
`;
    return {
      runId,
      baseCommitSha: 'HEAD',
      basePatchDiff: '',
      runCommits: [{ message: 'mock commit', diff: samplePatch }],
      config: (info.config as Record<string, unknown>) ?? {},
      specRef: String(info.specRef ?? ''),
      status: String(info.status ?? ''),
    };
  }

  public async fromArtifact(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run start ${escapeArg(runId)}`),
      terminalName: `SaifCTL start: ${runId}`,
      cwd,
    });
  }

  /** Idle coding container for a saved run (`saifctl run inspect`). */
  public async inspectRun(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run inspect ${escapeArg(runId)}`),
      terminalName: `SaifCTL inspect: ${runId}`,
      cwd,
    });
  }

  /** Re-run tests for a saved run without the agent (`saifctl run test`). */
  public async testRun(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run test ${escapeArg(runId)}`),
      terminalName: `SaifCTL test: ${runId}`,
      cwd,
    });
  }

  /** Apply run commits to the host repo as a branch (`saifctl run apply`). */
  public async applyRun(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run apply ${escapeArg(runId)}`),
      terminalName: `SaifCTL apply: ${runId}`,
      cwd,
    });
  }

  /** Export run as a patch file (`saifctl run export`). */
  public async exportRun(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run export ${escapeArg(runId)}`),
      terminalName: `SaifCTL export: ${runId}`,
      cwd,
    });
  }

  /**
   * Fetch full run JSON (`saifctl run get`) and save to a path chosen by the user.
   */
  public async downloadRun(runId: string, cwd: string): Promise<void> {
    const json = await this.executeInBackground(
      await this.cliCommand(cwd, `run get ${escapeArg(runId)}`),
      cwd,
    );
    const defaultPath = join(cwd, `saifctl-run-${runId}.json`);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultPath),
      filters: { JSON: ['json'] },
      saveLabel: 'Save',
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
    vscode.window.showInformationMessage(`Saved run artifact to ${uri.fsPath}`);
  }

  /**
   * Duplicate run (`saifctl run fork`). Runs in the background so callers can refresh the UI when it finishes.
   */
  public async forkRun(runId: string, cwd: string): Promise<void> {
    const out = await this.executeInBackground(
      await this.cliCommand(cwd, `run fork ${escapeArg(runId)}`),
      cwd,
    );
    const forkLine = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('Forked run'));
    vscode.window.showInformationMessage(forkLine ?? `Forked run from ${runId}.`);
  }

  public async removeRun(runId: string, cwd: string): Promise<void> {
    await this.executeInBackground(await this.cliCommand(cwd, `run rm ${escapeArg(runId)}`), cwd);
    vscode.window.showInformationMessage(`Removed run: ${runId}`);
  }

  public async clearAllRuns(cwd: string): Promise<void> {
    await this.executeInBackground(await this.cliCommand(cwd, 'run clear'), cwd);
    vscode.window.showInformationMessage('Cleared all SaifCTL runs.');
  }

  /** Pause a running run (`saifctl run pause`). */
  public async pauseRun(runId: string, cwd: string): Promise<void> {
    await this.executeInBackground(
      await this.cliCommand(cwd, `run pause ${escapeArg(runId)}`),
      cwd,
    );
    vscode.window.showInformationMessage(`Pause requested for run: ${runId}`);
  }

  /** Stop a running or paused run (`saifctl run stop`). */
  public async stopRun(runId: string, cwd: string): Promise<void> {
    await this.executeInBackground(await this.cliCommand(cwd, `run stop ${escapeArg(runId)}`), cwd);
    vscode.window.showInformationMessage(`Stop requested for run: ${runId}`);
  }

  /** Resume a paused run in the terminal (`saifctl run resume`). */
  public async resumeRun(runId: string, cwd: string): Promise<void> {
    this.executeInTerminal({
      command: await this.cliCommand(cwd, `run resume ${escapeArg(runId)}`),
      terminalName: `SaifCTL resume: ${runId}`,
      cwd,
    });
  }
}

/** Escapes a string for safe use in shell commands. */
function escapeArg(s: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
