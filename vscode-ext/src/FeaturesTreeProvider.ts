/**
 * Tree provider for Features view.
 *
 * Scans filesystem for Projects -> Features -> Files. Assigns contextValue so
 * inline icons (Run, Design) appear only where intended.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { discoverSaifctlProjects } from './projectDiscovery';

export type SaifctlTreeItem = ProjectItem | FeatureItem | FileItem | DirItem;

export class FeaturesTreeProvider implements vscode.TreeDataProvider<SaifctlTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SaifctlTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SaifctlTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SaifctlTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SaifctlTreeItem): Promise<SaifctlTreeItem[]> {
    if (!this.workspaceRoot) {
      return [];
    }

    if (!element) {
      return this.getProjects();
    }

    if (element instanceof ProjectItem) {
      return this.getFeatures(element.projectPath);
    }

    if (element instanceof FeatureItem) {
      return this.getDirectoryContents(element.featurePath);
    }
    if (element instanceof DirItem) {
      return this.getDirectoryContents(element.dirPath);
    }

    return [];
  }

  private async getDirectoryContents(dirPath: string): Promise<SaifctlTreeItem[]> {
    const items: SaifctlTreeItem[] = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        items.push(new DirItem(entry.name, fullPath));
      } else if (entry.isFile()) {
        items.push(new FileItem(entry.name, fullPath));
      }
    }
    return items;
  }

  public async getProjects(): Promise<ProjectItem[]> {
    const discovered = await discoverSaifctlProjects(this.workspaceRoot);
    return discovered.map((p) => new ProjectItem(p.name, p.projectPath));
  }

  private async getFeatures(projectPath: string): Promise<FeatureItem[]> {
    const saifctlBase = path.join(projectPath, 'saifctl');
    const featuresDirPath = path.join(saifctlBase, 'features');
    try {
      await fs.promises.access(featuresDirPath);
    } catch {
      return [];
    }

    const features = await this.discoverFeaturesRecursive(featuresDirPath, projectPath);
    return features;
  }

  /** True if dir name is a Next.js-style group, e.g. "(auth)". */
  private isGroupDir(dirName: string): boolean {
    return dirName.startsWith('(') && dirName.endsWith(')');
  }

  /**
   * Recursively discovers feature dirs. Feature ID = full relative path
   * (e.g. "(auth)/login", "my-feat").
   */
  private async discoverFeaturesRecursive(
    baseDir: string,
    projectPath: string,
  ): Promise<FeatureItem[]> {
    const features: FeatureItem[] = [];

    const scan = async (currentPath: string, relativePrefix: string): Promise<void> => {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (this.isGroupDir(entry.name)) {
          await scan(fullPath, relativePath);
        } else {
          features.push(
            new FeatureItem({
              label: relativePath,
              featurePath: fullPath,
              projectPath,
            }),
          );
        }
      }
    };

    await scan(baseDir, '');
    return features;
  }
}

// ============================================================================
// TreeItem Definitions
// ============================================================================

export class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly projectPath: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.tooltip = `Project: ${this.label}`;
    this.contextValue = 'project';
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

export class FeatureItem extends vscode.TreeItem {
  public readonly featurePath: string;
  public readonly projectPath: string;

  constructor(opts: { label: string; featurePath: string; projectPath: string }) {
    super(opts.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.featurePath = opts.featurePath;
    this.projectPath = opts.projectPath;
    this.tooltip = `Feature: ${this.label}`;
    this.contextValue = 'feature';
    this.iconPath = new vscode.ThemeIcon('git-pull-request-draft');
    this.resourceUri = vscode.Uri.file(opts.featurePath);
  }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly filePath: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = this.filePath;
    this.contextValue = 'file';
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [this.resourceUri],
    };
  }
}

export class DirItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly dirPath: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = this.dirPath;
    this.contextValue = 'dir';
    this.resourceUri = vscode.Uri.file(dirPath);
  }
}
