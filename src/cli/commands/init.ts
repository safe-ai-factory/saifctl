#!/usr/bin/env tsx
/**
 * Init CLI — initialize Saifctl config and project-level tests scaffolding.
 *
 * Usage:
 *   saifctl init [options]            Bootstrap a project: scaffold saifctl/config.ts
 *                                     (when absent), scaffold saifctl/tests/ from the
 *                                     resolved test profile's templates (when absent),
 *                                     and optionally run the codebase indexer.
 *
 *   saifctl init tests [options]      Re-scaffold ONLY saifctl/tests/. Useful when
 *                                     switching test profile, refreshing after a
 *                                     template upgrade, or initialising tests in an
 *                                     existing repo where saifctl/config.ts is already
 *                                     present (so plain `init` skips everything).
 *
 * Idempotency:
 *   - config.{ts,js,…} is skipped when any existing variant is found; --force rewrites
 *     to config.ts.
 *   - helpers / infra / example files are skipped per-file when present; --force
 *     overwrites.
 *
 * Cross-language guard (init tests):
 *   - If saifctl/tests/ already contains another profile's helpers (e.g. helpers.py
 *     when --test-profile=node-vitest), the command refuses without --force. Prevents
 *     mixed-language test dirs that no single test runner can run cohesively.
 *
 * Test profile resolution (`pickTestProfile` semantics):
 *   --test-profile <id>  →  config.defaults.testProfile  →  node-vitest
 */

import { defineCommand, runMain } from 'citty';

import { loadSaifctlConfig } from '../../config/load.js';
import { scaffoldSaifctlConfig } from '../../config/scaffold.js';
import { resolveIndexerProfile } from '../../indexer-profiles/index.js';
import { consola } from '../../logger.js';
import { pickTestProfile } from '../../orchestrator/options.js';
import {
  CrossLanguageScaffoldError,
  type ScaffoldedFile,
  scaffoldGlobalTests,
} from '../../test-profiles/scaffold-global-tests.js';
import {
  forceArg,
  indexerArg,
  projectArg,
  projectDirArg,
  saifctlDirArg,
  testProfileArg,
} from '../args.js';
import {
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  readTestProfileIdFromCli,
  resolveCliProjectDir,
  resolveProjectName,
  resolveSaifctlDirRelative,
} from '../utils.js';

/////////////////////////////////////////////
// init tests — re-scaffold project-level tests only
/////////////////////////////////////////////

const initTestsCommand = defineCommand({
  meta: {
    name: 'tests',
    description: 'Scaffold the project-level tests directory (saifctl/tests/)',
  },
  args: {
    'project-dir': projectDirArg,
    'saifctl-dir': saifctlDirArg,
    'test-profile': testProfileArg,
    project: projectArg,
    force: {
      ...forceArg,
      description: 'Overwrite existing helpers / infra / example files.',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const testProfile = pickTestProfile(readTestProfileIdFromCli(args), config);
    const force = args.force === true;

    consola.log(`Scaffolding ${saifctlDir}/tests/ for profile ${testProfile.id}…`);
    try {
      const result = await scaffoldGlobalTests({
        saifctlDir,
        projectDir,
        testProfile,
        force,
      });
      logScaffoldResult(result.files);
    } catch (err) {
      if (err instanceof CrossLanguageScaffoldError) {
        consola.error(err.message);
        process.exit(1);
      }
      throw err;
    }

    consola.log('\nDone.');
  },
});

/////////////////////////////////////////////
// init — full bootstrap
/////////////////////////////////////////////

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize Saifctl config and project-level tests',
  },
  args: {
    project: projectArg,
    'project-dir': projectDirArg,
    'saifctl-dir': saifctlDirArg,
    indexer: indexerArg,
    'test-profile': testProfileArg,
    force: {
      ...forceArg,
      description: 'Overwrite existing config / helpers / infra / example files.',
    },
  },
  subCommands: {
    tests: initTestsCommand,
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const indexerProfile = resolveIndexerProfile(
      typeof args.indexer === 'string' ? args.indexer : undefined,
    );
    const projectName = await resolveProjectName({ project: args.project, projectDir });
    const force = args.force === true;

    // 1. Scaffold saifctl/config.ts. Default is skip-if-exists; `--force`
    //    rewrites config.ts even when an existing variant
    //    (config.{ts,js,cjs,mjs,json,yaml,yml}) is present. Only config.ts is
    //    written — other variants are left alone (cosmiconfig prefers config.ts
    //    in its search order, so the new file wins; orphaned variants stay on
    //    disk for the user to delete).
    const configResult = await scaffoldSaifctlConfig({ saifctlDir, projectDir, force });
    if (configResult.action === 'created') {
      consola.log(`\nCreated ${saifctlDir}/config.ts (no config found).`);
    } else if (configResult.action === 'overwritten') {
      consola.log(`\nOverwrote ${saifctlDir}/config.ts (--force).`);
      if (configResult.existingVariant && configResult.existingVariant !== 'config.ts') {
        consola.warn(
          `  Existing ${saifctlDir}/${configResult.existingVariant} was left in place. ` +
            `Cosmiconfig prefers config.ts, but you should delete the orphaned variant ` +
            `to avoid confusion.`,
        );
      }
    }

    // 2. Load the (possibly just-scaffolded) config so we resolve the test
    //    profile through the same `pickTestProfile` chain everywhere else
    //    uses: --test-profile > config.defaults.testProfile > node-vitest.
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const testProfile = pickTestProfile(readTestProfileIdFromCli(args), config);

    // 3. Scaffold saifctl/tests/. The cross-language guard fires only when
    //    --force is omitted and the dir already holds another profile's
    //    helpers — so a fresh init never trips it.
    consola.log(`\nScaffolding ${saifctlDir}/tests/ for profile ${testProfile.id}…`);
    try {
      const testsResult = await scaffoldGlobalTests({
        saifctlDir,
        projectDir,
        testProfile,
        force,
      });
      logScaffoldResult(testsResult.files);
    } catch (err) {
      if (err instanceof CrossLanguageScaffoldError) {
        consola.error(`\n${err.message}`);
        consola.error(
          `\nHint: re-run with \`saifctl init tests --test-profile=${testProfile.id} --force\` ` +
            `to switch the dir's profile, or pick a profile that matches the existing helpers.`,
        );
        process.exit(1);
      }
      throw err;
    }

    // 4. Optional indexer pass.
    if (indexerProfile) {
      consola.log(
        `\nIndexing codebase with ${indexerProfile.displayName} (project: ${projectName})…`,
      );
      await indexerProfile.init({ projectDir, projectName });
    } else {
      consola.log('\nNo indexer configured.');
    }

    consola.log('\nInit complete.');
  },
});

function logScaffoldResult(files: readonly ScaffoldedFile[]): void {
  for (const f of files) {
    if (f.action === 'created') consola.log(`  Created   ${f.path}`);
    else if (f.action === 'overwritten') consola.log(`  Overwrote ${f.path}`);
    else if (f.action === 'switched')
      consola.log(`  Swapped   ${f.path} (was ${f.switchedFrom} template)`);
    else consola.log(`  Skipped   ${f.path} (already exists)`);
  }
}

export default initCommand; // export for validation

// Allow running directly: tsx src/cli/commands/init.ts
if (process.argv[1]?.endsWith('init.ts') || process.argv[1]?.endsWith('init.js')) {
  await runMain(initCommand);
}
