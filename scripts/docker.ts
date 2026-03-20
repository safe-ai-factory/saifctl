#!/usr/bin/env tsx
/**
 * Docker CLI — build and clear factory container images.
 *
 * Usage: pnpm docker <action> [image] [options]
 *   build test       Build test runner image(s) (default: node-vitest, --all: all profiles)
 *   build coder-base Build coder base image (factory-coder-base:latest)
 *   build coder      Build coder image (default: node-pnpm-python, --all: all profiles)
 *   build stage      Build stage image (default: node-pnpm-python, --all: all profiles)
 *   clear            Remove factory containers/images (scoped to project; --all: everything)
 */

import { resolve } from 'node:path';

import { defineCommand, runMain } from 'citty';

import { getSaifRoot } from '../src/constants.js';
import {
  DEFAULT_SANDBOX_PROFILE,
  resolveSandboxCoderDockerfilePath,
  resolveSandboxProfile,
  resolveSandboxStageDockerfilePath,
  type SandboxProfile,
  SUPPORTED_SANDBOX_PROFILES,
} from '../src/sandbox-profiles/index.js';
import {
  DEFAULT_PROFILE,
  resolveTestDockerfilePath,
  resolveTestProfile,
  SUPPORTED_PROFILES,
  type TestProfile,
} from '../src/test-profiles/index.js';
import { pathExists, readUtf8, spawnAsync, spawnCapture } from '../src/utils/io.js';

async function parseProjectName(opts: { project?: string }): Promise<string> {
  const fromOpt =
    typeof opts.project === 'string' && opts.project.trim() ? opts.project.trim() : '';
  if (fromOpt) return fromOpt;

  const repoRoot = getSaifRoot();
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
    console.error(
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
  },
  async run({ args }) {
    const repoRoot = getSaifRoot();
    const buildAll = args.all === true;

    const profilesToBuild: TestProfile[] = buildAll
      ? Object.values(SUPPORTED_PROFILES)
      : [args['test-profile'] ? resolveTestProfile(args['test-profile']) : DEFAULT_PROFILE];

    console.log(
      buildAll
        ? `\nBuilding all ${profilesToBuild.length} test runner images...`
        : '\nBuilding test runner image...',
    );
    console.log('  (this only needs to run once; images are cached locally)\n');

    for (const profile of profilesToBuild) {
      const tag = buildAll
        ? `factory-test-${profile.id}:latest`
        : args['test-image']?.trim() || `factory-test-${profile.id}:latest`;
      if (!buildAll) validateImageTag(tag, '--test-image');

      const dockerfilePath = resolveTestDockerfilePath(profile.id);
      if (!(await pathExists(dockerfilePath))) {
        console.error(`${dockerfilePath} not found for profile ${profile.id}`);
        process.exit(1);
      }

      console.log(`Building: ${tag}`);
      console.log(`  Dockerfile: ${dockerfilePath}`);

      try {
        await spawnAsync({
          command: 'docker',
          args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
          cwd: repoRoot,
          stdio: 'inherit',
        });
      } catch {
        console.error(`\ndocker build failed for ${profile.id}`);
        process.exit(1);
      }
      console.log(`  => ${tag}\n`);
    }

    console.log('Test image(s) built successfully.');
    if (!buildAll) {
      const tag = args['test-image']?.trim() || `factory-test-${profilesToBuild[0]!.id}:latest`;
      console.log(`Use it with: npx saifac feat run --test-image ${tag}`);
    }
  },
});

// ── coder-base build ────────────────────────────────────────────────────────

const coderBaseBuildCommand = defineCommand({
  meta: {
    name: 'coder-base',
    description: 'Build coder base image (factory-coder-base:latest) from Dockerfile.coder-base',
  },
  args: {
    'coder-base-image': { type: 'string', description: 'Image tag override' },
  },
  async run({ args }) {
    const repoRoot = getSaifRoot();
    const tag = args['coder-base-image']?.trim() || 'factory-coder-base:latest';
    if (args['coder-base-image']) validateImageTag(tag, '--coder-base-image');

    const dockerfilePath = resolve(repoRoot, 'Dockerfile.coder-base');
    if (!(await pathExists(dockerfilePath))) {
      console.error(`Dockerfile.coder-base not found at ${dockerfilePath}`);
      process.exit(1);
    }

    console.log(`\nBuilding coder base image: ${tag}`);
    console.log(`  Dockerfile: ${dockerfilePath}`);
    console.log('  (extend this image to bring your own coder agent)\n');

    try {
      await spawnAsync({
        command: 'docker',
        args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
        cwd: repoRoot,
        stdio: 'inherit',
      });
    } catch {
      console.error(`\ndocker build failed`);
      process.exit(1);
    }

    console.log(`\nCoder base image built: ${tag}`);
    console.log('Extend it in your own Dockerfile:');
    console.log(`  FROM ${tag}`);
    console.log('  RUN <install your coder agent here>');
    console.log(`Use it with: npx saifac feat run --coder-image <your-image>`);
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
  },
  async run({ args }) {
    const repoRoot = getSaifRoot();
    const buildAll = args.all === true;

    const profilesToBuild: SandboxProfile[] = buildAll
      ? Object.values(SUPPORTED_SANDBOX_PROFILES)
      : [args.profile ? resolveSandboxProfile(args.profile) : DEFAULT_SANDBOX_PROFILE];

    console.log(
      buildAll
        ? `\nBuilding all ${profilesToBuild.length} coder images...`
        : '\nBuilding coder image...',
    );
    console.log('  (this only needs to run once; images are cached locally)\n');

    for (const profile of profilesToBuild) {
      const tag = buildAll
        ? profile.coderImageTag
        : args['coder-image']?.trim() || profile.coderImageTag;
      if (!buildAll && args['coder-image']) validateImageTag(tag, '--coder-image');

      const dockerfilePath = resolveSandboxCoderDockerfilePath(profile.id);
      if (!(await pathExists(dockerfilePath))) {
        console.error(`${dockerfilePath} not found for profile ${profile.id}`);
        process.exit(1);
      }

      console.log(`Building: ${tag}`);
      console.log(`  Profile:    ${profile.id} (${profile.displayName})`);
      console.log(`  Dockerfile: ${dockerfilePath}`);

      try {
        await spawnAsync({
          command: 'docker',
          args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
          cwd: repoRoot,
          stdio: 'inherit',
        });
      } catch {
        console.error(`\ndocker build failed for ${profile.id}`);
        process.exit(1);
      }
      console.log(`  => ${tag}\n`);
    }

    console.log('Coder image(s) built successfully.');
    if (!buildAll) {
      const profile = profilesToBuild[0]!;
      const tag = args['coder-image']?.trim() || profile.coderImageTag;
      console.log(`Use it with: saifac feat run --profile ${profile.id}`);
      console.log(`Override: saifac feat run --coder-image ${tag}`);
    }
  },
});

