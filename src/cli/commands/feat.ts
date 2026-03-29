#!/usr/bin/env tsx
/**
 * Feat CLI — feature workflow scaffolding.
 *
 * Usage: saifctl feat <subcommand> [options]
 *   new               Create scaffolding for a new feature (prompts for name if not given)
 *   design-discovery  Gather context with MCP/tools, write discovery.md (optional step before design-specs).
 *   design-specs      Generate specs from a feature's proposal only (first step of design).
 *   design-tests      Generate tests from existing specs only (second step of design).
 *   design-fail2pass  Verify generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).
 *   design            Generate specs, tests, and validate the tests (full design workflow)
 *   run               Start an agent to implement the specs. Runs until it passes your tests.
 *   Alias: saifctl feature
 */

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import { loadSaifctlConfig } from '../../config/load.js';
import { type SaifctlConfig } from '../../config/schema.js';
import { runDiscovery } from '../../design-discovery/run.js';
import { runDesignTests } from '../../design-tests/design.js';
import { generateTests } from '../../design-tests/write.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import type { ModelOverrides } from '../../llm-config.js';
import { consola, setVerboseLogging } from '../../logger.js';
import { runFail2Pass, runStart } from '../../orchestrator/modes.js';
import {
  mergeModelOverridesLayers,
  modelOverridesFromSaifctlConfig,
  parseModelOverridesCliDelta,
  pickAgentInstallScript,
  pickAgentProfile,
  pickAgentScript,
  pickGateScript,
  pickSandboxProfile,
  pickStageScript,
  pickStartupScript,
  pickTestProfile,
  pickTestScript,
  resolveOrchestratorOpts,
  resolveSandboxBaseDir,
  resolveStagingEnvironment,
  resolveTestImageTag,
} from '../../orchestrator/options.js';
import type { Feature } from '../../specs/discover.js';
import { pathExists, readUtf8, writeUtf8 } from '../../utils/io.js';
import {
  featRunArgs,
  featTestsArgs,
  indexerArg,
  modelOverrideArgs,
  nameArg,
  projectArg,
  projectDirArg,
  saifctlDirArg,
  testProfileArg,
} from '../args.js';
import type { ParsedArgsFromCommand } from '../types.js';
import {
  buildOrchestratorCliInputFromFeatArgs,
  type FeatRunArgs,
  getFeatNameFromArgs,
  getFeatOrPrompt,
  loadAgentScriptsFromPicks,
  loadGateScriptFromPick,
  loadStageScriptFromPick,
  loadStartupScriptFromPick,
  loadTestScriptFromPick,
  type OrchestratorArgs,
  pickDesignerProfile,
  pickIndexerProfile,
  readAgentInstallScriptPathFromCli,
  readAgentProfileIdFromCli,
  readAgentScriptPathFromCli,
  readDesignerProfileIdFromCli,
  readDiscoveryCliReads,
  readEngineCliFromCli,
  readGateScriptPathFromCli,
  readIndexerProfileIdFromCli,
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  readSandboxBaseDirFromCli,
  readSandboxProfileIdFromCli,
  readStageScriptPathFromCli,
  readStartupScriptPathFromCli,
  readTestImageTagFromCli,
  readTestProfileIdFromCli,
  readTestScriptPathFromCli,
  resolveCliProjectDir,
  resolveDiscoveryOptions,
  resolveProjectName,
  resolveSaifctlDirRelative,
  shouldRunDiscovery,
} from '../utils.js';

/////////////////////////////////////////////
// Shared CLI args
/////////////////////////////////////////////

