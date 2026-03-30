/**
 * Tree provider for the Runs view.
 *
 * Hierarchy: Projects -> Runs -> Status / Feature / Config / Changes -> …
 * Uses ThemeIcon with ThemeColor for status dots (green/red).
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { type RunListEntry, type SaifctlCliService } from './cliService';
import { discoverSaifctlProjects } from './projectDiscovery';
import {
  buildDiffDirTrie,
  type DiffDirTrieNode,
  type DiffFileChange,
  type DiffFileStat,
  parseCombinedPatch,
  parsePatchUnmerged,
  sectionForFilePath,
} from './runDiffParser';

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

export interface SaifctlRunData {
  id: string;
  name: string;
  /** Absolute path to the SaifCTL project (parent of `saifctl/`) — CLI cwd */
  projectPath: string;
  /** Same label as Features tree project node */
  projectLabel: string;
  status: RunStatus;
  specRef: string;
  /** From `run info` after expanding the run (starts empty). */
  artifactConfig: Record<string, unknown>;
}

export type RunTreeElement =
  | RunProjectItem
  | RunItem
  | RunStatusItem
  | RunFeatureItem
  | RunConfigGroupItem
  | RunConfigKeyItem
  | RunDiffGroupItem
  | RunDiffDirItem
  | RunDiffFileItem
  | RunDiffMessageItem;

/** Cached with diff list so full-file diff can use baseCommitSha + basePatchDiff + per-commit patches. */
interface RunDiffArtifactContext {
  baseCommitSha: string;
  basePatchDiff: string;
  runCommits: Array<{ diff?: string }>;
}

export class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunTreeElement | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<RunTreeElement | undefined | void> =
    this._onDidChangeTreeData.event;

  private runsCache: SaifctlRunData[] = [];
  private _filterText = '';
  private _filterStatuses = new Set<RunStatus>();
  /** Parsed file stats per run after expanding Changes (lazy). */
  private readonly diffCache = new Map<string, DiffFileStat[]>();
  /** True when `run get` failed for this runId. */
  private readonly diffLoadFailed = new Set<string>();
  private readonly diffArtifactCache = new Map<string, RunDiffArtifactContext>();

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

  refresh(): void {
    this.diffCache.clear();
    this.diffArtifactCache.clear();
    this.diffLoadFailed.clear();
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

  getTreeItem(element: RunTreeElement): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: RunTreeElement): Promise<RunTreeElement[]> {
    // No workspace folder open — nothing to list.
    if (!this.workspaceRoot) {
      return [];
    }

    // Tree root: discover SaifCTL projects, merge runs from each via CLI, show project rows.
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
              toSaifctlRunData({
                entry: a,
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

    // One project expanded: its runs (filtered).
    if (element instanceof RunProjectItem) {
      const projectRuns = this.runsCache.filter(
        (run) => run.projectPath === element.projectPath && this.matchesFilter(run),
      );
      return projectRuns.map((run) => new RunItem(run, run.projectPath));
    }

    // One run expanded: hydrate artifact config if needed, then metadata + Changes group.
    if (element instanceof RunItem) {
      const idx = this.runsCache.findIndex(
        (r) => r.id === element.runData.id && r.projectPath === element.runData.projectPath,
      );
      // Run list only has rows with minimal data (`run list`).
      // Each Run's config is filled on first expand via `run info`.
      if (idx >= 0 && Object.keys(this.runsCache[idx]!.artifactConfig).length === 0) {
        const info = await this.cliService.getRunInfo(
          element.runData.id,
          element.runData.projectPath,
        );
        const cfg = info?.config;
        if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
          this.runsCache[idx] = {
            ...this.runsCache[idx]!,
            artifactConfig: cfg as Record<string, unknown>,
          };
          // Keep the tree item in sync so later commands see the hydrated config.
          element.runData = this.runsCache[idx]!;
        }
      }
      return this.getRunMetadata(element.runData);
    }

    // Config group expanded: one row per visible config key.
    if (element instanceof RunConfigGroupItem) {
      return element.entries.map(([key, value]) => new RunConfigKeyItem(key, value));
    }

    // Changes expanded: lazy fetch run get, parse patches, nested folder tree of files.
    if (element instanceof RunDiffGroupItem) {
      return this.getDiffChildren(element);
    }

    // Directory node under Changes: pre-built child dirs and files.
    if (element instanceof RunDiffDirItem) {
      return element.childElements;
    }

    // Leaves (status, feature, config keys, diff files, messages) have no children.
    return [];
  }

  /**
   * Children of the **Changes** node for one run: loads the full artifact once (`run get`),
   * caches parsed file stats + base SHA / patches for the diff editor, then returns a nested
   * folder tree of changed files (or placeholder rows on error / empty patch).
   */
  private async getDiffChildren(group: RunDiffGroupItem): Promise<RunTreeElement[]> {
    const { runId, projectPath, featureLabel } = group;

    // First expansion only: fetch artifact, or record failure so we do not retry every paint.
    if (!this.diffCache.has(runId) && !this.diffLoadFailed.has(runId)) {
      const full = await this.cliService.getRunFull(runId, projectPath);
      if (!full) {
        this.diffLoadFailed.add(runId);
        group.description = 'error';
        group.tooltip = 'Could not load run (run get failed). Is saifctl up to date?';
        this._onDidChangeTreeData.fire(group);
        return [
          new RunDiffMessageItem(
            'Could not load changes (run get failed)',
            'Is the CLI recent enough? Try: saifctl run get ' + runId,
          ),
        ];
      }

      // Concatenate all commit diffs for the tree (per-file stats + merged sections).
      const combined = (full.runCommits ?? [])
        .map((c) => c.diff)
        .filter(Boolean)
        .join('');
      const stats = parseCombinedPatch(combined);
      this.diffCache.set(runId, stats);
      // Needed when opening a file diff: git show / apply uses baseCommitSha, basePatchDiff, per-commit hunks.
      this.diffArtifactCache.set(runId, {
        baseCommitSha: typeof full.baseCommitSha === 'string' ? full.baseCommitSha : '',
        basePatchDiff: typeof full.basePatchDiff === 'string' ? full.basePatchDiff : '',
        runCommits: full.runCommits ?? [],
      });
      group.description = stats.length === 0 ? '0 files' : `${stats.length} file(s)`;
      group.tooltip =
        stats.length === 0
          ? 'No committed diffs on this run'
          : `Combined patch from ${stats.length} file(s)`;
      this._onDidChangeTreeData.fire(group);
    }

    // Subsequent expansions after a failed first load: show a stable error row (no re-fetch).
    if (this.diffLoadFailed.has(runId)) {
      return [
        new RunDiffMessageItem(
          'Could not load changes (run get failed)',
          'Is the CLI recent enough?',
        ),
      ];
    }

    // Successful load but no file hunks in runCommits (e.g. empty commits).
    const stats = this.diffCache.get(runId) ?? [];
    if (stats.length === 0) {
      return [new RunDiffMessageItem('No file changes', '')];
    }

    // Build nested folders and file rows; each file carries slices of base/run patches for vscode.diff.
    const trie = buildDiffDirTrie(stats);
    const diffCtx = this.diffArtifactCache.get(runId) ?? {
      baseCommitSha: '',
      basePatchDiff: '',
      runCommits: [],
    };
    return trieToRunElements({
      node: trie,
      runId,
      projectPath,
      featureLabel,
      parentPath: '',
      diffCtx,
    });
  }

  private getRunMetadata(run: SaifctlRunData): RunTreeElement[] {
    const entries = visibleConfigEntries(run.artifactConfig);
    const configGroup = new RunConfigGroupItem({
      entries,
      artifactConfig: run.artifactConfig,
      projectPath: run.projectPath,
    });
    const diffGroup = new RunDiffGroupItem({
      runId: run.id,
      projectPath: run.projectPath,
      featureLabel: run.name,
    });
    return [new RunStatusItem(run.status), new RunFeatureItem(run.specRef), configGroup, diffGroup];
  }
}

