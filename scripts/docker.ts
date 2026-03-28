#!/usr/bin/env tsx
/**
 * Docker CLI — build and clear factory container images.
 *
 * Usage: pnpm docker <action> [image] [options]
 *   build test       Build test runner image(s) (default: node-vitest, --all: all profiles)
 *   build coder      Build coder image (default: node-pnpm-python, --all: all profiles)
 *   clear            Remove factory containers/images (scoped to project; --all: everything)
 *
 * Optional on all build subcommands: --skip-existing  Skip docker build when the target tag
 *   already exists locally (docker image inspect). Does not detect stale Dockerfiles.
 */

import { resolve } from 'node:path';

import { defineCommand, runMain } from 'citty';

import { getSaifctlRoot } from '../src/constants.js';
import { consola } from '../src/logger.js';
import {
  DEFAULT_SANDBOX_PROFILE,
  resolveSandboxCoderDockerfilePath,
  resolveSandboxProfile,
  type SandboxProfile,
  SUPPORTED_SANDBOX_PROFILES,
} from '../src/sandbox-profiles/index.js';
import {
  DEFAULT_TEST_PROFILE,
  resolveTestDockerfilePath,
  resolveTestProfile,
  SUPPORTED_PROFILES,
  type TestProfile,
} from '../src/test-profiles/index.js';
import { pathExists, readUtf8, spawnAsync, spawnCapture, spawnWait } from '../src/utils/io.js';

async function dockerImageExistsLocally(imageRef: string): Promise<boolean> {
  const r = await spawnWait({
    command: 'docker',
    args: ['image', 'inspect', imageRef],
    cwd: process.cwd(),
  });
  return r.code === 0;
}

/** Prefix for logs when `pnpm docker build … --all` iterates many images (e.g. `[2/8] `). */
function buildAllProgressPrefix(opts: {
  buildAll: boolean;
  indexOneBased: number;
  total: number;
}): string {
  const { buildAll, indexOneBased, total } = opts;
  if (!buildAll || total < 1) return '';
  return `[${indexOneBased}/${total}] `;
}

