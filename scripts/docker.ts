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
import { npmPackageNameToProjectSlug } from '../src/utils/package.js';

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
    if (typeof pkg.name === 'string' && pkg.name.trim()) {
      return npmPackageNameToProjectSlug(pkg.name.trim());
    }
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

interface PushConfig {
  platforms: string;
  imagePrefix: string;
  extraTag?: string;
  /** Dry-run: build via buildx for the given platforms but skip the push and the manifest inspect. */
  dryRun: boolean;
}

interface BuildImageOptions {
  dockerfilePath: string;
  localTag: string;
  cwd: string;
  push?: PushConfig;
}

async function buildImage(opts: BuildImageOptions): Promise<void> {
  const { dockerfilePath, localTag, cwd, push } = opts;

  if (!push) {
    await spawnAsync({
      command: 'docker',
      args: ['build', '-f', dockerfilePath, '-t', localTag, '.'],
      cwd,
      stdio: 'inherit',
    });
    return;
  }

  const imageName = localTag.split(':')[0]!;
  const remoteLatest = `${push.imagePrefix}/${imageName}:latest`;
  const remoteTags = [remoteLatest];
  if (push.extraTag) remoteTags.push(`${push.imagePrefix}/${imageName}:${push.extraTag}`);

  // Dry-run validates the build for all requested platforms without pushing.
  // buildx with --platform and no --push/--load builds for every platform
  // and discards the result — exactly what we want for "would this publish work?".
  const buildxArgs = [
    'buildx',
    'build',
    '--platform',
    push.platforms,
    '-f',
    dockerfilePath,
    ...remoteTags.flatMap((t) => ['-t', t]),
    ...(push.dryRun ? [] : ['--push']),
    '.',
  ];

  await spawnAsync({
    command: 'docker',
    args: buildxArgs,
    cwd,
    stdio: 'inherit',
  });

  if (push.dryRun) return;

  await spawnAsync({
    command: 'docker',
    args: ['buildx', 'imagetools', 'inspect', remoteLatest],
    cwd,
    stdio: 'inherit',
  });
}

function resolvePushConfig(args: Record<string, unknown>): PushConfig | undefined {
  if (args.push !== true) {
    if (args['dry-run'] === true) {
      consola.error(
        '--dry-run requires --push (it changes how --push behaves; without --push it has no effect).',
      );
      process.exit(1);
    }
    return undefined;
  }

  const prefixRaw = args['image-prefix'];
  if (typeof prefixRaw !== 'string' || !prefixRaw.trim()) {
    consola.error(
      '--push requires --image-prefix (e.g. --image-prefix ghcr.io/safe-ai-factory/saifctl)',
    );
    process.exit(1);
  }

  const platformsRaw = args.platforms;
  const extraRaw = args['extra-tag'];
  const dryRun = args['dry-run'] === true;

  return {
    platforms:
      typeof platformsRaw === 'string' && platformsRaw.trim() ? platformsRaw.trim() : 'linux/amd64',
    imagePrefix: prefixRaw.trim().replace(/\/+$/, ''),
    extraTag: typeof extraRaw === 'string' && extraRaw.trim() ? extraRaw.trim() : undefined,
    dryRun,
  };
}

