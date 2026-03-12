/**
 * Safe AI Factory VS Code Extension
 *
 * Central controller wiring package.json commands to SaifCliService.
 * Tree providers (FeaturesTreeProvider, RunsTreeProvider) to be added next.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { SaifCliService } from './cliService';
import { FeatureItem, FeaturesTreeProvider } from './FeaturesTreeProvider';
import { saifLogger } from './logger';
import { RunItem, RunProjectItem, RunsTreeProvider } from './RunsTreeProvider';

export async function activate(context: vscode.ExtensionContext) {
  console.log('Safe AI Factory extension is now active!');

  const cliService = new SaifCliService();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage('SAIF: Please open a workspace folder to use the extension.');
    return;
  }

  // ============================================================================
  // 0. Environment & Dependency Checks (Graceful Degradation)
  // ============================================================================

  let isCliCurrentlyInstalled = false;

  const checkCliStatus = async (): Promise<boolean> => {
    isCliCurrentlyInstalled = await cliService.isCliInstalled();
    await vscode.commands.executeCommand(
      'setContext',
      'saif.isCliInstalled',
      isCliCurrentlyInstalled,
    );
    return isCliCurrentlyInstalled;
  };

  const withCliGuard = <T extends unknown[]>(callback: (...args: T) => void | Promise<void>) => {
    return async (...args: T) => {
      if (!isCliCurrentlyInstalled) {
        const selection = await vscode.window.showWarningMessage(
          'The SAIF CLI is required to perform this action.',
          'Install SAIF',
        );
        if (selection === 'Install SAIF') {
          await vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/JuroOravec/safe-ai-factory'),
          );
        }
        return;
      }
      return callback(...args);
    };
  };

  await checkCliStatus();

  // ============================================================================
  // 1. Tree Providers Setup
  // ============================================================================

  const featuresProvider = new FeaturesTreeProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider('saif-features', featuresProvider);

  // File watcher for saif/features
  const watcher = vscode.workspace.createFileSystemWatcher('**/saif/features/**');
  watcher.onDidCreate(() => featuresProvider.refresh());
  watcher.onDidChange(() => featuresProvider.refresh());
  watcher.onDidDelete(() => featuresProvider.refresh());
  context.subscriptions.push(watcher);

  // Watcher for saif dir creation/deletion to automatically pick up new projects
  const saifWatcher = vscode.workspace.createFileSystemWatcher('**/saif');
  saifWatcher.onDidCreate(() => featuresProvider.refresh());
  saifWatcher.onDidDelete(() => featuresProvider.refresh());
  context.subscriptions.push(saifWatcher);

  const runsProvider = new RunsTreeProvider(workspaceRoot, cliService);
  vscode.window.registerTreeDataProvider('saif-runs', runsProvider);

  const getItemName = (item: vscode.TreeItem | undefined): string | undefined => {
    if (!item) return undefined;
    return typeof item.label === 'string' ? item.label : item.label?.label;
  };

  // ============================================================================
  // 2. Feature Management Commands
  // ============================================================================

  const createFeatureCmd = vscode.commands.registerCommand(
    'saif.createFeature',
    withCliGuard(async () => {
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
  );

  const createDirCmd = vscode.commands.registerCommand(
    'saif.createDir',
    async (item?: vscode.TreeItem) => {
      const dirName = await vscode.window.showInputBox({
        prompt: 'Enter folder name',
      });
      const basePath = item?.resourceUri?.fsPath ?? path.join(workspaceRoot, 'saif', 'features');
      if (dirName) {
        const newDirPath = vscode.Uri.file(path.join(basePath, dirName));
        await vscode.workspace.fs.createDirectory(newDirPath);
        featuresProvider.refresh();
      }
    },
  );

  const createFileCmd = vscode.commands.registerCommand(
    'saif.createFile',
    async (item?: vscode.TreeItem) => {
      const fileName = await vscode.window.showInputBox({
        prompt: 'Enter file name',
      });
      const basePath = item?.resourceUri?.fsPath ?? path.join(workspaceRoot, 'saif', 'features');
      if (fileName) {
        const newFilePath = vscode.Uri.file(path.join(basePath, fileName));
        await vscode.workspace.fs.writeFile(newFilePath, new Uint8Array());
        featuresProvider.refresh();
      }
    },
  );

  const refreshFeaturesCmd = vscode.commands.registerCommand('saif.refreshFeatures', () => {
    featuresProvider.refresh();
  });

  const getCwdForFeature = (item?: vscode.TreeItem): string =>
    item instanceof FeatureItem ? item.projectPath : workspaceRoot;

  const runFeatureCmd = vscode.commands.registerCommand(
    'saif.runFeature',
    withCliGuard((item?: vscode.TreeItem) => {
      const name = getItemName(item);
      const cwd = getCwdForFeature(item);
      if (name) cliService.runFeature(name, cwd);
    }),
  );

  const debugFeatureCmd = vscode.commands.registerCommand(
    'saif.debugFeature',
    withCliGuard((item?: vscode.TreeItem) => {
      const name = getItemName(item);
      const cwd = getCwdForFeature(item);
      if (name) cliService.debugFeature(name, cwd);
    }),
  );

  const designFeatureCmd = vscode.commands.registerCommand(
    'saif.designFeature',
    withCliGuard((item?: vscode.TreeItem) => {
      const name = getItemName(item);
      const cwd = getCwdForFeature(item);
      if (name) cliService.designFeature(name, cwd);
    }),
  );

  // ============================================================================
  // 3. Run Management Commands
  // ============================================================================

  const refreshRunsCmd = vscode.commands.registerCommand(
    'saif.refreshRuns',
    withCliGuard(() => {
      runsProvider.refresh();
    }),
  );

  const getCwdForRun = (item?: vscode.TreeItem): string =>
    item instanceof RunItem ? item.projectPath : workspaceRoot;

  const resumeRunCmd = vscode.commands.registerCommand(
    'saif.resumeRun',
    withCliGuard((item?: vscode.TreeItem) => {
      const runId = item?.id ?? getItemName(item);
      const cwd = getCwdForRun(item);
      if (runId) cliService.resumeRun(runId, cwd);
    }),
  );

  const removeRunCmd = vscode.commands.registerCommand(
    'saif.removeRun',
    withCliGuard(async (item?: vscode.TreeItem) => {
      const runId = item?.id ?? getItemName(item);
      const cwd = getCwdForRun(item);
      if (runId) {
        await cliService.removeRun(runId, cwd);
        runsProvider.refresh();
      }
    }),
  );

  const clearAllRunsCmd = vscode.commands.registerCommand(
    'saif.clearAllRuns',
    withCliGuard(async (item?: vscode.TreeItem) => {
      const targetCwd =
        item instanceof RunProjectItem ? path.join(workspaceRoot, item.projectName) : workspaceRoot;
      await cliService.clearAllRuns(targetCwd);
      runsProvider.refresh();
    }),
  );

  const revealRunInFinderCmd = vscode.commands.registerCommand(
    'saif.revealRunInFinder',
    (item?: vscode.TreeItem) => {
      const runId = item?.id ?? getItemName(item);
      const cwd = getCwdForRun(item);
      if (runId) {
        const runFilePath = vscode.Uri.file(path.join(cwd, '.saif', 'runs', `${runId}.json`));
        void vscode.commands.executeCommand('revealFileInOS', runFilePath);
      }
    },
  );

  const copyRunIdCmd = vscode.commands.registerCommand(
    'saif.copyRunId',
    async (item?: vscode.TreeItem) => {
      const runId = item?.id ?? getItemName(item);
      if (runId) {
        await vscode.env.clipboard.writeText(runId);
        vscode.window.showInformationMessage(`Copied Run ID: ${runId}`);
      }
    },
  );

  const copyRunNameCmd = vscode.commands.registerCommand(
    'saif.copyRunName',
    async (item?: vscode.TreeItem) => {
      const name = item instanceof RunItem ? item.runData.name : getItemName(item);
      if (name) {
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied Run Name: ${name}`);
      }
    },
  );

  const showLogsCmd = vscode.commands.registerCommand('saif.showLogs', () => {
    saifLogger.show();
  });

  const recheckInstallCmd = vscode.commands.registerCommand('saif.recheckInstall', async () => {
    const installed = await checkCliStatus();
    if (installed) {
      vscode.window.showInformationMessage('SAIF CLI detected successfully!');
      featuresProvider.refresh();
      runsProvider.refresh();
    } else {
      vscode.window.showErrorMessage('SAIF CLI still not found in PATH.');
    }
  });

  // ============================================================================
  // 4. Register Subscriptions
  // ============================================================================

  context.subscriptions.push(
    createFeatureCmd,
    createDirCmd,
    createFileCmd,
    refreshFeaturesCmd,
    runFeatureCmd,
    debugFeatureCmd,
    designFeatureCmd,
    refreshRunsCmd,
    resumeRunCmd,
    removeRunCmd,
    clearAllRunsCmd,
    revealRunInFinderCmd,
    copyRunIdCmd,
    copyRunNameCmd,
    showLogsCmd,
    recheckInstallCmd,
  );
}

export function deactivate() {
  // Clean up any running child processes or terminals if necessary
}
