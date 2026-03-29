/**
 * Load saifctl config from saifctlDir using cosmiconfig.
 *
 * Config can be written as config.json, config.yml, config.js, config.ts, etc.
 * Returns empty defaults when no config file exists.
 */

import { resolve } from 'node:path';

import { cosmiconfig } from 'cosmiconfig';

import { consola } from '../logger.js';
import { pathExists } from '../utils/io.js';
import { type SaifctlConfig, saifctlConfigSchema } from './schema.js';

const EXPLORER = cosmiconfig('saifctl', {
  searchPlaces: [
    'config.ts',
    'config.js',
    'config.mjs',
    'config.json',
    'config.yaml',
    'config.yml',
    'config.cjs',
  ],
  searchStrategy: 'none' as const,
});

/**
 * Load config from saifctlDir. Resolves saifctlDir relative to projectDir when saifctlDir
 * is not absolute.
 *
 * @param saifctlDir - Path to saifctl directory (default "saifctl", can be relative to cwd or projectDir)
 * @param projectDir - Project root (for resolving relative saifctlDir when needed)
 * @returns Parsed and validated config, or empty defaults if no file found
 */
export async function loadSaifctlConfig(
  saifctlDir: string,
  projectDir: string,
): Promise<SaifctlConfig> {
  const configDir = resolve(projectDir, saifctlDir);
  if (!(await pathExists(configDir))) {
    return {};
  }

  const result = await EXPLORER.search(configDir);
  if (!result?.config) {
    return {};
  }

  try {
    return saifctlConfigSchema.parse(result.config);
  } catch (err) {
    consola.error(`Error parsing config at ${result.filepath}:`);
    consola.error(err);
    process.exit(1);
  }
}