const PUSH_ARGS = {
  push: {
    type: 'boolean',
    description: 'Push to registry instead of building locally (uses buildx; multi-arch manifest)',
  },
  platforms: {
    type: 'string',
    description: 'Comma-separated platforms for --push (default: linux/amd64)',
  },
  'image-prefix': {
    type: 'string',
    description: 'Registry prefix for pushed tags, required with --push (e.g. ghcr.io/owner/repo)',
  },
  'extra-tag': {
    type: 'string',
    description: 'Additional tag to push alongside :latest (e.g. v0.1.0)',
  },
  'dry-run': {
    type: 'boolean',
    description:
      'With --push: build via buildx for all platforms but skip the push and manifest inspect. Validates the build path without pushing to the registry.',
  },
} as const;

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
    ...PUSH_ARGS,
  },
  async run({ args }) {
    const repoRoot = getSaifctlRoot();
    const buildAll = args.all === true;
    const skipExisting = args['skip-existing'] === true;
    const push = resolvePushConfig(args as Record<string, unknown>);

    if (push && skipExisting) {
      consola.error(
        '--skip-existing cannot be combined with --push (no local image is created when pushing).',
      );
      process.exit(1);
    }
    if (push && args['test-image']) {
      consola.error('--test-image cannot be combined with --push (use the canonical tag).');
      process.exit(1);
    }

    const profilesToBuild: TestProfile[] = buildAll
      ? Object.values(SUPPORTED_PROFILES)
      : [args['test-profile'] ? resolveTestProfile(args['test-profile']) : DEFAULT_TEST_PROFILE];

    const verb = push
      ? push.dryRun
        ? 'Building (dry-run, no push)'
        : 'Building + pushing'
      : 'Building';
    consola.log(
      buildAll
        ? `\n${verb} all ${profilesToBuild.length} test runner images...`
        : `\n${verb} test runner image...`,
    );
    if (push) {
      consola.log(
        `  (multi-arch via buildx; platforms=${push.platforms}; prefix=${push.imagePrefix}${push.extraTag ? `; extra-tag=${push.extraTag}` : ''})\n`,
      );
    } else {
      consola.log('  (this only needs to run once; images are cached locally)\n');
    }
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
      if (!buildAll && !push) validateImageTag(tag, '--test-image');

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

      consola.log(
        `${progress}${push ? (push.dryRun ? 'Building (dry-run)' : 'Building + pushing') : 'Building'}: ${tag}`,
      );
      consola.log(`${progress}  Dockerfile: ${dockerfilePath}`);

      try {
        await buildImage({ dockerfilePath, localTag: tag, cwd: repoRoot, push });
      } catch {
        consola.error(
          `\n${progress}docker ${push ? 'buildx push' : 'build'} failed for ${profile.id}`,
        );
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
      consola.log(
        `Test image(s) ${push ? (push.dryRun ? 'built (dry-run; nothing pushed)' : 'built and pushed') : 'built'} successfully.`,
      );
    }
    if (!buildAll && !push) {
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
    ...PUSH_ARGS,
  },
  async run({ args }) {
    const repoRoot = getSaifctlRoot();
    const buildAll = args.all === true;
    const skipExisting = args['skip-existing'] === true;
    const push = resolvePushConfig(args as Record<string, unknown>);

    if (push && skipExisting) {
      consola.error(
        '--skip-existing cannot be combined with --push (no local image is created when pushing).',
      );
      process.exit(1);
    }
    if (push && args['coder-image']) {
      consola.error('--coder-image cannot be combined with --push (use the canonical tag).');
      process.exit(1);
    }

    const profilesToBuild: SandboxProfile[] = buildAll
      ? Object.values(SUPPORTED_SANDBOX_PROFILES)
      : [args.profile ? resolveSandboxProfile(args.profile) : DEFAULT_SANDBOX_PROFILE];

    const verb = push
      ? push.dryRun
        ? 'Building (dry-run, no push)'
        : 'Building + pushing'
      : 'Building';
    consola.log(
      buildAll
        ? `\n${verb} all ${profilesToBuild.length} coder images...`
        : `\n${verb} coder image...`,
    );
    if (push) {
      consola.log(
        `  (multi-arch via buildx; platforms=${push.platforms}; prefix=${push.imagePrefix}${push.extraTag ? `; extra-tag=${push.extraTag}` : ''})\n`,
      );
    } else {
      consola.log('  (this only needs to run once; images are cached locally)\n');
    }
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
      if (!buildAll && args['coder-image'] && !push) validateImageTag(tag, '--coder-image');

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

      consola.log(
        `${progress}${push ? (push.dryRun ? 'Building (dry-run)' : 'Building + pushing') : 'Building'}: ${tag}`,
      );
      consola.log(`${progress}  Profile:    ${profile.id} (${profile.displayName})`);
      consola.log(`${progress}  Dockerfile: ${dockerfilePath}`);

      try {
        await buildImage({ dockerfilePath, localTag: tag, cwd: repoRoot, push });
      } catch {
        consola.error(
          `\n${progress}docker ${push ? 'buildx push' : 'build'} failed for ${profile.id}`,
        );
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
      consola.log(
        `Coder image(s) ${push ? (push.dryRun ? 'built (dry-run; nothing pushed)' : 'built and pushed') : 'built'} successfully.`,
      );
    }
    if (!buildAll && !push) {
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
