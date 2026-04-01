import * as vscode from 'vscode';

import { type EnvManager } from './envManager';

export interface ApiKeyGuardCallbacks {
  onConfigureKeys: () => Promise<void>;
  onOpenEnvFile: () => Promise<void>;
}

export interface EnsureLlmApiKeyOpts {
  envManager: EnvManager;
  cwd: string;
  callbacks: ApiKeyGuardCallbacks;
}

export async function ensureLlmApiKeyOrNotify(opts: EnsureLlmApiKeyOpts): Promise<boolean> {
  const { envManager, cwd, callbacks } = opts;
  if (await envManager.mergedEnvHasApiCredentials(cwd)) return true;

  const sel = await vscode.window.showErrorMessage(
    'SaifCTL: No LLM API key found. Add one in secure storage or a project .env file (see saifctl.envFiles).',
    'Configure Keys',
    'Open .saifctl.env',
  );
  if (sel === 'Configure Keys') await callbacks.onConfigureKeys();
  else if (sel === 'Open .saifctl.env') await callbacks.onOpenEnvFile();
  return false;
}

export interface WithApiKeyGuardOpts<T extends unknown[]> {
  envManager: EnvManager;
  getCwd: (...args: T) => string;
  callbacks: ApiKeyGuardCallbacks;
  callback: (...args: T) => unknown | Promise<unknown>;
}

/**
 * Wraps a handler: runs only if CLI is already OK (caller applies withCliGuard first) and an LLM key is present.
 * `getCwd` receives the same args as the handler.
 */
export function withApiKeyGuard<T extends unknown[]>(
  opts: WithApiKeyGuardOpts<T>,
): (...args: T) => Promise<unknown> {
  const { envManager, getCwd, callbacks, callback } = opts;
  return async (...args: T) => {
    const cwd = getCwd(...args);
    const ok = await ensureLlmApiKeyOrNotify({ envManager, cwd, callbacks });
    if (!ok) return;
    return await callback(...args);
  };
}