// ── stage build ─────────────────────────────────────────────────────────────

const stageBuildCommand = defineCommand({
  meta: {
    name: 'stage',
    description:
      'Build stage image. Default: node-pnpm-python. Use --all for all sandbox profiles.',
  },
  args: {
    all: { type: 'boolean', description: 'Build all sandbox profiles' },
    profile: { type: 'string', description: 'Sandbox profile (default: node-pnpm-python)' },
    'stage-image': { type: 'string', description: 'Image tag override' },
  },
  async run({ args }) {
    const repoRoot = getSaifRoot();
    const buildAll = args.all === true;

    const profilesToBuild: SandboxProfile[] = buildAll
      ? Object.values(SUPPORTED_SANDBOX_PROFILES)
      : [args.profile ? resolveSandboxProfile(args.profile) : DEFAULT_SANDBOX_PROFILE];

    console.log(
      buildAll
        ? `\nBuilding all ${profilesToBuild.length} stage images...`
        : '\nBuilding stage container image...',
    );
    console.log('  (build context: repo root)\n');

    for (const profile of profilesToBuild) {
      const tag = buildAll
        ? profile.stageImageTag
        : args['stage-image']?.trim() || profile.stageImageTag;
      if (!buildAll && args['stage-image']) validateImageTag(tag, '--stage-image');

      const dockerfilePath = resolveSandboxStageDockerfilePath(profile.id);
      if (!(await pathExists(dockerfilePath))) {
        console.error(`${dockerfilePath} not found for profile ${profile.id}`);
        process.exit(1);
      }

      console.log(`Building: ${tag}`);
      console.log(`  Profile:    ${profile.id} (${profile.displayName})`);
      console.log(`  Dockerfile: ${dockerfilePath}`);

      try {
        await spawnAsync({
          command: 'docker',
          args: ['build', '-f', dockerfilePath, '-t', tag, '.'],
          cwd: repoRoot,
          stdio: 'inherit',
        });
      } catch {
        console.error(`\ndocker build failed for ${profile.id}`);
        process.exit(1);
      }
      console.log(`  => ${tag}\n`);
    }

    console.log('Stage image(s) built successfully.');
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

    const stagingPrefix = clearAll ? 'factory-stage-' : `factory-stage-${projName}-`;
    const testRunnerPrefix = clearAll ? 'factory-test-' : `factory-test-${projName}-`;
    const networkPrefix = clearAll ? 'factory-net-' : `factory-net-${projName}-`;

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
        console.error('Failed to list Docker containers. Is Docker running?');
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
          console.log(`  removed container: ${name}`);
          removed++;
        } catch (err) {
          console.warn(`  warning: could not remove container ${name}: ${String(err)}`);
        }
      }
      return removed;
    };

    console.log(`\nListing staging containers (prefix: ${stagingPrefix}*)...`);
    removedContainers += await removeContainersByPrefix(stagingPrefix);

    console.log(`\nListing test runner containers (prefix: ${testRunnerPrefix}*)...`);
    removedContainers += await removeContainersByPrefix(testRunnerPrefix);

    console.log(`\nListing Docker images (prefix: ${stagingPrefix}*)...`);
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
      console.error('Failed to list Docker images. Is Docker running?');
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
        console.log(`  removed image: ${tag}`);
        removedImages++;
      } catch (err) {
        console.warn(`  warning: could not remove image ${tag}: ${String(err)}`);
      }
    }

    console.log(`\nListing factory networks (prefix: ${networkPrefix}*)...`);
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
      console.error('Failed to list Docker networks. Is Docker running?');
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
        console.log(`  removed network: ${name}`);
        removedNetworks++;
      } catch (err) {
        console.warn(`  warning: could not remove network ${name}: ${String(err)}`);
      }
    }

    const scope = clearAll ? 'all factory projects' : `project "${projName}"`;
    console.log(
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
    'coder-base': coderBaseBuildCommand,
    coder: coderBuildCommand,
    stage: stageBuildCommand,
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