// Shared feat args — spread into subcommands, override individual attrs as needed
const yesArg = {
  type: 'boolean' as const,
  alias: 'y' as const,
  description:
    'Non-interactive mode. Requires --name/-n. Omits description prompt (defaults to empty).',
};
const designerArg = {
  type: 'string' as const,
  description: `Designer profile for spec generation (default: ${DEFAULT_DESIGNER_PROFILE.id}).`,
};
const forceArg = {
  type: 'boolean' as const,
  alias: 'f' as const,
  description: null,
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
      ...nameArg,
      description: 'Feature name (kebab-case, e.g. add-greeting-cmd)',
    },
    yes: yesArg,
    'saifctl-dir': saifctlDirArg,
    'project-dir': projectDirArg,
    desc: {
      type: 'string',
      description: 'Brief description. When provided, skips the description prompt.',
    },
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const nonInteractive = args.yes === true;
    const namePreFill = getFeatNameFromArgs(args);

    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));

    if (nonInteractive && !namePreFill) {
      consola.error('Error: --name/-n is required when using --yes/-y');
      process.exit(1);
    }

    // Prompt for feature name if not provided
    let featName: string;
    if (nonInteractive) {
      featName = namePreFill!;
    } else {
      intro('New feature');
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

    // Prompt for feature description if not provided
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

    // Create feature directory
    if (!nonInteractive) outro('Creating feature…');

    const featureDir = join(projectDir, saifctlDir, 'features', featName);
    await mkdir(featureDir, { recursive: true });

    // Write proposal.md if description is provided
    if (description) {
      const proposalPath = resolve(featureDir, 'proposal.md');
      await writeUtf8(proposalPath, `## What Changes\n\n${description}\n`);
      consola.log(`\nCreated: ${featureDir}`);
      consola.log(`  proposal.md: ${description}`);
    } else {
      consola.log(`\nCreated: ${featureDir}`);
    }
  },
});

const designSpecsArgs = {
  name: nameArg,
  yes: {
    ...yesArg,
    description:
      'Non-interactive mode. Requires --name/-n. Skips confirm when designer output exists; assumes redo.',
  },
  force: {
    ...forceArg,
    description: 'Always re-run the designer, overwriting existing spec files without prompting.',
  },
  ...modelOverrideArgs,
  designer: designerArg,
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
};

const designDiscoveryArgs = {
  name: nameArg,
  yes: yesArg,
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
  ...modelOverrideArgs,
  'discovery-mcp': {
    type: 'string' as const,
    description:
      'Named MCP server: name=http(s)://url. Multiple or comma-separated. Required format: name=url.',
  },
  'discovery-tool': {
    type: 'string' as const,
    description: 'Path to a single JS/TS file exporting Mastra tools.',
  },
  'discovery-prompt': {
    type: 'string' as const,
    description:
      'Inline heuristic prompt for the discovery agent. Mutually exclusive with --discovery-prompt-file.',
  },
  'discovery-prompt-file': {
    type: 'string' as const,
    description: 'Path to heuristic prompt file. Mutually exclusive with --discovery-prompt.',
  },
};

async function _runDesignDiscovery(args: {
  name?: string;
  'saifctl-dir'?: string;
  'project-dir'?: string;
  model?: string;
  'base-url'?: string;
  'discovery-mcp'?: string | string[];
  'discovery-tool'?: string;
  'discovery-prompt'?: string;
  'discovery-prompt-file'?: string;
  [key: string]: unknown;
}) {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const config = await loadSaifctlConfig(saifctlDir, projectDir);
  const feature = await getFeatOrPrompt(args, projectDir);
  const discovery = resolveDiscoveryOptions(readDiscoveryCliReads(args), projectDir, config);
  if (!shouldRunDiscovery(discovery)) {
    consola.error(
      'Error: design-discovery requires discoveryMcps or discoveryTools (via --discovery-mcp, --discovery-tool, or config).',
    );
    process.exit(1);
  }
  const overrides = mergeModelOverridesLayers(
    modelOverridesFromSaifctlConfig(config),
    undefined,
    parseModelOverridesCliDelta(args),
  );
  consola.log(`\nDiscovery (context gathering): ${feature.name}`);
  await runDiscovery({
    feature,
    projectDir,
    discovery,
    overrides,
  });
  return { feature, projectDir, saifctlDir };
}

