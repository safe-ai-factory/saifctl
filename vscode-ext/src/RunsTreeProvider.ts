/**
 * Tree provider for the Runs view.
 *
 * Hierarchy: Projects -> Runs -> Status / Feature / Config (collapsible) -> config keys.
 * Uses ThemeIcon with ThemeColor for status dots (green/red).
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { type SaifctlCliService } from './cliService';
import { discoverSaifctlProjects } from './projectDiscovery';

/** Config keys omitted from the tree (large script bodies, file path mirrors). */
const HIDDEN_CONFIG_KEYS = new Set([
  'gateScript',
  'startupScript',
  'agentInstallScript',
  'agentScript',
  'stageScript',
  'startupScriptFile',
  'gateScriptFile',
  'stageScriptFile',
  'testScriptFile',
  'agentInstallScriptFile',
  'agentScriptFile',
]);

/** Raw artifact shape from .saifctl/runs/*.json (subset of full RunArtifact) */
interface RunArtifactRaw {
  runId: string;
  status: 'failed' | 'completed' | 'running' | 'paused';
  config?: { featureName: string; projectDir?: string; [k: string]: unknown };
  specRef?: string;
  updatedAt?: string;
}

export interface SaifctlRunData {
  id: string;
  name: string;
  /** Absolute path to the SaifCTL project (parent of `saifctl/`) — CLI cwd */
  projectPath: string;
  /** Same label as Features tree project node */
  projectLabel: string;
  status: RunArtifactRaw['status'];
  specRef: string;
  config: Record<string, string>;
}

export type RunTreeElement =
  | RunProjectItem
  | RunItem
  | RunStatusItem
  | RunFeatureItem
  | RunConfigGroupItem
  | RunConfigKeyItem;

export class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunTreeElement | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RunTreeElement | undefined | void> =
    this._onDidChangeTreeData.event;

  private runsCache: SaifctlRunData[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly cliService: SaifctlCliService,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RunTreeElement): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RunTreeElement): Promise<RunTreeElement[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      try {
        // Single VSCode workspace may contain directories,
        // and those may contain multiple SaifCTL projects at different depths.
        // discoverSaifctlProjects already finds all projects.
        // We then, for each SaifCTL project, list all runs and merge them into a single list.
        const projects = await discoverSaifctlProjects(this.workspaceRoot);
        const merged: SaifctlRunData[] = [];
        for (const p of projects) {
          const raw = await this.cliService.listRuns(p.projectPath);
          for (const a of raw) {
            merged.push(
              toSaifctlRunData(a as RunArtifactRaw, {
                projectPath: p.projectPath,
                projectLabel: p.name,
              }),
            );
          }
        }
        this.runsCache = merged;
        return projects.map((p) => new RunProjectItem(p.name, p.projectPath));
      } catch {
        vscode.window.showErrorMessage('Failed to fetch SaifCTL runs.');
        return [];
      }
    }

    if (element instanceof RunProjectItem) {
      const projectRuns = this.runsCache.filter((run) => run.projectPath === element.projectPath);
      return projectRuns.map((run) => new RunItem(run, run.projectPath));
    }

    if (element instanceof RunItem) {
      return this.getRunMetadata(element.runData);
    }

    if (element instanceof RunConfigGroupItem) {
      return element.entries.map(([key, value]) => new RunConfigKeyItem(key, value));
    }

    return [];
  }

  private getRunMetadata(run: SaifctlRunData): RunTreeElement[] {
    const entries = visibleConfigEntries(run.config);
    const configGroup = new RunConfigGroupItem(entries, run.config);
    return [new RunStatusItem(run.status), new RunFeatureItem(run.specRef), configGroup];
  }
}

