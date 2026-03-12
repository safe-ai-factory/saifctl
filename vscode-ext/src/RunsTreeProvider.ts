/**
 * Tree provider for the Runs view.
 *
 * Three-level hierarchy: Projects -> Runs -> Metadata.
 * Uses ThemeIcon with ThemeColor for status dots (green/red).
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { type SaifCliService } from './cliService';

/** Raw artifact shape from .saif/runs/*.json (subset of full RunArtifact) */
interface RunArtifactRaw {
  runId: string;
  status: 'failed' | 'completed' | 'running';
  config?: { featureName: string; projectDir?: string; [k: string]: unknown };
  specRef?: string;
  updatedAt?: string;
}

export interface SaifRunData {
  id: string;
  name: string;
  project: string;
  status: 'success' | 'failed' | 'running';
  specRef: string;
  config: Record<string, string>;
}

export type RunTreeElement = RunProjectItem | RunItem | MetadataItem;

export class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunTreeElement | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RunTreeElement | undefined | void> =
    this._onDidChangeTreeData.event;

  private runsCache: SaifRunData[] = [];

  constructor(
    private readonly workspaceRoot: string,
    private readonly cliService: SaifCliService,
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
        const raw = await this.cliService.listRuns(this.workspaceRoot);
        this.runsCache = raw.map((a) => toSaifRunData(a as RunArtifactRaw, this.workspaceRoot));
        return this.getProjectGroups();
      } catch {
        vscode.window.showErrorMessage('Failed to fetch SAIF runs.');
        return [];
      }
    }

    if (element instanceof RunProjectItem) {
      const projectRuns = this.runsCache.filter((run) => run.project === element.projectName);
      return projectRuns.map((run) => {
        const absoluteProjectPath = path.join(this.workspaceRoot, run.project);
        return new RunItem(run, absoluteProjectPath);
      });
    }

    if (element instanceof RunItem) {
      return this.getRunMetadata(element.runData);
    }

    return [];
  }

  private getProjectGroups(): RunProjectItem[] {
    const projectNames = [...new Set(this.runsCache.map((r) => r.project))];
    return projectNames.map((name) => new RunProjectItem(name));
  }

  private getRunMetadata(run: SaifRunData): MetadataItem[] {
    const metadata: MetadataItem[] = [];
    metadata.push(new MetadataItem(`Status: ${run.status}`, 'status'));
    metadata.push(new MetadataItem(`Feature: ${run.specRef || 'None'}`, 'specRef'));
    if (run.config && Object.keys(run.config).length > 0) {
      const configString = Object.entries(run.config)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      metadata.push(new MetadataItem(`Config: { ${configString} }`, 'config'));
    } else {
      metadata.push(new MetadataItem('Config: default', 'config'));
    }
    return metadata;
  }
}

function toSaifRunData(a: RunArtifactRaw, workspaceRoot: string): SaifRunData {
  const cfg = a.config ?? ({} as NonNullable<RunArtifactRaw['config']>);
  const projectDir = typeof cfg.projectDir === 'string' ? cfg.projectDir : workspaceRoot;
  const project =
    projectDir === workspaceRoot
      ? ''
      : path.isAbsolute(projectDir) && projectDir.startsWith(workspaceRoot)
        ? path.relative(workspaceRoot, projectDir)
        : typeof cfg.projectDir === 'string'
          ? cfg.projectDir
          : path.basename(projectDir) || '';
  const featureName = typeof cfg.featureName === 'string' ? cfg.featureName : a.runId;
  const specRef = a.specRef ?? '';
  const specName = specRef ? path.basename(specRef) : featureName;

  const config: Record<string, string> = {};
  if (cfg && typeof cfg === 'object') {
    for (const [k, v] of Object.entries(cfg)) {
      if (v != null && typeof v === 'string') config[k] = v;
      else if (v != null) config[k] = String(v);
    }
  }

  const status: SaifRunData['status'] =
    a.status === 'completed' ? 'success' : a.status === 'running' ? 'running' : 'failed';
  return {
    id: a.runId,
    name: featureName,
    project,
    status,
    specRef: specName,
    config,
  };
}

// ============================================================================
// TreeItem Definitions
// ============================================================================

export class RunProjectItem extends vscode.TreeItem {
  constructor(public readonly projectName: string) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.tooltip = `Runs for project: ${projectName}`;
    this.contextValue = 'runProject';
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

export class RunItem extends vscode.TreeItem {
  public readonly projectPath: string;

  constructor(
    public readonly runData: SaifRunData,
    projectPath: string,
  ) {
    super(`${runData.name} (${runData.id})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = runData.id;
    this.projectPath = projectPath;
    this.tooltip = `Run ID: ${runData.id}\nStatus: ${runData.status}\nProject: ${projectPath}`;
    this.contextValue = `run_${runData.status}`;

    if (runData.status === 'success') {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    } else if (runData.status === 'failed') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'sync~spin',
        new vscode.ThemeColor('testing.iconQueued'),
      );
    }
  }
}

export class MetadataItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly type: 'status' | 'specRef' | 'config',
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'runMetadata';
    switch (type) {
      case 'status':
        this.iconPath = new vscode.ThemeIcon('info');
        break;
      case 'specRef':
        this.iconPath = new vscode.ThemeIcon('git-pull-request');
        break;
      case 'config':
        this.iconPath = new vscode.ThemeIcon('settings');
        break;
    }
  }
}
