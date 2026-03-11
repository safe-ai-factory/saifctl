#!/usr/bin/env tsx
/**
 * Feat CLI — feature workflow scaffolding.
 *
 * Usage: saif feat <subcommand> [options]
 *   new               Create scaffolding for a new feature (prompts for name if not given)
 *   design-specs      Generate specs from a feature's proposal only (first step of design).
 *   design-tests      Generate tests from existing specs only (second step of design).
 *   design-fail2pass  Verify generated tests. Runs tests against main; at least one feature test must fail (third step of design workflow).
 *   design            Generate specs, tests, and validate the tests (full design workflow)
 *   run               Start an agent to implement the specs. Runs until it passes your tests.
 *   debug             Spin up staging container only, stream logs (Ctrl+C to stop)
 *   Alias: saif feature
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import {
  DEFAULT_AGENT_PROFILE,
  resolveAgentScriptPath,
  resolveAgentStartScriptPath,
} from '../../agent-profiles/index.js';
import { runDesignTests } from '../../design-tests/design.js';
import { generateTests } from '../../design-tests/write.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import type { ModelOverrides } from '../../llm-config.js';
import { runDebug, runFail2Pass, runStart } from '../../orchestrator/modes.js';
import { readSandboxGateScript } from '../../sandbox-profiles/index.js';
import type { Feature } from '../../specs/discover.js';
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
  parseDangerousDebug,
  parseDesignerProfile,
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
  parseRunStorage,
  parseSaifDir,
  parseSandboxBaseDir,
  parseSandboxProfile,
  parseStageScript,
  parseStartupScript,
  parseTestImage,
  parseTestProfile,
  parseTestRetries,
  parseTestScript,
  resolveProjectName,
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
    'saif-dir': saifDirArg,
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

    if (nonInteractive && !namePreFill) {
      console.error('Error: --name/-n is required when using --yes/-y');
      process.exit(1);
    }

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

    if (!nonInteractive) outro('Creating feature…');

    const saifDir = parseSaifDir(args);
    const featureDir = join(projectDir, saifDir, 'features', featName);
    mkdirSync(featureDir, { recursive: true });
    if (description) {
      const proposalPath = resolve(featureDir, 'proposal.md');
      writeFileSync(proposalPath, `## What Changes\n\n${description}\n`, 'utf8');
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
  'saif-dir': saifDirArg,
  'project-dir': projectDirArg,
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
  'saif-dir'?: string;
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
  const feature = await getFeatOrPrompt(args, projectDir);
  const saifDir = parseSaifDir(args);
  const designerProfile = parseDesignerProfile(args);

  const designerBaseOpts = { cwd: projectDir, feature, saifDir };

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

  // 1b. Run the designer if needed
  if (runDesigner) {
    console.log(`\n${designerProfile.displayName} (spec generation): ${feature.name}`);
    await designerProfile.run({
      ...designerBaseOpts,
      model: typeof args.model === 'string' ? args.model.trim() : undefined,
    });
  } else {
    console.log(`\nSkipping designer (${feature.relativePath} already has required spec files).`);
  }

  const overrides = parseModelOverrides(args);
  return { feature, projectDir, saifDir, overrides };
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
  name: nameArg,
  'saif-dir': saifDirArg,
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
  args,
}: DesignTestsOptions) {
  const projectName = resolveProjectName(args, projectDir);
  const testProfile = parseTestProfile(args);
  const indexerProfile = parseIndexerProfile(args);

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
    const feature = await getFeatOrPrompt(args, projectDir);
    const overrides = parseModelOverrides(args);

    const skipCatalog = args['skip-catalog'] === true;
    const force = args.force === true;
    await _runDesignTests({
      feature,
      projectDir,
      skipCatalog,
      force,
      overrides,
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
  'saif-dir': saifDirArg,
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
  args: DesignFail2passArgs;
}): Promise<void> {
  const { feature, projectDir, saifDir, args } = opts;
  const sandboxBaseDir = parseSandboxBaseDir(args);

  const projectName = resolveProjectName(args, projectDir);
  const sandboxProfile = parseSandboxProfile(args);
  const testProfile = parseTestProfile(args);
  const testImage = parseTestImage(args, testProfile.id);

  const [gateScript, startupScript, stageScript, { agentStartScript, agentScript }, testScript] =
    await Promise.all([
      parseGateScript({ args, projectDir }),
      parseStartupScript({ args, projectDir }),
      parseStageScript({ args, projectDir }),
      parseAgentScripts({ args, projectDir }),
      parseTestScript({ args, projectDir, profileId: testProfile.id }),
    ]);

  console.log(`\nFail2Pass verification: ${feature.name}`);
  const result = await runFail2Pass({
    sandboxProfileId: sandboxProfile.id,
    feature,
    projectDir,
    saifDir,
    sandboxBaseDir,
    projectName,
    testImage,
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
    const feature = await getFeatOrPrompt(args, projectDir);
    const saifDir = parseSaifDir(args);
    await _runDesignFail2pass({
      feature,
      projectDir,
      saifDir,
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
    ...designSpecsArgs,
    ...designTestsArgsForDesign,
    ...designFail2passArgs,
  },
  async run({ args }) {
    // 1. Generate specs
    const { feature, projectDir, saifDir, overrides } = await _runDesignSpecs(args);
    // 2. Generate tests
    await _runDesignTests({
      feature,
      projectDir,
      skipCatalog: false,
      force: !!args.force,
      overrides,
      args,
    });
    // 3. Verify tests (expect them to fail)
    await _runDesignFail2pass({
      feature,
      projectDir,
      saifDir,
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
  'saif-dir': saifDirArg,
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
      console.log(`  saif run resume ${result.runId}`);
    }
    if (!result.success) process.exit(1);
  },
});

export const parseRunArgs = async (args: ParsedArgsFromCommand<typeof runCommand>) => {
  const projectDir = parseProjectDir(args);
  const feature = await getFeatOrPrompt(args, projectDir);
  const runArgs = args as FeatRunArgs;

  const maxRuns = parseMaxRuns(runArgs);
  const overrides = parseModelOverrides(args);
  const saifDir = parseSaifDir(args);
  const sandboxBaseDir = parseSandboxBaseDir(args);
  const projectName = resolveProjectName(args, projectDir);
  const testProfile = parseTestProfile(args);
  const testImage = parseTestImage(runArgs, testProfile.id);
  const resolveAmbiguity = parseResolveAmbiguity(runArgs);
  const testRetries = parseTestRetries(runArgs);
  const dangerousDebug = parseDangerousDebug(runArgs);
  const cedarPolicyPath = parseCedarPolicyPath(runArgs);
  const coderImage = parseCoderImage(runArgs);
  const sandboxProfile = parseSandboxProfile(runArgs);
  const agentProfile = parseAgentProfile(runArgs);

  const [startupScript, gateScript, { agentStartScript, agentScript }, stageScript, testScript] =
    await Promise.all([
      parseStartupScript({ args: runArgs, projectDir }),
      parseGateScript({ args: runArgs, projectDir }),
      parseAgentScripts({ args: runArgs, projectDir }),
      parseStageScript({ args: runArgs, projectDir }),
      parseTestScript({ args: runArgs, projectDir, profileId: testProfile.id }),
    ]);

  const gateRetries = parseGateRetries(runArgs);
  const agentEnv = parseAgentEnv({ args: runArgs, projectDir });
  const agentLogFormat = parseAgentLogFormat(runArgs, agentProfile);
  const push = parsePush(runArgs);
  const pr = parsePr(runArgs);
  const gitProvider = parseGitProvider(runArgs);
  const runStorage = parseRunStorage(runArgs, projectDir);

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
    push,
    pr,
    gitProvider,
    runStorage,
    resume: null,
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
    const feature = await getFeatOrPrompt(args, projectDir);
    const saifDir = parseSaifDir(args);
    const sandboxBaseDir = parseSandboxBaseDir(args);
    const projectName = resolveProjectName(args, projectDir);
    const sandboxProfile = parseSandboxProfile(args);

    const [startupScript, stageScript] = await Promise.all([
      parseStartupScript({ args, projectDir }),
      parseStageScript({ args, projectDir }),
    ]);

    const gateScript = readSandboxGateScript(sandboxProfile.id);
    const agentStartScript = readFileSync(
      resolveAgentStartScriptPath(DEFAULT_AGENT_PROFILE.id),
      'utf8',
    );
    const agentScript = readFileSync(resolveAgentScriptPath(DEFAULT_AGENT_PROFILE.id), 'utf8');

    console.log(`\nDebug staging container: ${feature.name}`);
    console.log('  Ctrl+C to stop and clean up.\n');

    await runDebug({
      sandboxProfileId: sandboxProfile.id,
      feature,
      projectDir,
      saifDir,
      sandboxBaseDir,
      projectName,
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
