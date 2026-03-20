#!/usr/bin/env tsx
/**
 * Feat CLI — feature workflow scaffolding.
 *
 * Usage: saifac feat <subcommand> [options]
 *   new               Create scaffolding for a new feature (prompts for name if not given)
 *   design-discovery  Gather context with MCP/tools, write discovery.md (optional step before design-specs).
 *   design-specs      Generate specs from a feature's proposal only (first step of design).
 *   design-tests      Generate tests from existing specs only (second step of design).
 *   design-fail2pass  Verify generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).
 *   design            Generate specs, tests, and validate the tests (full design workflow)
 *   run               Start an agent to implement the specs. Runs until it passes your tests.
 *   debug             Spin up staging container only, stream logs (Ctrl+C to stop)
 *   Alias: saifac feature
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import {
  DEFAULT_AGENT_PROFILE,
  resolveAgentScriptPath,
  resolveAgentStartScriptPath,
} from '../../agent-profiles/index.js';
import { loadSaifConfig } from '../../config/load.js';
import { type SaifConfig } from '../../config/schema.js';
import { runDiscovery } from '../../design-discovery/run.js';
import { runDesignTests } from '../../design-tests/design.js';
import { generateTests } from '../../design-tests/write.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import type { ModelOverrides } from '../../llm-config.js';
import { runDebug, runFail2Pass, runStart } from '../../orchestrator/modes.js';
import { readSandboxGateScript } from '../../sandbox-profiles/index.js';
import type { Feature } from '../../specs/discover.js';
import { pathExists, readUtf8, writeUtf8 } from '../../utils/io.js';
import {
  featRunArgs,
  featTestsArgs,
  indexerArg,
  modelOverrideArgs,
  nameArg,
  profileArg,
  projectArg,
  projectDirArg,
  saifDirArg,
  sandboxBaseDirArg,
  stageScriptArg,
  startupScriptArg,
  testProfileArg,
} from '../args.js';
import type { ParsedArgsFromCommand } from '../types.js';
import {
  type FeatRunArgs,
  getFeatNameFromArgs,
  getFeatOrPrompt,
  type OrchestratorArgs,
  parseAgentEnv,
  parseAgentLogFormat,
  parseAgentProfile,
  parseAgentScripts,
  parseCedarPolicyPath,
  parseCoderImage,
  parseCodingEnvironment,
  parseDangerousDebug,
  parseDesignerProfile,
  parseDiscoveryOptions,
  parseGateRetries,
  parseGateScript,
  parseGitProvider,
  parseIndexerProfile,
  parseMaxRuns,
  parseModelOverrides,
  parsePr,
  parseProjectDir,
  parsePush,
  parseResolveAmbiguity,
  parseReviewerEnabled,
  parseRunStorage,
  parseSaifDir,
  parseSandboxBaseDir,
  parseSandboxProfile,
  parseStageScript,
  parseStagingEnvironment,
  parseStartupScript,
  parseTestImage,
  parseTestProfile,
  parseTestRetries,
  parseTestScript,
  resolveProjectName,
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
    'saifac-dir': saifDirArg,
    'project-dir': projectDirArg,
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

    const saifDir = parseSaifDir(args);

    if (nonInteractive && !namePreFill) {
      console.error('Error: --name/-n is required when using --yes/-y');
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

    const featureDir = join(projectDir, saifDir, 'features', featName);
    mkdirSync(featureDir, { recursive: true });

    // Write proposal.md if description is provided
    if (description) {
      const proposalPath = resolve(featureDir, 'proposal.md');
      await writeUtf8(proposalPath, `## What Changes\n\n${description}\n`);
      console.log(`\nCreated: ${featureDir}`);
      console.log(`  proposal.md: ${description}`);
    } else {
      console.log(`\nCreated: ${featureDir}`);
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
  'saifac-dir': saifDirArg,
  'project-dir': projectDirArg,
};

const designDiscoveryArgs = {
  name: nameArg,
  yes: yesArg,
  'saifac-dir': saifDirArg,
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
  'saifac-dir'?: string;
  'project-dir'?: string;
  model?: string;
  'base-url'?: string;
  'discovery-mcp'?: string | string[];
  'discovery-tool'?: string;
  'discovery-prompt'?: string;
  'discovery-prompt-file'?: string;
  [key: string]: unknown;
}) {
  const projectDir = parseProjectDir(args);
  const saifDir = parseSaifDir(args);
  const config = await loadSaifConfig(saifDir, projectDir);
  const feature = await getFeatOrPrompt(args, projectDir);
  const discovery = parseDiscoveryOptions(args, projectDir, config);
  if (!shouldRunDiscovery(discovery)) {
    console.error(
      'Error: design-discovery requires discoveryMcps or discoveryTools (via --discovery-mcp, --discovery-tool, or config).',
    );
    process.exit(1);
  }
  const overrides = parseModelOverrides(args, config);
  console.log(`\nDiscovery (context gathering): ${feature.name}`);
  await runDiscovery({
    feature,
    projectDir,
    discovery,
    overrides,
  });
  return { feature, projectDir, saifDir };
}

async function _runDesignSpecs(args: {
  name?: string;
  yes?: boolean;
  force?: boolean;
  model?: string;
  'base-url'?: string;
  designer?: string;
  'saifac-dir'?: string;
  'project-dir'?: string;
  [key: string]: unknown;
}) {
  const projectDir = parseProjectDir(args);
  const saifDir = parseSaifDir(args);
  const config = await loadSaifConfig(saifDir, projectDir);
  const nonInteractive = args.yes === true;
  const force = args.force === true;
  if (nonInteractive && !getFeatNameFromArgs(args)) {
    console.error('Error: --name/-n is required when using --yes/-y');
    process.exit(1);
  }
  const feature = await getFeatOrPrompt(args, projectDir);
  const designerProfile = parseDesignerProfile(args, config);
  const overrides = parseModelOverrides(args, config);

  const designerBaseOpts = { cwd: projectDir, feature, saifDir };

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
    console.log(`\n${designerProfile.displayName} (spec generation): ${feature.name}`);
    await designerProfile.run({
      ...designerBaseOpts,
      model: typeof args.model === 'string' ? args.model.trim() : undefined,
      prompt: designerPrompt,
    });
  } else {
    console.log(`\nSkipping designer (${feature.relativePath} already has required spec files).`);
  }

  return {
    feature,
    projectDir,
    saifDir,
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
    console.log('\nDone.');
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
    console.log('\nDone.');
  },
});

const designTestsArgs = {
  name: nameArg,
  'saifac-dir': saifDirArg,
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
  config?: SaifConfig;
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
  const projectName = await resolveProjectName(args, projectDir, config);
  const testProfile = parseTestProfile(args, config);
  const indexerProfile = parseIndexerProfile(args, config);

  if (!skipCatalog) {
    // 2a. Read specs and generate a plan of what to test as markdown and JSON.
    console.log(`\nTests Catalog: ${feature.name} (profile: ${testProfile.id})`);
    if (indexerProfile) {
      console.log(`  Indexer: ${indexerProfile.displayName} (project: ${projectName})`);
    }
    const designResult = await runDesignTests({
      feature,
      projectDir,
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
    feature,
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
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const feature = await getFeatOrPrompt(args, projectDir);
    const overrides = parseModelOverrides(args, config);

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

    console.log('\nDone.');
  },
});

// ---------------------------------------------------------------------------
// design-fail2pass: Fail2Pass verification
// ---------------------------------------------------------------------------

const designFail2passArgs = {
  name: nameArg,
  'saifac-dir': saifDirArg,
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
  saifDir: string;
  config?: SaifConfig;
  args: DesignFail2passArgs;
}): Promise<void> {
  const { feature, projectDir, saifDir, config, args } = opts;
  const sandboxBaseDir = parseSandboxBaseDir(args, config);

  const projectName = await resolveProjectName(args, projectDir, config);
  const sandboxProfile = parseSandboxProfile(args, config);
  const testProfile = parseTestProfile(args, config);
  const testImage = parseTestImage(args, testProfile.id, config);

  const [gateScript, startupScript, stageScript, { agentStartScript, agentScript }, testScript] =
    await Promise.all([
      parseGateScript({ args, projectDir, config }),
      parseStartupScript({ args, projectDir, config }),
      parseStageScript({ args, projectDir, config }),
      parseAgentScripts({ args, projectDir, config }),
      parseTestScript({ args, projectDir, profileId: testProfile.id, config }),
    ]);

  const stagingEnvironment = parseStagingEnvironment(config);

  console.log(`\nFail2Pass verification: ${feature.name}`);
  const result = await runFail2Pass({
    sandboxProfileId: sandboxProfile.id,
    feature,
    projectDir,
    saifDir,
    sandboxBaseDir,
    projectName,
    testImage,
    stagingEnvironment,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    testScript,
    startupScript,
  });

  console.log(`\n${result.message}`);
  if (!result.success) process.exit(1);
}

const designFail2passCommand = defineCommand({
  meta: {
    name: 'design-fail2pass',
    description:
      'Validate generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).',
  },
  args: designFail2passArgs,
  async run({ args }) {
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const feature = await getFeatOrPrompt(args, projectDir);
    await _runDesignFail2pass({
      feature,
      projectDir,
      saifDir,
      config,
      args: args as DesignFail2passArgs,
    });
    console.log('\nDone.');
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
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const discovery = parseDiscoveryOptions(args, projectDir, config);

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
      saifDir,
      config,
      args: args as DesignFail2passArgs,
    });
    console.log('\nDone.');
  },
});

// ---------------------------------------------------------------------------
// debug: Spin up staging container, stream logs
// ---------------------------------------------------------------------------

const featDebugArgs = {
  name: nameArg,
  'saifac-dir': saifDirArg,
  'project-dir': projectDirArg,
  project: projectArg,
  'sandbox-base-dir': sandboxBaseDirArg,
  profile: profileArg,
  'startup-script': startupScriptArg,
  'stage-script': stageScriptArg,
};

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
      resume: null,
    });

    console.log(`\n${result.message}`);
    if (result.runId) {
      console.log(`\nResume with:`);
      console.log(`  saifac run resume ${result.runId}`);
    }
    if (!result.success) process.exit(1);
  },
});

export const parseRunArgs = async (args: ParsedArgsFromCommand<typeof runCommand>) => {
  const projectDir = parseProjectDir(args);
  const saifDir = parseSaifDir(args);
  const config = await loadSaifConfig(saifDir, projectDir);

  const feature = await getFeatOrPrompt(args, projectDir);
  const runArgs = args as FeatRunArgs;

  const maxRuns = parseMaxRuns(runArgs, config);
  const overrides = parseModelOverrides(args, config);
  const sandboxBaseDir = parseSandboxBaseDir(args, config);
  const projectName = await resolveProjectName(args, projectDir, config);
  const testProfile = parseTestProfile(args, config);
  const testImage = parseTestImage(runArgs, testProfile.id, config);
  const resolveAmbiguity = parseResolveAmbiguity(runArgs, config);
  const testRetries = parseTestRetries(runArgs, config);
  const dangerousDebug = parseDangerousDebug(runArgs, config);
  const cedarPolicyPath = parseCedarPolicyPath(runArgs, config);
  const coderImage = parseCoderImage(runArgs, config);
  const sandboxProfile = parseSandboxProfile(runArgs, config);
  const agentProfile = parseAgentProfile(runArgs, config);

  const [startupScript, gateScript, { agentStartScript, agentScript }, stageScript, testScript] =
    await Promise.all([
      parseStartupScript({ args: runArgs, projectDir, config }),
      parseGateScript({ args: runArgs, projectDir, config }),
      parseAgentScripts({ args: runArgs, projectDir, config }),
      parseStageScript({ args: runArgs, projectDir, config }),
      parseTestScript({
        args: runArgs,
        projectDir,
        profileId: testProfile.id,
        config,
      }),
    ]);

  const gateRetries = parseGateRetries(runArgs, config);
  const reviewerEnabled = parseReviewerEnabled(runArgs, config);
  const agentEnv = await parseAgentEnv({ args: runArgs, projectDir, config });
  const agentLogFormat = parseAgentLogFormat(runArgs, agentProfile, config);
  const push = parsePush(runArgs, config);
  const pr = parsePr(runArgs, config);
  const gitProvider = parseGitProvider(runArgs, config);
  const runStorage = parseRunStorage(runArgs, projectDir, config);
  const stagingEnvironment = parseStagingEnvironment(config);
  const codingEnvironment = parseCodingEnvironment(config);

  console.log(`\nStarting iterative loop: ${feature.name}`);
  console.log(`  Max runs: ${maxRuns}`);
  console.log(`  Test retries: ${testRetries}`);
  console.log(`  Spec ambiguity resolution: ${resolveAmbiguity}`);
  console.log(`  Test image: ${testImage}`);
  if (dangerousDebug) {
    console.log('  Leash: disabled (host execution)');
  } else {
    console.log(`  Leash: enabled (image: ${coderImage})`);
    console.log(`  Cedar policy: ${cedarPolicyPath}`);
  }
  console.log(`  Startup script: ${sandboxProfile.id} profile default`);
  console.log(`  Gate script: ${sandboxProfile.id} profile default`);
  console.log(`  Agent: ${agentProfile.displayName} (profile: ${agentProfile.id})`);
  console.log(`  Stage script: ${sandboxProfile.id} profile default`);
  console.log('  Test script: built-in (test-default.sh)');
  console.log(`  Agent log format: ${agentLogFormat}`);
  console.log(`  Agent env vars: ${Object.keys(agentEnv).join(', ') || 'none'}`);
  console.log(`  Gate retries: ${gateRetries}`);
  if (push) console.log(`  Push: ${push}${pr ? ` (+ PR via ${gitProvider.id})` : ''}`);
  if (runArgs.verbose === true) console.log('  Verbose: enabled');

  return {
    sandboxProfileId: sandboxProfile.id,
    feature,
    projectDir,
    maxRuns,
    overrides,
    saifDir,
    sandboxBaseDir,
    projectName,
    testImage,
    resolveAmbiguity,
    testRetries,
    dangerousDebug,
    cedarPolicyPath,
    coderImage,
    startupScript,
    gateScript,
    agentStartScript,
    agentScript,
    stageScript,
    testScript,
    testProfile,
    agentEnv,
    agentLogFormat,
    gateRetries,
    reviewerEnabled,
    push,
    pr,
    gitProvider,
    runStorage,
    stagingEnvironment,
    codingEnvironment,
    resume: null,
    verbose: !!runArgs.verbose,
  };
};

// ---------------------------------------------------------------------------
// debug: Spin up staging container, stream logs
// ---------------------------------------------------------------------------

const debugCommand = defineCommand({
  meta: {
    name: 'debug',
    description:
      'Spin up the staging container and stream its logs (Ctrl+C to stop). Useful for diagnosing startup failures.',
  },
  args: featDebugArgs,
  async run({ args }) {
    const projectDir = parseProjectDir(args);
    const saifDir = parseSaifDir(args);
    const config = await loadSaifConfig(saifDir, projectDir);
    const feature = await getFeatOrPrompt(args, projectDir);
    const sandboxBaseDir = parseSandboxBaseDir(args, config);
    const projectName = await resolveProjectName(args, projectDir, config);
    const sandboxProfile = parseSandboxProfile(args, config);

    const [startupScript, stageScript] = await Promise.all([
      parseStartupScript({ args, projectDir, config }),
      parseStageScript({ args, projectDir, config }),
    ]);

    const gateScript = await readSandboxGateScript(sandboxProfile.id);
    const agentStartScript = await readUtf8(resolveAgentStartScriptPath(DEFAULT_AGENT_PROFILE.id));
    const agentScript = await readUtf8(resolveAgentScriptPath(DEFAULT_AGENT_PROFILE.id));

    const stagingEnvironment = parseStagingEnvironment(config);

    console.log(`\nDebug staging container: ${feature.name}`);
    console.log('  Ctrl+C to stop and clean up.\n');

    await runDebug({
      sandboxProfileId: sandboxProfile.id,
      feature,
      projectDir,
      saifDir,
      sandboxBaseDir,
      projectName,
      stagingEnvironment,
      startupScript,
      gateScript,
      agentStartScript,
      agentScript,
      stageScript,
    });
  },
});

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
    debug: debugCommand,
  },
});

export default featCommand; // export for validation

// Allow running directly: tsx src/cli/commands/feat.ts
if (process.argv[1]?.endsWith('feat.ts') || process.argv[1]?.endsWith('feat.js')) {
  await runMain(featCommand);
}
