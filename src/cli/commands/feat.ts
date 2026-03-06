#!/usr/bin/env tsx
/**
 * Feat CLI — feature workflow scaffolding.
 *
 * Usage: saif feat <subcommand> [options]
 *   new    Create scaffolding for a new feature (prompts for name if not given)
 *   Alias: saif feature
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import { runBlackboxDesign } from '../../blackbox/design.js';
import { generateSpecTestScaffold } from '../../blackbox/impl.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import { DEFAULT_INDEXER_PROFILE } from '../../indexer-profiles/index.js';
import {
  getFeatNameFromArgs,
  getFeatNameOrPrompt,
  parseDesignerProfile,
  parseIndexerProfile,
  parseOpenspecDir,
  parseProjectDir,
  parseTestProfile,
  requireLlmApiKey,
  resolveProjectName,
} from '../utils.js';

// Shared feat args — spread into subcommands, override individual attrs as needed
const featNameArg = {
  type: 'string' as const,
  alias: 'n' as const,
  description: 'Feature name (kebab-case). Prompts with a list if omitted.',
};
const featYesArg = {
  type: 'boolean' as const,
  alias: 'y' as const,
  description:
    'Non-interactive mode. Requires --name/-n. Omits description prompt (defaults to empty).',
};
const featOpenspecDirArg = {
  type: 'string' as const,
  description: 'Path to openspec directory (default: openspec)',
};
const featProjectDirArg = {
  type: 'string' as const,
  description: 'Project directory (default: process.cwd())',
};
const featTestProfileArg = {
  type: 'string' as const,
  description: 'Test profile id (default: ts-vitest).',
};
const featDesignerArg = {
  type: 'string' as const,
  description: `Designer profile for spec generation (default: ${DEFAULT_DESIGNER_PROFILE.id}).`,
};
const featIndexerArg = {
  type: 'string' as const,
  description: `Indexer profile for codebase search (default: ${DEFAULT_INDEXER_PROFILE.id}). Pass 'none' to disable.`,
};
const featProjectArg = {
  type: 'string' as const,
  alias: 'p',
  description: 'Project name override for the indexer (default: package.json "name")',
};

const newCommand = defineCommand({
  meta: {
    name: 'new',
    description:
      'Create scaffolding for a new feature (e.g. add-login; prompts for name if not given)',
  },
  args: {
    name: {
      ...featNameArg,
      description: 'Feature name (kebab-case, e.g. add-greeting-cmd)',
    },
    yes: featYesArg,
    'openspec-dir': featOpenspecDirArg,
    'project-dir': featProjectDirArg,
    desc: {
      type: 'string',
      alias: 'd',
      description: 'Brief description. When provided, skips the description prompt.',
    },
  },
  async run({ args }) {
    requireLlmApiKey();

    const projectDir = parseProjectDir(args);
    const nonInteractive = args.yes === true;
    const namePreFill = getFeatNameFromArgs(args);

    if (nonInteractive && !namePreFill) {
      console.error('Error: --name/-n is required when using --yes/-y');
      process.exit(1);
    }

    let featName: string;
    if (nonInteractive) {
      featName = namePreFill!;
    } else {
      intro('New feature change');
      const nameResult = await text({
        message: 'Feature name (kebab-case, e.g. add-greeting-cmd)',
        initialValue: namePreFill,
        validate: (v) => {
          if (!v?.trim()) return 'Name is required';
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.trim()))
            return 'Use kebab-case (lowercase, hyphens only)';
          return undefined;
        },
      });
      if (isCancel(nameResult)) {
        cancel('Operation cancelled.');
        process.exit(1);
      }
      featName = nameResult.trim();
    }

    let description: string | undefined;
    if (typeof args.desc === 'string') {
      description = args.desc.trim() || undefined;
    } else if (nonInteractive) {
      description = undefined;
    } else {
      const descResult = await text({
        message: 'Brief description (optional)',
        placeholder: 'What does this feature do?',
      });
      if (isCancel(descResult)) {
        cancel('Operation cancelled.');
        process.exit(1);
      }
      description = typeof descResult === 'string' ? descResult.trim() : undefined;
    }

    if (!nonInteractive) outro('Creating change…');

    const openspecDir = parseOpenspecDir(args);

    execSync(`npx openspec new change ${featName}`, { stdio: 'inherit', cwd: projectDir });
    const changeDir = resolve(projectDir, openspecDir, 'changes', featName);
    if (description) {
      const proposalPath = resolve(changeDir, 'proposal.md');
      writeFileSync(proposalPath, `## What Changes\n\n${description}\n`, 'utf8');
      console.log(`\nCreated: ${changeDir}`);
      console.log(`  proposal.md: ${description}`);
    } else {
      console.log(`\nCreated: ${changeDir}`);
    }
  },
});

const designCommand = defineCommand({
  meta: {
    name: 'design',
    description:
      'Run spec generation + black-box design and generate test scaffolding for a feature',
  },
  args: {
    name: featNameArg,
    model: {
      type: 'string',
      description: 'LLM model to pass to the designer profile.',
    },
    designer: featDesignerArg,
    'test-profile': featTestProfileArg,
    'openspec-dir': featOpenspecDirArg,
    indexer: featIndexerArg,
    project: featProjectArg,
    'project-dir': featProjectDirArg,
  },
  async run({ args }) {
    requireLlmApiKey();

    const projectDir = parseProjectDir(args);
    const featName = await getFeatNameOrPrompt(args, projectDir);
    const openspecDir = parseOpenspecDir(args);
    const testProfile = parseTestProfile(args);
    const designerProfile = parseDesignerProfile(args);

    const specDir = `${openspecDir}/changes/${featName}`;
    const designerBaseOpts = { cwd: projectDir, featName, openspecDir };

    let runDesigner = !designerProfile.hasRun(designerBaseOpts);
    if (!runDesigner) {
      intro(`${designerProfile.displayName} output present`);
      const redo = await confirm({
        message: `${specDir} already has designer output. Redo ${designerProfile.displayName} spec generation?`,
      });
      outro('');
      if (isCancel(redo)) {
        cancel('Operation cancelled.');
        process.exit(1);
      }
      runDesigner = redo === true;
    }

    if (runDesigner) {
      console.log(`\n${designerProfile.displayName} (spec generation): ${featName}`);
      await designerProfile.run({
        ...designerBaseOpts,
        model: typeof args.model === 'string' ? args.model.trim() : undefined,
      });
    } else {
      console.log(`\nSkipping designer (${specDir} already has required spec files).`);
    }

    const indexerProfile = parseIndexerProfile(args);
    const projectName = resolveProjectName(args, projectDir);

    console.log(`\nBlack Box Design + Impl: ${featName} (profile: ${testProfile.id})`);
    if (indexerProfile) {
      console.log(`  Indexer: ${indexerProfile.displayName} (project: ${projectName})`);
    }
    const designResult = await runBlackboxDesign({
      changeName: featName,
      projectDir,
      openspecDir,
      testProfile,
      indexerProfile,
      projectName,
    });
    console.log(`  Test plan:  ${designResult.testPlanPath}`);
    console.log(`  Catalog:    ${designResult.catalogPath}`);

    console.log(`\nGenerating spec files from catalog...`);
    const implResult = await generateSpecTestScaffold({
      changeName: featName,
      projectDir,
      openspecDir,
      testProfile,
    });

    console.log(`\nTest scaffolding complete:`);
    console.log(`  Test cases:      ${implResult.testCaseCount}`);
    if (implResult.generatedFiles.length > 0) {
      console.log(`  Generated files: ${implResult.generatedFiles.length}`);
      for (const f of implResult.generatedFiles) console.log(`    + ${f}`);
    }
    if (implResult.skippedFiles.length > 0) {
      console.log(`  Skipped (exist): ${implResult.skippedFiles.length}`);
      for (const f of implResult.skippedFiles) console.log(`    ~ ${f}`);
    }

    await testProfile.validateFiles?.({
      testsDir: implResult.testsDir,
      generatedFiles: implResult.generatedFiles,
      projectDir,
      errMessage: `TypeScript validation failed. Fix the generated spec files or re-run feat design.`,
    });

    console.log('\nDone.');
  },
});

const featCommand = defineCommand({
  meta: {
    name: 'feat',
    description: 'Feature workflow (alias: feature)',
  },
  subCommands: {
    new: newCommand,
    design: designCommand,
  },
});

export default featCommand; // export for validation

// Allow running directly: tsx src/cli/commands/feat.ts
if (process.argv[1]?.endsWith('feat.ts') || process.argv[1]?.endsWith('feat.js')) {
  await runMain(featCommand);
}