function visibleConfigEntries(config: Record<string, string>): [string, string][] {
  return Object.entries(config)
    .filter(([k]) => !HIDDEN_CONFIG_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Turn {@link SaifctlRunData#config} (each value is a JSON fragment) into pretty-printed JSON
 * for the whole object.
 */
export function formatRunConfigAsPrettyJson(config: Record<string, string>): string {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    try {
      obj[k] = JSON.parse(v) as unknown;
    } catch {
      obj[k] = v;
    }
  }
  return JSON.stringify(obj, null, 2);
}

function toSaifctlRunData(
  a: RunArtifactRaw,
  project: { projectPath: string; projectLabel: string },
): SaifctlRunData {
  const cfg = a.config ?? ({} as NonNullable<RunArtifactRaw['config']>);
  const featureName = typeof cfg.featureName === 'string' ? cfg.featureName : a.runId;
  const specRef = a.specRef ?? '';
  const specName = specRef ? path.basename(specRef) : featureName;

  const config: Record<string, string> = {};
  if (cfg && typeof cfg === 'object') {
    for (const [k, v] of Object.entries(cfg)) {
      if (v === undefined) continue;
      try {
        const s = JSON.stringify(v);
        if (s !== undefined) config[k] = s;
      } catch {
        config[k] = JSON.stringify(String(v));
      }
    }
  }

  return {
    id: a.runId,
    name: featureName,
    projectPath: project.projectPath,
    projectLabel: project.projectLabel,
    status: a.status,
    specRef: specName,
    config,
  };
}

function statusIconPath(status: SaifctlRunData['status']): vscode.ThemeIcon {
  if (status === 'completed') {
    return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  }
  if (status === 'failed') {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  }
  if (status === 'paused') {
    return new vscode.ThemeIcon('debug-pause');
  }
  return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('testing.iconQueued'));
}

// ============================================================================
// TreeItem Definitions
// ============================================================================

export class RunProjectItem extends vscode.TreeItem {
  constructor(
    public readonly projectLabel: string,
    public readonly projectPath: string,
  ) {
    super(projectLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.tooltip = `Runs for project: ${projectLabel}\n${projectPath}`;
    this.contextValue = 'runProject';
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

export class RunItem extends vscode.TreeItem {
  public readonly projectPath: string;

  constructor(
    public readonly runData: SaifctlRunData,
    projectPath: string,
  ) {
    super(`${runData.name} (${runData.id})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = runData.id;
    this.projectPath = projectPath;
    this.tooltip = `Run ID: ${runData.id}\nStatus: ${runData.status}\nProject: ${projectPath}`;
    this.contextValue = `run_${runData.status}`;

    this.iconPath = statusIconPath(runData.status);
  }
}

export class RunStatusItem extends vscode.TreeItem {
  constructor(public readonly status: SaifctlRunData['status']) {
    super('Status', vscode.TreeItemCollapsibleState.None);
    this.description = status;
    this.tooltip = `Run status: ${status}`;
    this.contextValue = 'runMeta_status';
    this.iconPath = statusIconPath(status);
  }
}

export class RunFeatureItem extends vscode.TreeItem {
  constructor(public readonly featureName: string) {
    super('Feature', vscode.TreeItemCollapsibleState.None);
    this.description = featureName || 'None';
    this.tooltip = `Feature: ${featureName || 'None'}`;
    this.contextValue = 'runMeta_specRef';
    this.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
  }
}

export class RunConfigGroupItem extends vscode.TreeItem {
  /** Sorted visible key-value pairs (scripts stripped). */
  public readonly entries: [string, string][];
  /** Full artifact config (all keys), for copy-as-JSON. */
  public readonly fullConfig: Record<string, string>;

  constructor(entries: [string, string][], fullConfig: Record<string, string>) {
    super('Config', vscode.TreeItemCollapsibleState.Collapsed);
    this.entries = entries;
    this.fullConfig = fullConfig;
    this.description = entries.length === 0 ? 'default' : `${entries.length} keys`;
    this.tooltip =
      entries.length === 0
        ? 'No config keys in artifact (default)'
        : `Run configuration (${entries.length} entries)`;
    this.contextValue = 'runMeta_configGroup';
    this.iconPath = new vscode.ThemeIcon('settings-gear');
  }
}

export class RunConfigKeyItem extends vscode.TreeItem {
  constructor(
    public readonly configKey: string,
    public readonly configValue: string,
  ) {
    super(configKey, vscode.TreeItemCollapsibleState.None);
    this.description = configValue;
    this.tooltip = `${configKey}: ${configValue}`;
    this.contextValue = 'runMeta_configKey';
    this.iconPath = new vscode.ThemeIcon('symbol-field');
  }
}