async function _runDesignSpecs(args: {
  name?: string;
  yes?: boolean;
  force?: boolean;
  model?: string;
  'base-url'?: string;
  designer?: string;
  'saifctl-dir'?: string;
  'project-dir'?: string;
  [key: string]: unknown;
}) {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const config = await loadSaifctlConfig(saifctlDir, projectDir);
  const nonInteractive = args.yes === true;
  const force = args.force === true;
  if (nonInteractive && !getFeatNameFromArgs(args)) {
    consola.error('Error: --name/-n is required when using --yes/-y');
    process.exit(1);
  }
  const feature = await getFeatOrPrompt(args, projectDir);
  const designerProfile = pickDesignerProfile(readDesignerProfileIdFromCli(args), config);
  const overrides = mergeModelOverridesLayers(
    modelOverridesFromSaifctlConfig(config),
    undefined,
    parseModelOverridesCliDelta(args),
  );

  const designerBaseOpts = { cwd: projectDir, feature, saifctlDir };

  // 1. Generate full specs and plan from user's proposal (and discovery.md when present).
  // 1a. Check if the designer has already run
  let runDesigner = force || !(await designerProfile.hasRun(designerBaseOpts));
  if (!runDesigner) {
    // Allow non-interactive mode to override the prompt.
    if (nonInteractive) {
      runDesigner = true;
    } else {
      intro(`${designerProfile.displayName} output present`);
      const redo = await confirm({
        message: `${feature.relativePath} already has designer output. Redo ${designerProfile.displayName} spec generation?`,
      });
      outro('');
      if (isCancel(redo)) {
        cancel('Operation cancelled.');
        process.exit(1);
      }
      runDesigner = redo === true;
    }
  }

  // 1b. Build designer prompt (proposal + discovery.md when present)
  const proposalPath = join(feature.absolutePath, 'proposal.md');
  const discoveryPath = join(feature.absolutePath, 'discovery.md');
  let designerPrompt: string | undefined;
  const hasProposal = await pathExists(proposalPath);
  const hasDiscovery = await pathExists(discoveryPath);
  if (hasProposal || hasDiscovery) {
    const proposalContent = hasProposal ? await readUtf8(proposalPath) : '';
    const discoveryContent = hasDiscovery ? await readUtf8(discoveryPath) : '';
    designerPrompt =
      proposalContent +
      (discoveryContent
        ? `\n\n---\n\nA Discovery Agent has gathered the following context. You MUST adhere to these constraints and facts when designing the feature:\n\n${discoveryContent}`
        : '');
  }

  // 1c. Run the designer if needed
  if (runDesigner) {
    consola.log(`\n${designerProfile.displayName} (spec generation): ${feature.name}`);
    await designerProfile.run({
      ...designerBaseOpts,
      model: typeof args.model === 'string' ? args.model.trim() : undefined,
      prompt: designerPrompt,
    });
  } else {
    consola.log(`\nSkipping designer (${feature.relativePath} already has required spec files).`);
  }

  return {
    feature,
    projectDir,
    saifctlDir,
    overrides,
    config,
  };
}

const designSpecsCommand = defineCommand({
  meta: {
    name: 'design-specs',
    description: "Generate specs from feature's proposal only (first step of design workflow)",
  },
  args: designSpecsArgs,
  async run({ args }) {
    await _runDesignSpecs(args);
    consola.log('\nDone.');
  },
});

const designDiscoveryCommand = defineCommand({
  meta: {
    name: 'design-discovery',
    description:
      'Gather context using MCP/tools, write discovery.md (optional step before design-specs)',
  },
  args: designDiscoveryArgs,
  async run({ args }) {
    await _runDesignDiscovery(args);
    consola.log('\nDone.');
  },
});

const designTestsArgs = {
  name: nameArg,
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
  'test-profile': testProfileArg,
  indexer: indexerArg,
  project: projectArg,
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
  feature: Feature;
  projectDir: string;
  skipCatalog: boolean;
  force: boolean;
  overrides: ModelOverrides;
  config?: SaifctlConfig;
  args: {
    'test-profile'?: string;
    indexer?: string;
    project?: string;
    [key: string]: unknown;
  };
}