/**
 * Turn one trie node into VS Code tree rows: child folders (recursive) then files at this level.
 * Each {@link RunDiffFileItem} gets the per-file hunks needed to reconstruct full before/after text.
 */
function trieToRunElements(opts: {
  node: DiffDirTrieNode;
  runId: string;
  projectPath: string;
  featureLabel: string;
  parentPath: string;
  diffCtx: RunDiffArtifactContext;
}): RunTreeElement[] {
  const { node, runId, projectPath, featureLabel, parentPath, diffCtx } = opts;

  // Subdirectories: recurse; `parentPath` threads the trie path (labels use a single segment per row).
  const dirItems: RunDiffDirItem[] = node.dirs.map((d) => {
    const full = parentPath ? `${parentPath}/${d.segment}` : d.segment;
    const inner = trieToRunElements({
      node: d,
      runId,
      projectPath,
      featureLabel,
      parentPath: full,
      diffCtx,
    });
    return new RunDiffDirItem(d.segment, inner);
  });

  // Files at this level: split combined patches into this path’s sections for `RunDiffContentProvider`.
  const fileItems = node.files.map((s) => {
    const basePatchSection =
      sectionForFilePath(parsePatchUnmerged(diffCtx.basePatchDiff), s.path) ?? '';
    const runCommitSections = diffCtx.runCommits.map(
      (c) => sectionForFilePath(parsePatchUnmerged(c.diff ?? ''), s.path) ?? '',
    );
    return new RunDiffFileItem({
      runId,
      projectPath,
      featureLabel,
      stat: s,
      baseCommitSha: diffCtx.baseCommitSha,
      basePatchSection,
      runCommitSections,
    });
  });

  // Folders first (sorted), then files (sorted); matches common file-tree UX.
  dirItems.sort((a, b) => a.segment.localeCompare(b.segment));
  fileItems.sort((a, b) => a.stat.path.localeCompare(b.stat.path));
  return [...dirItems, ...fileItems];
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

function toSaifctlRunData(opts: {
  entry: RunListEntry;
  projectPath: string;
  projectLabel: string;
}): SaifctlRunData {
  const { entry, projectPath, projectLabel } = opts;
  const specRef = entry.specRef ?? '';
  const specName = specRef ? path.basename(specRef) : entry.featureName;

  return {
    id: entry.runId,
    name: entry.featureName,
    projectPath,
    projectLabel,
    status: entry.status,
    specRef: specName,
    artifactConfig: {},
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

// Reuse the same colors for diff icons as VS Code uses for git diffs.
function diffChangeIcon(change: DiffFileChange): vscode.ThemeIcon {
  switch (change) {
    case 'added':
      return new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
      );
    case 'deleted':
      return new vscode.ThemeIcon(
        'diff-removed',
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
      );
    case 'renamed':
      return new vscode.ThemeIcon(
        'diff-renamed',
        new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
      );
    default:
      return new vscode.ThemeIcon(
        'diff-modified',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      );
  }
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

/** Stable tree id: must be unique across the whole Runs view (same runId can exist under different projects). */
export function runItemTreeId(projectPath: string, runId: string): string {
  return `saifctl-run:${encodeURIComponent(projectPath)}:${encodeURIComponent(runId)}`;
}

export class RunItem extends vscode.TreeItem {
  public readonly projectPath: string;

  constructor(
    public runData: SaifctlRunData,
    projectPath: string,
  ) {
    super(`${runData.name} (${runData.id})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = runItemTreeId(projectPath, runData.id);
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

/**
 * Collapsible **Changes** row under a run. First expand triggers `run get` and fills the diff trie
 * (`getDiffChildren`); description updates to file count.
 */
export class RunDiffGroupItem extends vscode.TreeItem {
  public readonly runId: string;
  public readonly projectPath: string;
  public readonly featureLabel: string;

  constructor(opts: { runId: string; projectPath: string; featureLabel: string }) {
    super('Changes', vscode.TreeItemCollapsibleState.Collapsed);
    this.runId = opts.runId;
    this.projectPath = opts.projectPath;
    this.featureLabel = opts.featureLabel;
    this.description = '…';
    this.tooltip = 'Expand to load file list from run get (combined runCommits diffs)';
    this.contextValue = 'runDiffGroup';
    this.iconPath = new vscode.ThemeIcon('diff');
  }
}

/** One directory segment in the Changes tree; children are further dirs and/or {@link RunDiffFileItem}s. */
export class RunDiffDirItem extends vscode.TreeItem {
  constructor(
    public readonly segment: string,
    public readonly childElements: RunTreeElement[],
  ) {
    super(segment, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'runDiffDir';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

/**
 * One changed file (basename label). Holds merged diff stats for the row and per-hunk strings
 * for {@link RunDiffContentProvider}; activating runs `saifctl.openRunFileDiff`.
 */
export class RunDiffFileItem extends vscode.TreeItem {
  public readonly runId: string;
  public readonly projectPath: string;
  public readonly featureLabel: string;
  public readonly stat: DiffFileStat;
  public readonly baseCommitSha: string;
  public readonly basePatchSection: string;
  public readonly runCommitSections: string[];

  constructor(opts: {
    runId: string;
    projectPath: string;
    featureLabel: string;
    stat: DiffFileStat;
    baseCommitSha: string;
    basePatchSection: string;
    runCommitSections: string[];
  }) {
    const baseName = path.basename(opts.stat.path);
    super(baseName, vscode.TreeItemCollapsibleState.None);
    this.runId = opts.runId;
    this.projectPath = opts.projectPath;
    this.featureLabel = opts.featureLabel;
    this.stat = opts.stat;
    this.baseCommitSha = opts.baseCommitSha;
    this.basePatchSection = opts.basePatchSection;
    this.runCommitSections = opts.runCommitSections;
    const stat = opts.stat;
    // Line counts from parsed unified diff (may aggregate multiple commits for the same path).
    const parts: string[] = [];
    if (stat.added > 0) parts.push(`+${stat.added}`);
    if (stat.removed > 0) parts.push(`-${stat.removed}`);
    this.description = parts.length > 0 ? parts.join(' ') : '0';
    if (stat.change === 'renamed' && stat.fromPath) {
      this.tooltip = `${stat.fromPath} → ${stat.path}`;
    } else {
      this.tooltip = stat.path;
    }
    this.contextValue = 'runDiffFile';
    this.iconPath = diffChangeIcon(stat.change);
    // Default action: same as the command palette entry for this row.
    this.command = {
      command: 'saifctl.openRunFileDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }
}

/** Non-interactive row under Changes (empty list, load error, or hint text). */
export class RunDiffMessageItem extends vscode.TreeItem {
  constructor(message: string, detail: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.contextValue = 'runDiffMessage';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}