async function parseProjectName(opts: { project?: string }): Promise<string> {
  const fromOpt =
    typeof opts.project === 'string' && opts.project.trim() ? opts.project.trim() : '';
  if (fromOpt) return fromOpt;

  const repoRoot = getSaifctlRoot();
  try {
    const pkg = JSON.parse(await readUtf8(resolve(repoRoot, 'package.json'))) as {
      name?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim();
  } catch {
    throw new Error(
      `Cannot determine project name. Specify --project or ensure package.json exists at ${repoRoot}.`,
    );
  }

  throw new Error(`package.json has no "name" field. Specify --project.`);
}

function validateImageTag(tag: string, flagName: string): void {
  if (!/^[a-zA-Z0-9_.\-:/@]+$/.test(tag)) {
    consola.error(
      `Invalid ${flagName} value: "${tag}". Image tags must contain only letters, digits, hyphens, underscores, dots, colons, slashes, and @.`,
    );
    process.exit(1);
  }
}

// ── test build ───────────────────────────────────────────────────────────────

const testBuildCommand = defineCommand({
  meta: {
    name: 'test',
    description: 'Build test runner image(s). Default: node-vitest. Use --all for all profiles.',
  },
  args: {
    all: { type: 'boolean', description: 'Build all test profiles' },
    'test-profile': { type: 'string', description: 'Test profile (default: node-vitest)' },
    'test-image': { type: 'string', description: 'Image tag override' },
    'skip-existing': {
      type: 'boolean',
      description: 'Skip build if the target image tag already exists locally',
    },
  },
  async run({ args }) {
    const repoRoot = getSaifctlRoot();
    const buildAll = args.all === true;
    const skipExisting = args['skip-existing'] === true;

    const profilesToBuild: TestProfile[] = buildAll
      ? Object.values(SUPPORTED_PROFILES)
      : [args['test-profile'] ? resolveTestProfile(args['test-profile']) : DEFAULT_TEST_PROFILE];

    consola.log(
      buildAll
        ? `\nBuilding all ${profilesToBuild.length} test runner images...`
        : '\nBuilding test runner image...',
    );
    consola.log('  (this only needs to run once; images are cached locally)\n');
    if (skipExisting) {
      consola.log('  (--skip-existing: will not rebuild tags already present locally)\n');
    }

    let built = 0;
    let skipped = 0;

    const testTotal = profilesToBuild.length;
    for (let ti = 0; ti < profilesToBuild.length; ti++) {
      const profile = profilesToBuild[ti]!;
      const progress = buildAllProgressPrefix({
        buildAll,
        indexOneBased: ti + 1,
        total: testTotal,
      });
      const tag = buildAll
        ? `saifctl-test-${profile.id}:latest`
        : args['test-image']?.trim() || `saifctl-test-${profile.id}:latest`;
      if (!buildAll) validateImageTag(tag, '--test-image');

      const dockerfilePath = resolveTestDockerfilePath(profile.id);
      if (!(await pathExists(dockerfilePath))) {
        consola.error(`${progress}${dockerfilePath} not found for profile ${profile.id}`);
        process.exit(1);
      }

      if (skipExisting && (await dockerImageExistsLocally(tag))) {
        consola.log(`${progress}Skipping (already exists): ${tag}  [${profile.id}]`);
        skipped++;
        continue;
      }

      consola.log(`${progress}Building: ${tag}`);
      consola.log(`${progress}  Dockerfile: ${dockerfilePath}`);

      try {
        await spawnAsync({
          command: 'docker',
          args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
          cwd: repoRoot,
          stdio: 'inherit',
        });
      } catch {
        consola.error(`\n${progress}docker build failed for ${profile.id}`);
        process.exit(1);
      }
      consola.log(`${progress}  => ${tag}\n`);
      built++;
    }

    if (built === 0 && skipped > 0) {
      consola.log(`Test images: ${skipped} already present; nothing to build.`);
    } else if (skipped > 0) {
      consola.log(`Test images: built ${built}, skipped ${skipped} (already exist).`);
    } else {
      consola.log('Test image(s) built successfully.');
    }
    if (!buildAll) {
      const tag = args['test-image']?.trim() || `saifctl-test-${profilesToBuild[0]!.id}:latest`;
      consola.log(`Use it with: npx saifctl feat run --test-image ${tag}`);
    }
  },
});

// ── coder build ─────────────────────────────────────────────────────────────

const coderBuildCommand = defineCommand({
  meta: {
    name: 'coder',
    description:
      'Build coder image. Default: node-pnpm-python. Use --all for all sandbox profiles.',
  },
  args: {
    all: { type: 'boolean', description: 'Build all sandbox profiles' },
    profile: { type: 'string', description: 'Sandbox profile (default: node-pnpm-python)' },
    'coder-image': { type: 'string', description: 'Image tag override' },
    'skip-existing': {
      type: 'boolean',
      description: 'Skip build if the target image tag already exists locally',
    },
  },
  async run({ args }) {
    const repoRoot = getSaifctlRoot();
    const buildAll = args.all === true;
    const skipExisting = args['skip-existing'] === true;

    const profilesToBuild: SandboxProfile[] = buildAll
      ? Object.values(SUPPORTED_SANDBOX_PROFILES)
      : [args.profile ? resolveSandboxProfile(args.profile) : DEFAULT_SANDBOX_PROFILE];

    consola.log(
      buildAll
        ? `\nBuilding all ${profilesToBuild.length} coder images...`
        : '\nBuilding coder image...',
    );
    consola.log('  (this only needs to run once; images are cached locally)\n');
    if (skipExisting) {
      consola.log('  (--skip-existing: will not rebuild tags already present locally)\n');
    }

    let coderBuilt = 0;
    let coderSkipped = 0;

    const coderTotal = profilesToBuild.length;
    for (let ci = 0; ci < profilesToBuild.length; ci++) {
      const profile = profilesToBuild[ci]!;
      const progress = buildAllProgressPrefix({
        buildAll,
        indexOneBased: ci + 1,
        total: coderTotal,
      });
      const tag = buildAll
        ? profile.coderImageTag
        : args['coder-image']?.trim() || profile.coderImageTag;
      if (!buildAll && args['coder-image']) validateImageTag(tag, '--coder-image');

      const dockerfilePath = resolveSandboxCoderDockerfilePath(profile.id);
      if (!(await pathExists(dockerfilePath))) {
        consola.error(`${progress}${dockerfilePath} not found for profile ${profile.id}`);
        process.exit(1);
      }

      if (skipExisting && (await dockerImageExistsLocally(tag))) {
        consola.log(`${progress}Skipping (already exists): ${tag}  [${profile.id}]`);
        coderSkipped++;
        continue;
      }

      consola.log(`${progress}Building: ${tag}`);
      consola.log(`${progress}  Profile:    ${profile.id} (${profile.displayName})`);
      consola.log(`${progress}  Dockerfile: ${dockerfilePath}`);

      try {
        await spawnAsync({
          command: 'docker',
          args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
          cwd: repoRoot,
          stdio: 'inherit',
        });
      } catch {
        consola.error(`\n${progress}docker build failed for ${profile.id}`);
        process.exit(1);
      }
      consola.log(`${progress}  => ${tag}\n`);
      coderBuilt++;
    }

    if (coderBuilt === 0 && coderSkipped > 0) {
      consola.log(`Coder images: ${coderSkipped} already present; nothing to build.`);
    } else if (coderSkipped > 0) {
      consola.log(`Coder images: built ${coderBuilt}, skipped ${coderSkipped} (already exist).`);
    } else {
      consola.log('Coder image(s) built successfully.');
    }
    if (!buildAll) {
      const profile = profilesToBuild[0]!;
      const tag = args['coder-image']?.trim() || profile.coderImageTag;
      consola.log(`Use it with: saifctl feat run --profile ${profile.id}`);
      consola.log(`Override: saifctl feat run --coder-image ${tag}`);
    }
  },
});

// ── clear ───────────────────────────────────────────────────────────────────

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description:
      'Remove factory containers and images (scoped to project by default; --all: everything)',
  },
  args: {
    all: { type: 'boolean', description: 'Remove all factory resources (all projects)' },
    project: {
      type: 'string',
      alias: 'p',
      description: 'Project name override (from package.json)',
    },
  },
  async run({ args }) {
    const clearAll = args.all === true;
    const projName = clearAll ? null : await parseProjectName(args);

    const stagingPrefix = clearAll ? 'saifctl-stage-' : `saifctl-stage-${projName}-`;
    const testRunnerPrefix = clearAll ? 'saifctl-test-' : `saifctl-test-${projName}-`;
    const networkPrefix = clearAll ? 'saifctl-net-' : `saifctl-net-${projName}-`;

    let removedContainers = 0;
    let removedImages = 0;
    let removedNetworks = 0;

    const removeContainersByPrefix = async (prefix: string): Promise<number> => {
      let lines: string;
      try {
        lines = (
          await spawnCapture({
            command: 'docker',
            args: ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=${prefix}`],
            cwd: process.cwd(),
          })
        ).trim();
      } catch {
        consola.error('Failed to list Docker containers. Is Docker running?');
        process.exit(1);
      }
      const names = lines ? lines.split('\n').filter(Boolean) : [];
      const matching = names.filter((n) => n.startsWith(prefix));
      let removed = 0;
      for (const name of matching) {
        try {
          await spawnAsync({
            command: 'docker',
            args: ['rm', '-f', name],
            cwd: process.cwd(),
            stdio: 'pipe',
          });
          consola.log(`  removed container: ${name}`);
          removed++;
        } catch (err) {
          consola.warn(`  warning: could not remove container ${name}: ${String(err)}`);
        }
      }
      return removed;
    };

    consola.log(`\nListing staging containers (prefix: ${stagingPrefix}*)...`);
    removedContainers += await removeContainersByPrefix(stagingPrefix);

    consola.log(`\nListing test runner containers (prefix: ${testRunnerPrefix}*)...`);
    removedContainers += await removeContainersByPrefix(testRunnerPrefix);

    consola.log(`\nListing Docker images (prefix: ${stagingPrefix}*)...`);
    let imageLines: string;
    try {
      imageLines = (
        await spawnCapture({
          command: 'docker',
          args: [
            'images',
            '--format',
            '{{.Repository}}:{{.Tag}}',
            '--filter',
            `reference=${stagingPrefix}*`,
          ],
          cwd: process.cwd(),
        })
      ).trim();
    } catch {
      consola.error('Failed to list Docker images. Is Docker running?');
      process.exit(1);
    }
    const imageTags = imageLines ? imageLines.split('\n').filter(Boolean) : [];
    const matchingImages = imageTags.filter((t) => {
      const repoName = t.split(':')[0] ?? t;
      return repoName.startsWith(stagingPrefix);
    });
    for (const tag of matchingImages) {
      try {
        await spawnAsync({
          command: 'docker',
          args: ['rmi', '-f', tag],
          cwd: process.cwd(),
          stdio: 'pipe',
        });
        consola.log(`  removed image: ${tag}`);
        removedImages++;
      } catch (err) {
        consola.warn(`  warning: could not remove image ${tag}: ${String(err)}`);
      }
    }

    consola.log(`\nListing factory networks (prefix: ${networkPrefix}*)...`);
    let networkLines: string;
    try {
      networkLines = (
        await spawnCapture({
          command: 'docker',
          args: ['network', 'ls', '--format', '{{.Name}}', '--filter', `name=${networkPrefix}`],
          cwd: process.cwd(),
        })
      ).trim();
    } catch {
      consola.error('Failed to list Docker networks. Is Docker running?');
      process.exit(1);
    }
    const networkNames = networkLines ? networkLines.split('\n').filter(Boolean) : [];
    const matchingNetworks = networkNames.filter((n) => n.startsWith(networkPrefix));
    for (const name of matchingNetworks) {
      try {
        await spawnAsync({
          command: 'docker',
          args: ['network', 'rm', name],
          cwd: process.cwd(),
          stdio: 'pipe',
        });
        consola.log(`  removed network: ${name}`);
        removedNetworks++;
      } catch (err) {
        consola.warn(`  warning: could not remove network ${name}: ${String(err)}`);
      }
    }

    const scope = clearAll ? 'all factory projects' : `project "${projName}"`;
    consola.log(
      `\nDocker clear complete for ${scope}: ` +
        `${removedContainers} container(s), ${removedImages} image(s), ${removedNetworks} network(s) removed.`,
    );
  },
});

// ── main ────────────────────────────────────────────────────────────────────

const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build factory container images',
  },
  subCommands: {
    test: testBuildCommand,
    coder: coderBuildCommand,
  },
});

const dockerCommand = defineCommand({
  meta: {
    name: 'docker',
    description: 'Build and clear factory container images',
  },
  subCommands: {
    build: buildCommand,
    clear: clearCommand,
  },
});

export default dockerCommand;

if (process.argv[1]?.endsWith('docker.ts') || process.argv[1]?.endsWith('docker.js')) {
  await runMain(dockerCommand);
}