async function _runDesignTests({
  feature,
  projectDir,
  skipCatalog,
  force,
  overrides,
  config,
  args,
}: DesignTestsOptions) {
  const projectName = await resolveProjectName({ project: args.project, projectDir, config });
  const testProfile = pickTestProfile(readTestProfileIdFromCli(args), config);
  const indexerProfile = pickIndexerProfile(readIndexerProfileIdFromCli(args), config);

  if (!skipCatalog) {
    // 2a. Read specs and generate a plan of what to test as markdown and JSON.
    consola.log(`\nTests Catalog: ${feature.name} (profile: ${testProfile.id})`);
    if (indexerProfile) {
      consola.log(`  Indexer: ${indexerProfile.displayName} (project: ${projectName})`);
    }
    const designResult = await runDesignTests({
      feature,
      projectDir,
      testProfile,
      indexerProfile,
      projectName,
      overrides,
    });
    consola.log(`  Test plan:  ${designResult.testPlanPath}`);
    consola.log(`  Catalog:    ${designResult.catalogPath}`);
  } else {
    consola.log(`\nSkipping catalog generation (--skip-catalog). Reading existing tests.json.`);
  }

  // 2b. Write actual tests from the test plan.
  consola.log(`\nGenerating spec files from catalog...`);
  const implResult = await generateTests({
    feature,
    force,
    testProfile,
    overrides,
  });

  consola.log(`\nTest scaffolding complete:`);
  consola.log(`  Test cases:      ${implResult.testCaseCount}`);
  if (implResult.generatedFiles.length > 0) {
    consola.log(`  Generated files: ${implResult.generatedFiles.length}`);
    for (const f of implResult.generatedFiles) consola.log(`    + ${f}`);
  }
  if (implResult.skippedFiles.length > 0) {
    consola.log(`  Skipped (exist): ${implResult.skippedFiles.length}`);
    for (const f of implResult.skippedFiles) consola.log(`    ~ ${f}`);
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
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const feature = await getFeatOrPrompt(args, projectDir);
    const overrides = mergeModelOverridesLayers(
      modelOverridesFromSaifctlConfig(config),
      undefined,
      parseModelOverridesCliDelta(args),
    );

    const skipCatalog = args['skip-catalog'] === true;
    const force = args.force === true;
    await _runDesignTests({
      feature,
      projectDir,
      skipCatalog,
      force,
      overrides,
      config,
      args,
    });

    consola.log('\nDone.');
  },
});

// ---------------------------------------------------------------------------
// design-fail2pass: Fail2Pass verification
// ---------------------------------------------------------------------------

const designFail2passArgs = {
  name: nameArg,
  'saifctl-dir': saifctlDirArg,
  'project-dir': projectDirArg,
  project: projectArg,
  'test-profile': testProfileArg,
  ...featTestsArgs,
};

type DesignFail2passArgs = OrchestratorArgs & {
  'sandbox-base-dir'?: string;
  'test-profile'?: string;
  project?: string;
};

async function _runDesignFail2pass(opts: {
  feature: Feature;
  projectDir: string;
  saifctlDir: string;
  config?: SaifctlConfig;
  args: DesignFail2passArgs;
}): Promise<void> {
  const { feature, projectDir, saifctlDir, config, args } = opts;
  const sandboxBaseDir = readSandboxBaseDirFromCli(args) ?? resolveSandboxBaseDir(config);

  const projectName = await resolveProjectName({ project: args.project, projectDir, config });
  const sandboxProfile = pickSandboxProfile(readSandboxProfileIdFromCli(args), config);
  const testProfile = pickTestProfile(readTestProfileIdFromCli(args), config);
  const testImage = resolveTestImageTag(readTestImageTagFromCli(args), testProfile.id, config);

  const startupPick = pickStartupScript(readStartupScriptPathFromCli(args), config);
  const gatePick = pickGateScript(readGateScriptPathFromCli(args), config);
  const stagePick = pickStageScript(readStageScriptPathFromCli(args), config);
  const agentProfile = pickAgentProfile(readAgentProfileIdFromCli(args), config);

  const [gateR, startupR, stageR, agentR, testR] = await Promise.all([
    loadGateScriptFromPick({
      pick: gatePick,
      sandboxProfileId: sandboxProfile.id,
      projectDir,
    }),
    loadStartupScriptFromPick({
      pick: startupPick,
      sandboxProfileId: sandboxProfile.id,
      projectDir,
    }),
    loadStageScriptFromPick({
      pick: stagePick,
      sandboxProfileId: sandboxProfile.id,
      projectDir,
    }),
    loadAgentScriptsFromPicks({
      installPick: pickAgentInstallScript(readAgentInstallScriptPathFromCli(args)),
      scriptPick: pickAgentScript(readAgentScriptPathFromCli(args)),
      agentProfileId: agentProfile.id,
      projectDir,
    }),
    loadTestScriptFromPick({
      pick: pickTestScript(readTestScriptPathFromCli(args), config),
      testProfileId: testProfile.id,
      projectDir,
    }),
  ]);
  const gateScript = gateR.gateScript;
  const startupScript = startupR.startupScript;
  const stageScript = stageR.stageScript;
  const { agentInstallScript, agentScript } = agentR;
  const testScript = testR.testScript;

  const stagingEnvironment = resolveStagingEnvironment(config);
  const includeDirty =
    args['include-dirty'] === true ? true : (config?.defaults?.includeDirty ?? false);

  consola.log(`\nFail2Pass verification: ${feature.name}`);
  const result = await runFail2Pass({
    sandboxProfileId: sandboxProfile.id,
    feature,
    projectDir,
    saifctlDir,
    sandboxBaseDir,
    projectName,
    testImage,
    stagingEnvironment,
    gateScript,
    agentInstallScript,
    agentScript,
    stageScript,
    testScript,
    startupScript,
    includeDirty,
  });

  consola.log(`\n${result.message}`);
  if (result.status !== 'success') process.exit(1);
}

