/**
 * Resolves process env for saifctl: base process.env + first matching .env file + SecretStorage overrides.
 */

import { join } from 'node:path';

import * as vscode from 'vscode';

import { hasAnyKnownLlmKeyInEnv, LLM_SECRET_KEY_NAMES, parseDotEnv } from './envKeys.js';

const SECRET_PREFIX = 'saifctl.env.';

/** JSON array of user-defined env var names (SecretStorage cannot list keys). */
const CUSTOM_KEY_NAMES_META = 'saifctl.customEnvKeyNames';

const STD_LLM_KEYS = LLM_SECRET_KEY_NAMES as readonly string[];

function isStdLlmKey(name: string): boolean {
  return STD_LLM_KEYS.includes(name);
}

function secretStorageKeyForEnvVar(name: string): string {
  return `${SECRET_PREFIX}${name}`;
}

function getEnvFileNames(): string[] {
  const raw = vscode.workspace.getConfiguration('saifctl').get<unknown>('envFiles');
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
  return ['.saifctl.env', '.env'];
}

export class EnvManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** True if merged env has a non-empty value for at least one known LLM key. */
  hasAnyKnownLlmKey(env: NodeJS.ProcessEnv): boolean {
    return hasAnyKnownLlmKeyInEnv(env);
  }

  /**
   * After {@link resolveEnv}, true if any standard LLM key or any registered custom secret key is set.
   * Used for the “run agent” guard when credentials live only in SecretStorage under a custom name.
   */
  async mergedEnvHasApiCredentials(projectDir: string): Promise<boolean> {
    const env = await this.resolveEnv(projectDir);
    if (hasAnyKnownLlmKeyInEnv(env)) return true;
    for (const name of await this.readCustomKeyNames()) {
      const v = env[name];
      if (typeof v === 'string' && v.trim().length > 0) return true;
    }
    return false;
  }

  private async readCustomKeyNames(): Promise<string[]> {
    const raw = await this.context.secrets.get(CUSTOM_KEY_NAMES_META);
    if (!raw?.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (x): x is string => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x),
      );
    } catch {
      return [];
    }
  }

  private async writeCustomKeyNames(names: string[]): Promise<void> {
    const uniq = [...new Set(names)]
      .filter((n) => !isStdLlmKey(n))
      .sort((a, b) => a.localeCompare(b));
    await this.context.secrets.store(CUSTOM_KEY_NAMES_META, JSON.stringify(uniq));
  }

  private async registerCustomKeyName(name: string): Promise<void> {
    if (isStdLlmKey(name)) return;
    const cur = await this.readCustomKeyNames();
    if (cur.includes(name)) return;
    await this.writeCustomKeyNames([...cur, name]);
  }

  private async unregisterCustomKeyName(name: string): Promise<void> {
    const cur = await this.readCustomKeyNames();
    await this.writeCustomKeyNames(cur.filter((n) => n !== name));
  }

  async resolveEnv(projectDir: string): Promise<NodeJS.ProcessEnv> {
    const base: NodeJS.ProcessEnv = { ...process.env };
    const fileNames = getEnvFileNames();
    for (const name of fileNames) {
      const rel = name.trim();
      if (!rel) continue;
      const uri = vscode.Uri.file(join(projectDir, rel));
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(bytes);
        const parsed = parseDotEnv(text);
        for (const [k, v] of Object.entries(parsed)) {
          base[k] = v;
        }
        break;
      } catch {
        // try next filename
      }
    }

    for (const name of LLM_SECRET_KEY_NAMES) {
      const stored = await this.context.secrets.get(secretStorageKeyForEnvVar(name));
      if (stored != null && stored.trim().length > 0) {
        base[name] = stored;
      }
    }

    for (const name of await this.readCustomKeyNames()) {
      const stored = await this.context.secrets.get(secretStorageKeyForEnvVar(name));
      if (stored != null && stored.trim().length > 0) {
        base[name] = stored;
      }
    }

    return base;
  }

  async listConfiguredSecretKeys(): Promise<string[]> {
    const configured: string[] = [];
    for (const name of LLM_SECRET_KEY_NAMES) {
      const v = await this.context.secrets.get(secretStorageKeyForEnvVar(name));
      if (v != null && v.trim().length > 0) configured.push(name);
    }
    for (const name of await this.readCustomKeyNames()) {
      if (isStdLlmKey(name)) continue;
      const v = await this.context.secrets.get(secretStorageKeyForEnvVar(name));
      if (v != null && v.trim().length > 0) configured.push(name);
    }
    return [...new Set(configured)].sort((a, b) => a.localeCompare(b));
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.context.secrets.store(secretStorageKeyForEnvVar(name), value);
    await this.registerCustomKeyName(name);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.context.secrets.delete(secretStorageKeyForEnvVar(name));
    await this.unregisterCustomKeyName(name);
  }

  async getSecret(name: string): Promise<string | undefined> {
    return (await this.context.secrets.get(secretStorageKeyForEnvVar(name))) ?? undefined;
  }

  maskValue(value: string): string {
    const t = value.trim();
    if (t.length <= 10) return '•••';
    return `${t.slice(0, 10)}•••`;
  }
}
