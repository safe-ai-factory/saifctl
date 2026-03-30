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

/** Config keys omitted from the tree (large script/policy bodies only; *File paths stay visible). */
const HIDDEN_CONFIG_KEYS = new Set([
  'gateScript',
  'startupScript',
  'agentInstallScript',
  'agentScript',
  'stageScript',
  'testScript',
  'cedarScript',
]);

export type RunStatus = 'failed' | 'completed' | 'running' | 'paused';

/** Raw artifact shape from .saifctl/runs/*.json (subset of full RunArtifact) */
interface RunArtifactRaw {
  runId: string;
  status: RunStatus;
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
  status: RunStatus;
  specRef: string;
  /** Deep clone of artifact `config` (SerializedLoopOpts-shaped JSON). */
  artifactConfig: Record<string, unknown>;
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
  private _filterText = '';
  private _filterStatuses = new Set<RunStatus>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly cliService: SaifctlCliService,
  ) {}

  get filterText(): string {
    return this._filterText;
  }

  /** Copy of selected status filters (empty = no status filter). */
  get filterStatuses(): ReadonlySet<RunStatus> {
    return new Set(this._filterStatuses);
  }

  get isFiltered(): boolean {
    return this._filterText.trim() !== '' || this._filterStatuses.size > 0;
  }

  setFilter(text: string, statuses: Set<RunStatus>): void {
    this._filterText = text;
    this._filterStatuses = statuses;
    this._onDidChangeTreeData.fire();
  }

  clearFilter(): void {
    this._filterText = '';
    this._filterStatuses = new Set();
    this._onDidChangeTreeData.fire();
  }

  private matchesFilter(run: SaifctlRunData): boolean {
    const needle = this._filterText.trim().toLowerCase();
    const textOk =
      needle === '' ||
      run.name.toLowerCase().includes(needle) ||
      run.id.toLowerCase().includes(needle);
    const statusOk = this._filterStatuses.size === 0 || this._filterStatuses.has(run.status);
    return textOk && statusOk;
  }

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
        if (!this.isFiltered) {
          return projects.map((p) => new RunProjectItem(p.name, p.projectPath));
        }
        return projects
          .filter((p) =>
            this.runsCache.some((r) => r.projectPath === p.projectPath && this.matchesFilter(r)),
          )
          .map((p) => new RunProjectItem(p.name, p.projectPath));
      } catch {
        vscode.window.showErrorMessage('Failed to fetch SaifCTL runs.');
        return [];
      }
    }

    if (element instanceof RunProjectItem) {
      const projectRuns = this.runsCache.filter(
        (run) => run.projectPath === element.projectPath && this.matchesFilter(run),
      );
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
    const entries = visibleConfigEntries(run.artifactConfig);
    const configGroup = new RunConfigGroupItem({
      entries,
      artifactConfig: run.artifactConfig,
      projectPath: run.projectPath,
    });
    return [new RunStatusItem(run.status), new RunFeatureItem(run.specRef), configGroup];
  }
}

function visibleConfigEntries(config: Record<string, unknown>): [string, string][] {
  return Object.entries(config)
    .filter(([k]) => !HIDDEN_CONFIG_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, formatConfigValueForDisplay(v)]);
}

function formatConfigValueForDisplay(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pretty-print full artifact config for clipboard. */
export function formatRunConfigAsPrettyJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

function cloneArtifactConfig(cfg: unknown): Record<string, unknown> {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toSaifctlRunData(
  a: RunArtifactRaw,
  project: { projectPath: string; projectLabel: string },
): SaifctlRunData {
  const cfg = a.config ?? ({} as NonNullable<RunArtifactRaw['config']>);
  const featureName = typeof cfg.featureName === 'string' ? cfg.featureName : a.runId;
  const specRef = a.specRef ?? '';
  const specName = specRef ? path.basename(specRef) : featureName;

  return {
    id: a.runId,
    name: featureName,
    projectPath: project.projectPath,
    projectLabel: project.projectLabel,
    status: a.status,
    specRef: specName,
    artifactConfig: cloneArtifactConfig(cfg),
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
  /** Full artifact config (all keys), for copy-as-JSON / CLI. */
  public readonly artifactConfig: Record<string, unknown>;
  /** SaifCTL project cwd for `--project-dir` vs artifact `projectDir`. */
  public readonly projectPath: string;

  constructor(opts: {
    entries: [string, string][];
    artifactConfig: Record<string, unknown>;
    projectPath: string;
  }) {
    super('Config', vscode.TreeItemCollapsibleState.Collapsed);
    this.entries = opts.entries;
    this.artifactConfig = opts.artifactConfig;
    this.projectPath = opts.projectPath;
    const n = opts.entries.length;
    this.description = n === 0 ? 'default' : `${n} keys`;
    this.tooltip =
      n === 0 ? 'No config keys in artifact (default)' : `Run configuration (${n} entries)`;
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
