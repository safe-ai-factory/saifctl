/**
 * Tree provider for Features view.
 *
 * Scans filesystem for Projects -> Features -> Files. Assigns contextValue so
 * inline icons (Run, Debug, Design, Finish) appear only where intended.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

export type SaifTreeItem = ProjectItem | FeatureItem | FileItem | DirItem;

export class FeaturesTreeProvider implements vscode.TreeDataProvider<SaifTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SaifTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<SaifTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SaifTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SaifTreeItem): Promise<SaifTreeItem[]> {
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

  private async getDirectoryContents(dirPath: string): Promise<SaifTreeItem[]> {
    const items: SaifTreeItem[] = [];
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
    const projects: ProjectItem[] = [];
    const ignoreDirs = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.venv',
      'venv',
      '__pycache__',
      '.saifctl',
    ]);

    const search = async (currentDir: string) => {
      let entries: { name: string; isDirectory: () => boolean }[];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      let isProjectRoot = false;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        if (entry.name === 'saifctl') {
          if (!isProjectRoot) {
            const projectName =
              currentDir === this.workspaceRoot
                ? path.basename(currentDir) || 'Workspace'
                : path.relative(this.workspaceRoot, currentDir) ||
                  path.basename(this.workspaceRoot);

            projects.push(new ProjectItem(projectName, currentDir));
            isProjectRoot = true;
          }
          continue;
        }

        if (!entry.name.startsWith('.') && !ignoreDirs.has(entry.name)) {
          await search(path.join(currentDir, entry.name));
        }
      }
    };

    await search(this.workspaceRoot);
    return projects;
  }

  private async getFeatures(projectPath: string): Promise<FeatureItem[]> {
    const saifBase = path.join(projectPath, 'saifctl');
    const featuresDirPath = path.join(saifBase, 'features');
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
