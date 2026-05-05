/**
 * Scaffold config.ts when no config file exists.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { pathExists, writeUtf8 } from '../utils/io.js';

const CONFIG_TEMPLATE = `import type { SaifctlConfig } from '@safe-ai-factory/saifctl';

/**
 * SaifCTL configuration.
 * See docs/config.md and docs/services.md
 */
const config: SaifctlConfig = {
  // CLI defaults
  defaults: {
    // project: 'my-app',
    // indexerProfile: 'shotgun',
  },
  environments: {
    coding: {
      // Docker is always the runtime. Optionally add a Compose file for ephemeral services:
      // file: './docker/docker-compose.dev.yml',
      // Or use Helm: engine: 'helm', chart: './k8s/charts/saifctl-mocks'
      engine: 'docker',
      agentEnvironment: {},
    },
    staging: {
      // Docker is always the runtime. Optionally add a Compose file for ephemeral services:
      // file: './docker/docker-compose.staging.yml',
      // Or use Helm: engine: 'helm', chart: './k8s/charts/saifctl-mocks'
      engine: 'docker',
      // Configure how to expose the code as application for testing:
      app: {
        sidecarPort: 8080,
        sidecarPath: '/exec',
        // baseUrl: 'http://staging:3000',
        // build: { dockerfile: './Dockerfile.staging' },
      },
      appEnvironment: {},
    },
  },
};

export default config;
`;

const SEARCH_PLACES = [
  'config.ts',
  'config.js',
  'config.cjs',
  'config.mjs',
  'config.json',
  'config.yaml',
  'config.yml',
];

export type ConfigScaffoldAction = 'created' | 'overwritten' | 'skipped';

export interface ConfigScaffoldResult {
  action: ConfigScaffoldAction;
  /** Absolute path of the file written, or of the existing variant when skipped. */
  path: string;
  /**
   * When `action === 'overwritten'`, this is the variant that already existed.
   * Always equals 'config.ts' for `created`. For `skipped`, the existing variant.
   */
  existingVariant: string | null;
}

/**
 * Scaffold saifctl/config.ts.
 *
 * Default behaviour (force=false): skip if any of the seven recognised config
 * variants (config.{ts,js,cjs,mjs,json,yaml,yml}) is already present.
 *
 * Force mode: write `config.ts` even if a variant exists. We only own
 * `config.ts` — other variants are left in place. cosmiconfig's search order
 * (see `loadSaifctlConfig`) prefers `config.ts` over later variants, so the
 * new file wins. The orphaned variant remains on disk; the caller is
 * responsible for surfacing a warning when relevant.
 *
 * @param opts.saifctlDir - Path to saifctl directory (e.g. "saifctl")
 * @param opts.projectDir - Project root
 * @param opts.force - When true, overwrite an existing variant by writing config.ts
 */
export async function scaffoldSaifctlConfig(opts: {
  saifctlDir: string;
  projectDir: string;
  force?: boolean;
}): Promise<ConfigScaffoldResult> {
  const { saifctlDir, projectDir, force = false } = opts;
  const configDir = resolve(projectDir, saifctlDir);

  let existingVariant: string | null = null;
  for (const name of SEARCH_PLACES) {
    if (await pathExists(resolve(configDir, name))) {
      existingVariant = name;
      break;
    }
  }

  const configPath = resolve(configDir, 'config.ts');

  if (existingVariant && !force) {
    return { action: 'skipped', path: resolve(configDir, existingVariant), existingVariant };
  }

  if (!(await pathExists(configDir))) {
    await mkdir(configDir, { recursive: true });
  }
  await writeUtf8(configPath, CONFIG_TEMPLATE);

  return existingVariant
    ? { action: 'overwritten', path: configPath, existingVariant }
    : { action: 'created', path: configPath, existingVariant: null };
}
