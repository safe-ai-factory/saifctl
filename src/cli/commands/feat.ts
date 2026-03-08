#!/usr/bin/env tsx
/**
 * Feat CLI — feature workflow scaffolding.
 *
 * Usage: saif feat <subcommand> [options]
 *   new           Create scaffolding for a new feature (prompts for name if not given)
 *   design-specs  Generate specs from a feature's proposal only (first step of design).
 *   design-tests  Generate tests from existing specs only (second step of design).
 *   design        Generate specs and tests from a feature's proposal (full design workflow)
 *   Alias: saif feature
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import { getChangeDirAbsolute, getChangeDirRelative } from '../../constants.js';
import { runDesignTests } from '../../design-tests/design.js';
import { generateTests } from '../../design-tests/write.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import { DEFAULT_INDEXER_PROFILE } from '../../indexer-profiles/index.js';
import type { ModelOverrides } from '../../llm-config.js';
import {
  getFeatNameFromArgs,
  getFeatNameOrPrompt,
  parseDesignerProfile,
  parseIndexerProfile,
  parseModelOverrides,
  parseOpenspecDir,
  parseProjectDir,
  parseTestProfile,
  resolveProjectName,
} from '../utils.js';

/////////////////////////////////////////////
// Shared CLI args
/////////////////////////////////////////////

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
  description: 'Test profile id (default: node-vitest).',
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
const forceArg = {
  type: 'boolean' as const,
  alias: 'f' as const,
  description: null,
};

// Shared model override args — spread into any subcommand that calls LLMs.
const modelOverrideArgs = {
  model: {
    type: 'string' as const,
    description:
      'LLM model for all agents, e.g. anthropic/claude-3-5-sonnet-latest or openai/gpt-4o.',
  },
  'base-url': {
    type: 'string' as const,
    description: 'Base URL for all agents (only needed for custom/local endpoints).',
  },
  'agent-model': {
    type: 'string' as const,
    description:
      'Per-agent model override, repeatable. Format: name=provider/model (e.g. tests-planner=openai/gpt-4o).',
  },
  'agent-base-url': {
    type: 'string' as const,
    description: 'Per-agent base URL override, repeatable. Format: name=url.',
  },
};

/////////////////////////////////////////////
// Commands
/////////////////////////////////////////////

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
    const changeDir = getChangeDirAbsolute({ cwd: projectDir, openspecDir, changeName: featName });
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

const designSpecsArgs = {
  name: featNameArg,
  yes: {
    ...featYesArg,
    description:
      'Non-interactive mode. Requires --name/-n. Skips confirm when designer output exists; assumes redo.',
  },
  force: {
    ...forceArg,
    description: 'Always re-run the designer, overwriting existing spec files without prompting.',
  },
  ...modelOverrideArgs,
  designer: featDesignerArg,
  'openspec-dir': featOpenspecDirArg,
  'project-dir': featProjectDirArg,
};

async function _runDesignSpecs(args: {
  name?: string;
  yes?: boolean;
  force?: boolean;
  model?: string;
  'base-url'?: string;
  'agent-model'?: string | string[];
  'agent-base-url'?: string | string[];
  designer?: string;
  'openspec-dir'?: string;
  'project-dir'?: string;
  [key: string]: unknown;
}) {
  const projectDir = parseProjectDir(args);
  const nonInteractive = args.yes === true;
  const force = args.force === true;
  if (nonInteractive && !getFeatNameFromArgs(args)) {
    console.error('Error: --name/-n is required when using --yes/-y');
    process.exit(1);
  }
  const featName = await getFeatNameOrPrompt(args, projectDir);
  const openspecDir = parseOpenspecDir(args);
  const designerProfile = parseDesignerProfile(args);

  const specDir = getChangeDirRelative({ openspecDir, changeName: featName });
  const designerBaseOpts = { cwd: projectDir, featName, openspecDir };

  // 1. Generate full specs and plan from user's proposal.
  // 1a. Check if the designer has already run
  let runDesigner = force || !(await designerProfile.hasRun(designerBaseOpts));
  if (!runDesigner) {
    // Allow non-interactive mode to override the prompt.
    if (nonInteractive) {
      runDesigner = true;
    } else {
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
  }

  // 1b. Run the designer if needed
  if (runDesigner) {
    console.log(`\n${designerProfile.displayName} (spec generation): ${featName}`);
    await designerProfile.run({
      ...designerBaseOpts,
      model: typeof args.model === 'string' ? args.model.trim() : undefined,
    });
  } else {
    console.log(`\nSkipping designer (${specDir} already has required spec files).`);
  }

  const overrides = parseModelOverrides(args);
  return { featName, projectDir, openspecDir, overrides };
}

const designSpecsCommand = defineCommand({
  meta: {
    name: 'design-specs',
    description: "Generate specs from features's proposal only (first step of design workflow)",
  },
  args: designSpecsArgs,
  async run({ args }) {
    await _runDesignSpecs(args);
    console.log('\nDone.');
  },
});

const designTestsArgs = {
  name: featNameArg,
  'openspec-dir': featOpenspecDirArg,
  'project-dir': featProjectDirArg,
  'test-profile': featTestProfileArg,
  indexer: featIndexerArg,
  project: featProjectArg,
  'skip-catalog': {
    type: 'boolean' as const,
    description:
      'Skip tests catalog generation and use the existing tests.json. Useful when only re-generating test files.',
  },
  force: {
    ...forceArg,
    description: 'Overwrite existing test scaffold files.',
  },
  ...modelOverrideArgs,
};

interface DesignTestsOptions {
  featName: string;
  projectDir: string;
  openspecDir: string;
  skipCatalog: boolean;
  force: boolean;
  overrides: ModelOverrides;
  args: {
    'test-profile'?: string;
    indexer?: string;
    project?: string;
    [key: string]: unknown;
  };
}

async function _runDesignTests({
  featName,
  projectDir,
  openspecDir,
  skipCatalog,
  force,
  overrides,
  args,
}: DesignTestsOptions) {
  const projectName = resolveProjectName(args, projectDir);
  const testProfile = parseTestProfile(args);
  const indexerProfile = parseIndexerProfile(args);

  if (!skipCatalog) {
    // 2a. Read specs and generate a plan of what to test as markdown and JSON.
    console.log(`\nTests Catalog: ${featName} (profile: ${testProfile.id})`);
    if (indexerProfile) {
      console.log(`  Indexer: ${indexerProfile.displayName} (project: ${projectName})`);
    }
    const designResult = await runDesignTests({
      changeName: featName,
      projectDir,
      openspecDir,
      testProfile,
      indexerProfile,
      projectName,
      overrides,
    });
    console.log(`  Test plan:  ${designResult.testPlanPath}`);
    console.log(`  Catalog:    ${designResult.catalogPath}`);
  } else {
    console.log(`\nSkipping catalog generation (--skip-catalog). Reading existing tests.json.`);
  }

  // 2b. Write actual tests from the test plan.
  console.log(`\nGenerating spec files from catalog...`);
  const implResult = await generateTests({
    changeName: featName,
    projectDir,
    openspecDir,
    force,
    testProfile,
    overrides,
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

  // 2c. Validate the generated tests.
  await testProfile.validateFiles?.({
    testsDir: implResult.testsDir,
    generatedFiles: implResult.generatedFiles,
    projectDir,
    errMessage: `TypeScript validation failed. Fix the generated spec files or re-run feat design.`,
  });
}

const designTestsCommand = defineCommand({
  meta: {
    name: 'design-tests',
    description: 'Generate tests from existing specs (second step of design workflow)',
  },
  args: designTestsArgs,
  async run({ args }) {
    const projectDir = parseProjectDir(args);
    const featName = await getFeatNameOrPrompt(args, projectDir);
    const openspecDir = parseOpenspecDir(args);
    const overrides = parseModelOverrides(args);

    const skipCatalog = args['skip-catalog'] === true;
    const force = args.force === true;
    await _runDesignTests({
      featName,
      projectDir,
      openspecDir,
      skipCatalog,
      force,
      overrides,
      args,
    });

    console.log('\nDone.');
  },
});

const designCommand = defineCommand({
  meta: {
    name: 'design',
    description: "Generate specs and tests from a feature's proposal (full design workflow)",
  },
  args: {
    ...designSpecsArgs,
    ...designTestsArgs,
  },
  async run({ args }) {
    const { featName, projectDir, openspecDir, overrides } = await _runDesignSpecs(args);
    const force = args.force === true;
    await _runDesignTests({
      featName,
      projectDir,
      openspecDir,
      skipCatalog: false,
      force,
      overrides,
      args,
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
    'design-specs': designSpecsCommand,
    'design-tests': designTestsCommand,
    design: designCommand,
  },
});

export default featCommand; // export for validation

// Allow running directly: tsx src/cli/commands/feat.ts
if (process.argv[1]?.endsWith('feat.ts') || process.argv[1]?.endsWith('feat.js')) {
  await runMain(featCommand);
}