const designFail2passCommand = defineCommand({
  meta: {
    name: 'design-fail2pass',
    description:
      'Validate generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).',
  },
  args: designFail2passArgs,
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const feature = await getFeatOrPrompt(args, projectDir);
    await _runDesignFail2pass({
      feature,
      projectDir,
      saifctlDir,
      config,
      args: args as DesignFail2passArgs,
    });
    consola.log('\nDone.');
  },
});

// design-tests args for feat design (excludes --skip-catalog; full design always runs catalog)
const { 'skip-catalog': _skipCatalog, ...designTestsArgsForDesign } = designTestsArgs;

const designCommand = defineCommand({
  meta: {
    name: 'design',
    description: 'Generate specs, tests, and validate the tests (full design workflow)',
  },
  args: {
    ...designDiscoveryArgs,
    ...designSpecsArgs,
    ...designTestsArgsForDesign,
    ...designFail2passArgs,
  },
  async run({ args }) {
    const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
    const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const discovery = resolveDiscoveryOptions(readDiscoveryCliReads(args), projectDir, config);

    // 0. Design-discovery (when mcps or tools configured)
    if (shouldRunDiscovery(discovery)) {
      await _runDesignDiscovery(args);
    }

    // 1. Generate specs
    const designSpecsResult = await _runDesignSpecs(args);
    const { feature, overrides } = designSpecsResult;
    // 2. Generate tests
    await _runDesignTests({
      feature,
      projectDir,
      skipCatalog: false,
      force: !!args.force,
      overrides,
      config,
      args,
    });
    // 3. Verify tests (expect them to fail)
    await _runDesignFail2pass({
      feature,
      projectDir,
      saifctlDir,
      config,
      args: args as DesignFail2passArgs,
    });
    consola.log('\nDone.');
  },
});

// ---------------------------------------------------------------------------
// run: Start new iterative OpenHands loop until tests pass
// ---------------------------------------------------------------------------

const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Start an agent to implement the specs. Runs until it passes your tests',
  },
  args: featRunArgs,
  async run({ args }) {
    const runArgs = await parseRunArgs(args);
    const result = await runStart({
      ...runArgs,
      fromArtifact: null,
    });

    consola.log(`\n${result.message}`);
    if (result.runId && runArgs.runStorage && result.status !== 'success') {
      consola.log(`\nStart again with:`);
      consola.log(`  saifctl run start ${result.runId}`);
    }
    // User-driven pause/stop are not CLI failures: exit 0 like success; only true run failures exit 1.
    if (result.status === 'failed') process.exit(1);
  },
});

export const parseRunArgs = async (args: ParsedArgsFromCommand<typeof runCommand>) => {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const config = await loadSaifctlConfig(saifctlDir, projectDir);

  const feature = await getFeatOrPrompt(args, projectDir);
  const runArgs = args as FeatRunArgs;
  setVerboseLogging(runArgs.verbose === true);

  const cli = await buildOrchestratorCliInputFromFeatArgs(runArgs, {
    projectDir,
    saifctlDir,
    config,
  });
  const cliModelDelta = parseModelOverridesCliDelta(runArgs);

  const engineCli = readEngineCliFromCli(runArgs);

  const orchestratorOpts = await resolveOrchestratorOpts({
    projectDir,
    saifctlDir,
    config,
    feature,
    cli,
    cliModelDelta,
    artifact: null,
    engineCli,
  });

  return orchestratorOpts;
};

const featCommand = defineCommand({
  meta: {
    name: 'feat',
    description: 'Feature workflow (alias: feature)',
  },
  subCommands: {
    new: newCommand,
    'design-discovery': designDiscoveryCommand,
    'design-specs': designSpecsCommand,
    'design-tests': designTestsCommand,
    'design-fail2pass': designFail2passCommand,
    design: designCommand,
    run: runCommand,
  },
});

export default featCommand; // export for validation

// Allow running directly: tsx src/cli/commands/feat.ts
if (process.argv[1]?.endsWith('feat.ts') || process.argv[1]?.endsWith('feat.js')) {
  await runMain(featCommand);
}
