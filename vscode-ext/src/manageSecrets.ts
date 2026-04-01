/**
 * QuickPick UI for LLM API keys in SecretStorage + opening the primary .env file.
 */

import { basename, join } from 'node:path';

import * as vscode from 'vscode';

import { LLM_SECRET_KEY_LABELS, LLM_SECRET_KEY_NAMES } from './envKeys.js';
import { type EnvManager } from './envManager';
import { discoverSaifctlProjectsInWorkspaceRoots } from './projectDiscovery.js';

const EXTENSION_SETTINGS_QUERY = '@ext:jurooravec.saifctl';

function getEnvFileNamesFromConfig(): string[] {
  const raw = vscode.workspace.getConfiguration('saifctl').get<unknown>('envFiles');
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
  return ['.saifctl.env', '.env'];
}

/**
 * Ask where the env file should live, then open or create it there.
 * Order: SaifCTL projects (saifctl/features), workspace folders, folder picker (default: first workspace root).
 */
export async function pickAndOpenPrimaryEnvFile(): Promise<void> {
  const dir = await pickEnvFileTargetDirectory();
  if (dir) await openPrimaryEnvFileForProject(dir);
}

async function pickEnvFileTargetDirectory(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showWarningMessage('Open a workspace folder first.');
    return undefined;
  }

  const roots = folders.map((f) => f.uri.fsPath);
  const projects = await discoverSaifctlProjectsInWorkspaceRoots(roots);

  interface LocPick extends vscode.QuickPickItem {
    targetPath?: string;
    isManual?: boolean;
  }

  const items: LocPick[] = [];

  if (projects.length > 0) {
    items.push({ label: 'SaifCTL projects', kind: vscode.QuickPickItemKind.Separator });
    for (const p of projects) {
      items.push({
        label: `$(folder-library) ${p.name}`,
        description: p.projectPath,
        targetPath: p.projectPath,
      });
    }
  }

  items.push({ label: 'Workspace folders', kind: vscode.QuickPickItemKind.Separator });
  for (const f of folders) {
    items.push({
      label: `$(root-folder) ${f.name}`,
      description: f.uri.fsPath,
      targetPath: f.uri.fsPath,
    });
  }

  items.push({
    label: '$(folder-opened) Choose folder…',
    description: `Pick any directory (starts in ${basename(roots[0] ?? '') || roots[0]})`,
    isManual: true,
  });

  const picked = await vscode.window.showQuickPick<LocPick>(items, {
    placeHolder: 'Where should the env file live?',
    title: 'Open primary env file',
  });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return undefined;

  if (picked.isManual) {
    const dirs = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: folders[0]!.uri,
      openLabel: 'Select folder',
      title: 'Folder for env file (see saifctl.envFiles)',
    });
    return dirs?.[0]?.fsPath;
  }

  return picked.targetPath;
}

/** Open or create the first configured env file under `projectRoot`. */
export async function openPrimaryEnvFileForProject(projectRoot: string): Promise<void> {
  const names = getEnvFileNamesFromConfig();
  const primary = names[0] ?? '.saifctl.env';
  const uri = vscode.Uri.file(join(projectRoot, primary));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const header = `# SaifCTL — LLM and other env vars (do not commit secrets)\n# Example:\n# ANTHROPIC_API_KEY=sk-ant-...\n\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(header));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

export async function showManageSecretsQuickPick(envManager: EnvManager): Promise<void> {
  const configured = await envManager.listConfiguredSecretKeys();

  type ActionKind = 'add' | 'remove' | 'openEnv' | 'settings' | 'key';

  interface SecretQuickPickItem extends vscode.QuickPickItem {
    action: ActionKind;
    keyName?: string;
  }

  const items: SecretQuickPickItem[] = [];

  items.push({ action: 'add', label: '$(add) Add or update a key', alwaysShow: true });
  if (configured.length > 0) {
    items.push({ action: 'remove', label: '$(trash) Remove a key', alwaysShow: true });
  }
  items.push({ action: 'openEnv', label: '$(file) Open primary env file', alwaysShow: true });
  items.push({ action: 'settings', label: '$(gear) Open extension settings', alwaysShow: true });

  for (const name of configured.sort()) {
    const secret = await envManager.getSecret(name);
    const masked = secret ? envManager.maskValue(secret) : '';
    items.push({
      action: 'key',
      keyName: name,
      label: `$(key) ${name}`,
      description: LLM_SECRET_KEY_LABELS[name] ?? 'Custom',
      detail: masked,
    });
  }

  const picked = await vscode.window.showQuickPick<SecretQuickPickItem>(items, {
    placeHolder: 'SaifCTL API keys (stored in OS secure storage)',
    title: 'Manage API Keys',
  });
  if (!picked) return;

  if (picked.action === 'add') {
    await promptAddOrUpdateSecret(envManager);
    return;
  }
  if (picked.action === 'remove') {
    await promptRemoveSecret(envManager);
    return;
  }
  if (picked.action === 'openEnv') {
    await pickAndOpenPrimaryEnvFile();
    return;
  }
  if (picked.action === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', EXTENSION_SETTINGS_QUERY);
    return;
  }
  if (picked.action === 'key' && picked.keyName) {
    await promptUpdateSingleSecret(envManager, picked.keyName);
  }
}

async function promptAddOrUpdateSecret(envManager: EnvManager): Promise<void> {
  type KeyPick = vscode.QuickPickItem & { isCustom?: boolean };
  const keyChoices: KeyPick[] = [...LLM_SECRET_KEY_NAMES].map((name) => ({
    label: name,
    description: LLM_SECRET_KEY_LABELS[name] ?? '',
  }));
  keyChoices.push({
    label: 'Custom…',
    description: 'Enter any environment variable name',
    isCustom: true,
    alwaysShow: true,
  });

  const keyPick = await vscode.window.showQuickPick<KeyPick>(keyChoices, {
    placeHolder: 'Which API key?',
  });
  if (!keyPick) return;

  let varName: string;
  if (keyPick.isCustom) {
    const entered = await vscode.window.showInputBox({
      prompt: 'Environment variable name (e.g. MY_PROVIDER_API_KEY)',
      validateInput: (s) => {
        const t = s.trim();
        if (!t) return 'Required';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
          return 'Use letters, numbers, and underscores only';
        }
        return undefined;
      },
      ignoreFocusOut: true,
    });
    if (!entered) return;
    varName = entered.trim();
  } else {
    varName = keyPick.label;
  }

  const value = await vscode.window.showInputBox({
    prompt: `Value for ${varName}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value == null || value.trim().length === 0) return;

  await envManager.setSecret(varName, value.trim());
  void vscode.window.showInformationMessage(`Saved ${varName} to secure storage.`);
}

async function promptUpdateSingleSecret(envManager: EnvManager, varName: string): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: `New value for ${varName}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value == null || value.trim().length === 0) return;
  await envManager.setSecret(varName, value.trim());
  void vscode.window.showInformationMessage(`Updated ${varName} in secure storage.`);
}

async function promptRemoveSecret(envManager: EnvManager): Promise<void> {
  const configured = await envManager.listConfiguredSecretKeys();
  if (configured.length === 0) return;

  const choices = configured.sort().map((name) => ({
    label: name,
    description: LLM_SECRET_KEY_LABELS[name] ?? 'Custom',
  }));
  const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Remove which key?' });
  if (!picked) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove ${picked.label} from secure storage?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;

  await envManager.deleteSecret(picked.label);
  void vscode.window.showInformationMessage(`Removed ${picked.label} from secure storage.`);
}
