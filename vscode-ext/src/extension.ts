/**
 * SaifCTL VS Code extension
 *
 * Central controller wiring package.json commands to SaifctlCliService.
 * Tree providers (FeaturesTreeProvider, RunsTreeProvider) to be added next.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { findBestInstallCwd, type ResolverLog } from './binaryResolver';
import { SaifctlCliService } from './cliService';
import { FeatureItem, FeaturesTreeProvider } from './FeaturesTreeProvider';
import { loggedCommand } from './loggedCommand';
import { logger, saifctlOutputChannel, setVerboseLogging } from './logger';
import { buildFeatRunCliFromArtifactConfig } from './runConfigToCli';
import { RunDiffContentProvider, runDiffUri } from './runDiffContentProvider';
import {
  formatRunConfigAsPrettyJson,
  RunConfigGroupItem,
  RunConfigKeyItem,
  RunDiffFileItem,
  RunFeatureItem,
  RunItem,
  RunProjectItem,
  type RunStatus,
  RunStatusItem,
  RunsTreeProvider,
} from './RunsTreeProvider';

function makeWorkspaceResolverLog(): ResolverLog {
  const verbose = vscode.workspace.getConfiguration('saifctl').get<boolean>('verbose', false);
  return verbose
    ? {
        trace: (m) => logger.trace(m),
        debug: (m) => logger.debug(m),
        info: (m) => logger.info(m),
      }
    : { info: (m) => logger.info(m) };
}

export async function activate(context: vscode.ExtensionContext) {
  // ============================================================================
  // 0. Settings - listen for changes
  // ============================================================================

  // Verbose
  function applyVerboseSetting(): void {
    const verbose = vscode.workspace.getConfiguration('saifctl').get<boolean>('verbose', false);
    setVerboseLogging(verbose);
    logger.info(
      `SaifCTL: verbose ${verbose ? 'on' : 'off'} (logger level ${verbose ? 'trace' : 'default'})`,
    );
  }

  applyVerboseSetting();

  // ============================================================================
  // 1. CLI + Guard
  // ============================================================================

  logger.info('SaifCTL extension is now active!');

  const cliService = new SaifctlCliService();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    logger.warn('Please open a workspace folder to use the extension.');
    vscode.window.showWarningMessage(
      'SaifCTL: Please open a workspace folder to use the extension.',
    );
    return;
  }

  let isCliCurrentlyInstalled = false;

  const getInstallCwd = (): Promise<string> => {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return findBestInstallCwd(
      roots.length > 0 ? roots : [workspaceRoot],
      makeWorkspaceResolverLog(),
    );
  };

  const checkCliStatus = async (): Promise<boolean> => {
    const installCwd = await getInstallCwd();
    isCliCurrentlyInstalled = await cliService.isCliInstalled(installCwd);
    if (!isCliCurrentlyInstalled) {
      logger.info(
        `SaifCTL: no working CLI for install cwd ${installCwd} ("saifctl version" failed).`,
      );
    }
    await vscode.commands.executeCommand(
      'setContext',
      'saifctl.isCliInstalled',
      isCliCurrentlyInstalled,
    );
    return isCliCurrentlyInstalled;
  };

  // Wrap commands to always check if CLI is installed
  const withCliGuard = <T extends unknown[]>(
    callback: (...args: T) => unknown | Promise<unknown>,
  ) => {
    return async (...args: T) => {
      if (!isCliCurrentlyInstalled) {
        const selection = await vscode.window.showWarningMessage(
          'The SaifCTL CLI is required. Install locally: npm install @safe-ai-factory/saifctl, or globally: npm install -g @safe-ai-factory/saifctl',
          'Open npm',
          'Open GitHub',
        );
        if (selection === 'Open npm') {
          await vscode.env.openExternal(
            vscode.Uri.parse('https://www.npmjs.com/package/@safe-ai-factory/saifctl'),
          );
        } else if (selection === 'Open GitHub') {
          await vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/safe-ai-factory/saifctl'),
          );
        }
        return;
      }
      return await callback(...args);
    };
  };

  await checkCliStatus();

  await vscode.commands.executeCommand('setContext', 'saifctl.featuresFilterActive', false);
  await vscode.commands.executeCommand('setContext', 'saifctl.runsFilterActive', false);

  // ============================================================================
  // 2. Tree Providers Setup
  // ============================================================================

  const featuresProvider = new FeaturesTreeProvider(workspaceRoot);
  const featuresTreeView = vscode.window.createTreeView('saifctl-features', {
    treeDataProvider: featuresProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(featuresTreeView);

  // File watcher for saifctl/features
  const watcher = vscode.workspace.createFileSystemWatcher('**/saifctl/features/**');
  const onFeaturesFs = (phase: string) => (uri: vscode.Uri) => {
    logger.trace(`watcher [features] ${phase}: ${uri.fsPath}`);
    featuresProvider.refresh();
  };
  watcher.onDidCreate(onFeaturesFs('create'));
  watcher.onDidChange(onFeaturesFs('change'));
  watcher.onDidDelete(onFeaturesFs('delete'));
  context.subscriptions.push(watcher);

  // Watcher for saifctl dir creation/deletion to automatically pick up new projects
  const saifctlWatcher = vscode.workspace.createFileSystemWatcher('**/saifctl');
  const onSaifctlDirFs = (phase: string) => (uri: vscode.Uri) => {
    logger.trace(`SaifCTL watcher [saifctl] ${phase}: ${uri.fsPath}`);
    cliService.invalidateCache();
    void checkCliStatus();
    featuresProvider.refresh();
  };
  saifctlWatcher.onDidCreate(onSaifctlDirFs('create'));
  saifctlWatcher.onDidDelete(onSaifctlDirFs('delete'));
  context.subscriptions.push(saifctlWatcher);

  const binWatcher = vscode.workspace.createFileSystemWatcher('**/node_modules/.bin/saifctl*');
  const onBinFs = (phase: string) => (uri: vscode.Uri) => {
    logger.trace(`SaifCTL watcher [node_modules/.bin/saifctl] ${phase}: ${uri.fsPath}`);
    cliService.invalidateCache();
    void checkCliStatus();
  };
  binWatcher.onDidCreate(onBinFs('create'));
  binWatcher.onDidChange(onBinFs('change'));
  binWatcher.onDidDelete(onBinFs('delete'));
  context.subscriptions.push(binWatcher);

  const runsProvider = new RunsTreeProvider(workspaceRoot, cliService);
  const runsTreeView = vscode.window.createTreeView('saifctl-runs', {
    treeDataProvider: runsProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(runsTreeView);

  const saifctlSettingsListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('saifctl')) return;
    const cfg = vscode.workspace.getConfiguration('saifctl');
    logger.info(
      `SaifCTL settings: verbose=${String(cfg.get('verbose'))}, binaryPath=${JSON.stringify(cfg.get('binaryPath'))}`,
    );
    if (e.affectsConfiguration('saifctl.verbose')) {
      applyVerboseSetting();
    }
    if (e.affectsConfiguration('saifctl.binaryPath')) {
      cliService.invalidateCache();
      void (async () => {
        await checkCliStatus();
        featuresProvider.refresh();
        runsProvider.refresh();
      })();
    }
  });
  context.subscriptions.push(saifctlSettingsListener);

  const getItemName = (item: vscode.TreeItem | undefined): string | undefined => {
    if (!item) return undefined;
    return typeof item.label === 'string' ? item.label : item.label?.label;
  };

  /** SaifCTL run id for CLI commands — not the same as {@link vscode.TreeItem.id} (which is scoped for tree uniqueness). */
  const getRunId = (item?: vscode.TreeItem): string | undefined =>
    item instanceof RunItem ? item.runData.id : undefined;

  // ============================================================================
  // 3. Feature Management Commands
  // ============================================================================

  const createFeatureCmd = vscode.commands.registerCommand(
    'saifctl.createFeature',
    withCliGuard(
      loggedCommand('saifctl.createFeature', async () => {
        let targetCwd = workspaceRoot;

        const projects = await featuresProvider.getProjects();
        if (projects.length > 1) {
          const projectChoices = projects.map((p) => ({
            label: p.label,
            description: p.projectPath,
          }));
          const selectedProject = await vscode.window.showQuickPick(projectChoices, {
            placeHolder: 'Select which project to create the feature in',
          });
          if (!selectedProject) return;
          targetCwd = selectedProject.description ?? workspaceRoot;
        } else if (projects.length === 1) {
          targetCwd = projects[0].projectPath;
        }

        const featureName = await vscode.window.showInputBox({
          prompt: 'Enter the name for the new feature',
          placeHolder: 'e.g., add-authentication',
        });

        if (featureName && targetCwd) {
          await cliService.createFeature(featureName, targetCwd);
          featuresProvider.refresh();
        }
      }),
    ),
  );

  const createDirCmd = vscode.commands.registerCommand(
    'saifctl.createDir',
    loggedCommand('saifctl.createDir', async (item?: vscode.TreeItem) => {
      const dirName = await vscode.window.showInputBox({
        prompt: 'Enter folder name',
      });
      const basePath = item?.resourceUri?.fsPath ?? path.join(workspaceRoot, 'saifctl', 'features');
      if (dirName) {
        const newDirPath = vscode.Uri.file(path.join(basePath, dirName));
        await vscode.workspace.fs.createDirectory(newDirPath);
        featuresProvider.refresh();
      }
    }),
  );

  const createFileCmd = vscode.commands.registerCommand(
    'saifctl.createFile',
    loggedCommand('saifctl.createFile', async (item?: vscode.TreeItem) => {
      const fileName = await vscode.window.showInputBox({
        prompt: 'Enter file name',
      });
      const basePath = item?.resourceUri?.fsPath ?? path.join(workspaceRoot, 'saifctl', 'features');
      if (fileName) {
        const newFilePath = vscode.Uri.file(path.join(basePath, fileName));
        await vscode.workspace.fs.writeFile(newFilePath, new Uint8Array());
        featuresProvider.refresh();
      }
    }),
  );

  const refreshFeaturesCmd = vscode.commands.registerCommand(
    'saifctl.refreshFeatures',
    loggedCommand('saifctl.refreshFeatures', () => {
      featuresProvider.refresh();
    }),
  );

  const getCwdForFeature = (item?: vscode.TreeItem): string =>
    item instanceof FeatureItem ? item.projectPath : workspaceRoot;

  const logDetailFeatureCommand = (item?: vscode.TreeItem): string =>
    `feature=${getItemName(item) ?? '(none)'} cwd=${getCwdForFeature(item)}`;

  const runFeatureCmd = vscode.commands.registerCommand(
    'saifctl.runFeature',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.runFeature', startDetail: logDetailFeatureCommand },
        async (item?: vscode.TreeItem) => {
          const name = getItemName(item);
          const cwd = getCwdForFeature(item);
          if (name) void cliService.runFeature(name, cwd);
        },
      ),
    ),
  );

  const designFeatureCmd = vscode.commands.registerCommand(
    'saifctl.designFeature',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.designFeature', startDetail: logDetailFeatureCommand },
        async (item?: vscode.TreeItem) => {
          const name = getItemName(item);
          const cwd = getCwdForFeature(item);
          if (name) void cliService.designFeature(name, cwd);
        },
      ),
    ),
  );

  const designFeatureSpecsCmd = vscode.commands.registerCommand(
    'saifctl.designFeatureSpecs',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.designFeatureSpecs', startDetail: logDetailFeatureCommand },
        async (item?: vscode.TreeItem) => {
          const name = getItemName(item);
          const cwd = getCwdForFeature(item);
          if (name) void cliService.designFeatureSpecsOnly(name, cwd);
        },
      ),
    ),
  );

  const validateFeatureTestsCmd = vscode.commands.registerCommand(
    'saifctl.validateFeatureTests',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.validateFeatureTests', startDetail: logDetailFeatureCommand },
        async (item?: vscode.TreeItem) => {
          const name = getItemName(item);
          const cwd = getCwdForFeature(item);
          if (name) void cliService.validateFeatureTests(name, cwd);
        },
      ),
    ),
  );

  const openFeatureProposalCmd = vscode.commands.registerCommand(
    'saifctl.openFeatureProposal',
    loggedCommand('saifctl.openFeatureProposal', async (item?: vscode.TreeItem) => {
      if (!(item instanceof FeatureItem)) return;
      const proposalUri = vscode.Uri.file(path.join(item.featurePath, 'proposal.md'));
      try {
        await vscode.workspace.fs.stat(proposalUri);
        await vscode.window.showTextDocument(proposalUri);
      } catch {
        void vscode.window.showWarningMessage('proposal.md was not found in this feature folder.');
      }
    }),
  );

  const copyFeatureNameCmd = vscode.commands.registerCommand(
    'saifctl.copyFeatureName',
    loggedCommand('saifctl.copyFeatureName', async (item?: vscode.TreeItem) => {
      if (!(item instanceof FeatureItem)) return;
      const label = item.label;
      const text =
        typeof label === 'string' ? label : typeof label === 'object' ? label.label : undefined;
      if (!text) return;
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(`Copied feature name: ${text}`);
    }),
  );

  const revealFeatureInExplorerCmd = vscode.commands.registerCommand(
    'saifctl.revealFeatureInExplorer',
    loggedCommand('saifctl.revealFeatureInExplorer', async (item?: vscode.TreeItem) => {
      if (!(item instanceof FeatureItem)) return;
      const uri = vscode.Uri.file(item.featurePath);
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }),
  );

  // ============================================================================
  // 4. Run Management Commands
  // ============================================================================

  const refreshRunsCmd = vscode.commands.registerCommand(
    'saifctl.refreshRuns',
    withCliGuard(
      loggedCommand('saifctl.refreshRuns', () => {
        runsProvider.refresh();
      }),
    ),
  );

  const openFeaturesFilter = () => {
    showFeaturesFilterQuickPick(featuresProvider, featuresTreeView);
  };

  const filterFeaturesCmd = vscode.commands.registerCommand(
    'saifctl.filterFeatures',
    loggedCommand('saifctl.filterFeatures', openFeaturesFilter),
  );

  const filterFeaturesActiveCmd = vscode.commands.registerCommand(
    'saifctl.filterFeaturesActive',
    loggedCommand('saifctl.filterFeaturesActive', openFeaturesFilter),
  );

  const clearFilterFeaturesCmd = vscode.commands.registerCommand(
    'saifctl.clearFilterFeatures',
    loggedCommand('saifctl.clearFilterFeatures', () => {
      featuresProvider.clearFilter();
      updateFeaturesViewDescription(featuresTreeView, featuresProvider);
      void vscode.commands.executeCommand('setContext', 'saifctl.featuresFilterActive', false);
    }),
  );

  const openRunsFilter = () => {
    showRunsFilterQuickPick(runsProvider, runsTreeView);
  };

  const filterRunsCmd = vscode.commands.registerCommand(
    'saifctl.filterRuns',
    withCliGuard(loggedCommand('saifctl.filterRuns', openRunsFilter)),
  );

  const filterRunsActiveCmd = vscode.commands.registerCommand(
    'saifctl.filterRunsActive',
    withCliGuard(loggedCommand('saifctl.filterRunsActive', openRunsFilter)),
  );

  const clearFilterRunsCmd = vscode.commands.registerCommand(
    'saifctl.clearFilterRuns',
    loggedCommand('saifctl.clearFilterRuns', () => {
      runsProvider.clearFilter();
      updateRunsViewDescription(runsTreeView, runsProvider);
      void vscode.commands.executeCommand('setContext', 'saifctl.runsFilterActive', false);
    }),
  );

  const getCwdForRun = (item?: vscode.TreeItem): string =>
    item instanceof RunItem ? item.projectPath : workspaceRoot;

  const logDetailRunCommand = (item?: vscode.TreeItem): string => {
    const runId = getRunId(item) ?? getItemName(item);
    return `runId=${runId ?? '(none)'} cwd=${getCwdForRun(item)}`;
  };

  const clearAllRunsTargetCwd = (item?: vscode.TreeItem): string =>
    item instanceof RunProjectItem ? item.projectPath : workspaceRoot;

  const fromArtifactCmd = vscode.commands.registerCommand(
    'saifctl.fromArtifact',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.fromArtifact', startDetail: logDetailRunCommand },
        async (item?: vscode.TreeItem) => {
          const runId = getRunId(item);
          const cwd = getCwdForRun(item);
          if (runId) void cliService.fromArtifact(runId, cwd);
        },
      ),
    ),
  );

  const removeRunCmd = vscode.commands.registerCommand(
    'saifctl.removeRun',
    withCliGuard(
      loggedCommand(
        { commandId: 'saifctl.removeRun', startDetail: logDetailRunCommand },
        async (item?: vscode.TreeItem) => {
          const runId = getRunId(item);
          const cwd = getCwdForRun(item);
          if (runId) {
            await cliService.removeRun(runId, cwd);
            runsProvider.refresh();
          }
        },
      ),
    ),
  );

  const clearAllRunsCmd = vscode.commands.registerCommand(
    'saifctl.clearAllRuns',
    withCliGuard(
      loggedCommand(
        {
          commandId: 'saifctl.clearAllRuns',
          startDetail: (item) => `cwd=${clearAllRunsTargetCwd(item)}`,
        },
        async (item?: vscode.TreeItem) => {
          await cliService.clearAllRuns(clearAllRunsTargetCwd(item));
          runsProvider.refresh();
        },
      ),
    ),
  );

  const revealRunInFinderCmd = vscode.commands.registerCommand(
    'saifctl.revealRunInFinder',
    loggedCommand(
      { commandId: 'saifctl.revealRunInFinder', startDetail: logDetailRunCommand },
      (item?: vscode.TreeItem) => {
        const runId = getRunId(item);
        const cwd = getCwdForRun(item);
        if (runId) {
          const runFilePath = vscode.Uri.file(path.join(cwd, '.saifctl', 'runs', `${runId}.json`));
          void vscode.commands.executeCommand('revealFileInOS', runFilePath);
        }
      },
    ),
  );

  const copyRunIdCmd = vscode.commands.registerCommand(
    'saifctl.copyRunId',
    loggedCommand('saifctl.copyRunId', async (item?: vscode.TreeItem) => {
      const runId = getRunId(item);
      if (runId) {
        await vscode.env.clipboard.writeText(runId);
        vscode.window.showInformationMessage(`Copied Run ID: ${runId}`);
      }
    }),
  );

  const copyRunNameCmd = vscode.commands.registerCommand(
    'saifctl.copyRunName',
    loggedCommand('saifctl.copyRunName', async (item?: vscode.TreeItem) => {
      const name = item instanceof RunItem ? item.runData.name : getItemName(item);
      if (name) {
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied Run Name: ${name}`);
      }
    }),
  );

  const copyRunStatusCmd = vscode.commands.registerCommand(
    'saifctl.copyRunStatus',
    loggedCommand('saifctl.copyRunStatus', async (item?: vscode.TreeItem) => {
      const status =
        item instanceof RunStatusItem
          ? item.status
          : item instanceof RunItem
            ? item.runData.status
            : undefined;
      if (status) {
        await vscode.env.clipboard.writeText(status);
        void vscode.window.showInformationMessage(`Copied status: ${status}`);
      }
    }),
  );

  const copyRunFeatureCmd = vscode.commands.registerCommand(
    'saifctl.copyRunFeature',
    loggedCommand('saifctl.copyRunFeature', async (item?: vscode.TreeItem) => {
      const feature =
        item instanceof RunFeatureItem
          ? item.featureName
          : item instanceof RunItem
            ? item.runData.specRef
            : undefined;
      if (feature) {
        await vscode.env.clipboard.writeText(feature);
        void vscode.window.showInformationMessage(`Copied feature: ${feature}`);
      }
    }),
  );

  const copyRunConfigValueCmd = vscode.commands.registerCommand(
    'saifctl.copyRunConfigValue',
    loggedCommand('saifctl.copyRunConfigValue', async (item?: vscode.TreeItem) => {
      if (!(item instanceof RunConfigKeyItem)) return;
      await vscode.env.clipboard.writeText(item.configValue);
      void vscode.window.showInformationMessage(`Copied ${item.configKey}`);
    }),
  );

  const copyRunConfigJsonCmd = vscode.commands.registerCommand(
    'saifctl.copyRunConfigJson',
    loggedCommand('saifctl.copyRunConfigJson', async (item?: vscode.TreeItem) => {
      if (!(item instanceof RunConfigGroupItem)) return;
      const text = formatRunConfigAsPrettyJson(item.artifactConfig);
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Copied full run config as JSON');
    }),
  );

  const copyRunConfigCliCmd = vscode.commands.registerCommand(
    'saifctl.copyRunConfigCli',
    loggedCommand('saifctl.copyRunConfigCli', async (item?: vscode.TreeItem) => {
      if (!(item instanceof RunConfigGroupItem)) return;
      const text = buildFeatRunCliFromArtifactConfig(item.artifactConfig, item.projectPath);
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Copied feat run command');
    }),
  );

  // Run file diff: `saifctl-diff:` virtual docs hold full-file before/after (git show + apply patches).
  const runDiffContentProvider = new RunDiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('saifctl-diff', runDiffContentProvider),
  );

  const openRunFileDiffCmd = vscode.commands.registerCommand(
    'saifctl.openRunFileDiff',
    loggedCommand('saifctl.openRunFileDiff', async (item?: vscode.TreeItem) => {
      if (!(item instanceof RunDiffFileItem)) return;
      // Async git work: populate the provider cache, then open the built-in diff editor.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Preparing diff…' },
        async () => {
          await runDiffContentProvider.prepareSides({
            runId: item.runId,
            projectPath: item.projectPath,
            baseCommitSha: item.baseCommitSha,
            basePatchSection: item.basePatchSection,
            runCommitSections: item.runCommitSections,
            stat: item.stat,
          });
        },
      );
      const left = runDiffUri({ runId: item.runId, filePath: item.stat.path, side: 'base' });
      const right = runDiffUri({ runId: item.runId, filePath: item.stat.path, side: 'changed' });
      const title = `${path.basename(item.stat.path)} (${item.featureLabel})`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }),
  );

  const showLogsCmd = vscode.commands.registerCommand(
    'saifctl.showLogs',
    loggedCommand('saifctl.showLogs', () => {
      saifctlOutputChannel.show();
    }),
  );

  const recheckInstallCmd = vscode.commands.registerCommand(
    'saifctl.recheckInstall',
    loggedCommand(
      {
        commandId: 'saifctl.recheckInstall',
        endDetail: (installed) => (installed !== undefined ? `detected=${installed}` : undefined),
      },
      async (): Promise<boolean> => {
        const installed = await checkCliStatus();
        if (installed) {
          vscode.window.showInformationMessage('SaifCTL CLI detected successfully!');
          featuresProvider.refresh();
          runsProvider.refresh();
        } else {
          vscode.window.showErrorMessage(
            'SaifCTL CLI not found. Install locally (npm install @safe-ai-factory/saifctl) or globally (npm install -g @safe-ai-factory/saifctl), or set saifctl.binaryPath.',
          );
        }
        return installed;
      },
    ),
  );

  // ============================================================================
  // 5. Register Subscriptions
  // ============================================================================

  context.subscriptions.push(
    createFeatureCmd,
    createDirCmd,
    createFileCmd,
    refreshFeaturesCmd,
    filterFeaturesCmd,
    filterFeaturesActiveCmd,
    clearFilterFeaturesCmd,
    runFeatureCmd,
    designFeatureCmd,
    designFeatureSpecsCmd,
    validateFeatureTestsCmd,
    openFeatureProposalCmd,
    copyFeatureNameCmd,
    revealFeatureInExplorerCmd,
    refreshRunsCmd,
    filterRunsCmd,
    filterRunsActiveCmd,
    clearFilterRunsCmd,
    fromArtifactCmd,
    removeRunCmd,
    clearAllRunsCmd,
    revealRunInFinderCmd,
    copyRunIdCmd,
    copyRunNameCmd,
    copyRunStatusCmd,
    copyRunFeatureCmd,
    copyRunConfigValueCmd,
    copyRunConfigJsonCmd,
    copyRunConfigCliCmd,
    openRunFileDiffCmd,
    showLogsCmd,
    recheckInstallCmd,
  );
}

export function deactivate() {
  // Clean up any running child processes or terminals if necessary
}

///////////////////////////////////////////////////////////
// FILTERING
///////////////////////////////////////////////////////////

function updateFeaturesViewDescription(
  treeView: vscode.TreeView<unknown>,
  provider: FeaturesTreeProvider,
): void {
  const t = provider.filterText.trim();
  treeView.description = t ? `· "${t}"` : undefined;
}

function updateRunsViewDescription(
  treeView: vscode.TreeView<unknown>,
  provider: RunsTreeProvider,
): void {
  const parts: string[] = [];
  const t = provider.filterText.trim();
  if (t) parts.push(`"${t}"`);
  const statuses = [...provider.filterStatuses].sort((a, b) => a.localeCompare(b));
  if (statuses.length > 0) parts.push(statuses.join(', '));
  treeView.description = parts.length > 0 ? `· ${parts.join(' · ')}` : undefined;
}

const RUN_STATUS_VALUES: RunStatus[] = ['running', 'failed', 'completed', 'paused'];

function isRunStatus(s: string | undefined): s is RunStatus {
  return s !== undefined && (RUN_STATUS_VALUES as string[]).includes(s);
}

/** Status rows stay visible while typing a name/ID filter (VS Code 1.86+ alwaysShow). */
function runStatusFilterQuickPickItems(): vscode.QuickPickItem[] {
  return [
    { label: '$(sync~spin) Running', description: 'running', alwaysShow: true },
    { label: '$(error) Failed', description: 'failed', alwaysShow: true },
    { label: '$(pass) Completed', description: 'completed', alwaysShow: true },
    { label: '$(debug-pause) Paused', description: 'paused', alwaysShow: true },
  ];
}

function showFeaturesFilterQuickPick(
  featuresProvider: FeaturesTreeProvider,
  treeView: vscode.TreeView<unknown>,
): void {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Filter by feature name (substring match)…';
  qp.value = featuresProvider.filterText;
  qp.items = [];

  const apply = () => {
    featuresProvider.setFilter(qp.value);
    updateFeaturesViewDescription(treeView, featuresProvider);
    void vscode.commands.executeCommand(
      'setContext',
      'saifctl.featuresFilterActive',
      featuresProvider.isFiltered,
    );
  };

  qp.onDidChangeValue(apply);
  qp.onDidHide(() => qp.dispose());
  apply();
  qp.show();
}

function showRunsFilterQuickPick(
  runsProvider: RunsTreeProvider,
  treeView: vscode.TreeView<unknown>,
): void {
  const statusItems = runStatusFilterQuickPickItems();
  const qp = vscode.window.createQuickPick();
  qp.placeholder = 'Filter by run name or ID; toggle status rows below…';
  qp.value = runsProvider.filterText;
  qp.canSelectMany = true;
  qp.items = statusItems;

  const apply = () => {
    const statuses = new Set<RunStatus>();
    for (const i of qp.selectedItems) {
      if (isRunStatus(i.description)) statuses.add(i.description);
    }
    runsProvider.setFilter(qp.value, statuses);
    updateRunsViewDescription(treeView, runsProvider);
    void vscode.commands.executeCommand(
      'setContext',
      'saifctl.runsFilterActive',
      runsProvider.isFiltered,
    );
  };

  qp.selectedItems = statusItems.filter(
    (i) => isRunStatus(i.description) && runsProvider.filterStatuses.has(i.description),
  );
  qp.onDidChangeValue(apply);
  qp.onDidChangeSelection(apply);
  qp.onDidHide(() => qp.dispose());
  apply();
  qp.show();
}
