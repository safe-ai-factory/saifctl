/**
 * Scaffold config.ts when no config file exists.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { pathExists, writeUtf8 } from '../utils/io.js';

const CONFIG_TEMPLATE = `import type { SaifConfig } from 'safe-ai-factory';

/**
 * SAIFAC configuration.
 * See docs/config.md and docs/services.md
 */
const config: SaifConfig = {
  // CLI defaults
  defaults: {
    // project: 'my-app',
    // indexerProfile: 'shotgun',
  },
  environments: {
    coding: {
      // Docker is always the runtime. Optionally add a Compose file for ephemeral services:
      // file: './docker/docker-compose.dev.yml',
      // Or use Helm: provisioner: 'helm', chart: './k8s/charts/saifac-mocks'
      provisioner: 'docker',
      agentEnvironment: {},
    },
    staging: {
      // Docker is always the runtime. Optionally add a Compose file for ephemeral services:
      // file: './docker/docker-compose.staging.yml',
      // Or use Helm: provisioner: 'helm', chart: './k8s/charts/saifac-mocks'
      provisioner: 'docker',
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

/**
 * Scaffold saifac/config.ts if the saifac directory has no config file.
 * Creates saifDir when it does not exist.
 *
 * @param saifDir - Path to saifac directory (e.g. "saifac")
 * @param projectDir - Project root
 * @returns true if a config was scaffolded, false if one already existed
 */
export async function scaffoldSaifConfig(saifDir: string, projectDir: string): Promise<boolean> {
  const configDir = resolve(projectDir, saifDir);

  for (const name of SEARCH_PLACES) {
    if (await pathExists(resolve(configDir, name))) {
      return false; // config already exists
    }
  }

  if (!(await pathExists(configDir))) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = resolve(configDir, 'config.ts');
  await writeUtf8(configPath, CONFIG_TEMPLATE);
  return true;
}
