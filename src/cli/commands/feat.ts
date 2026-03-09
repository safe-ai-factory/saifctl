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

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cancel, confirm, intro, isCancel, outro, text } from '@clack/prompts';
import { defineCommand, runMain } from 'citty';

import {
  DEFAULT_AGENT_PROFILE,
  resolveAgentScriptPath,
  resolveAgentStartScriptPath,
} from '../../agent-profiles/index.js';
import { getChangeDirAbsolute, getChangeDirRelative } from '../../constants.js';
import { runDesignTests } from '../../design-tests/design.js';
import { generateTests } from '../../design-tests/write.js';
import { DEFAULT_DESIGNER_PROFILE } from '../../designer-profiles/index.js';
import { DEFAULT_INDEXER_PROFILE } from '../../indexer-profiles/index.js';
import type { ModelOverrides } from '../../llm-config.js';
import { runDebug, runFail2Pass, runStart } from '../../orchestrator/modes.js';
import { DEFAULT_SANDBOX_BASE_DIR } from '../../orchestrator/sandbox.js';
import { readSandboxGateScript } from '../../sandbox-profiles/index.js';
import {
  type FeatRunArgs,
  getFeatNameFromArgs,
  getFeatNameOrPrompt,
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
  parseOpenspecDir,
  parsePr,
  parseProjectDir,
  parsePush,
  parseResolveAmbiguity,
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
const nameArg = {
  type: 'string' as const,
  alias: 'n' as const,
  description: 'Feature name (kebab-case). Prompts with a list if omitted.',
};
const yesArg = {
  type: 'boolean' as const,
  alias: 'y' as const,
  description:
    'Non-interactive mode. Requires --name/-n. Omits description prompt (defaults to empty).',
};
const openspecDirArg = {
  type: 'string' as const,
  description: 'Path to openspec directory (default: openspec)',
};
const projectDirArg = {
  type: 'string' as const,
  description: 'Project directory (default: process.cwd())',
};
const designerArg = {
  type: 'string' as const,
  description: `Designer profile for spec generation (default: ${DEFAULT_DESIGNER_PROFILE.id}).`,
};
const indexerArg = {
  type: 'string' as const,
  description: `Indexer profile for codebase search (default: ${DEFAULT_INDEXER_PROFILE.id}). Pass 'none' to disable.`,
};
const projectArg = {
  type: 'string' as const,
  alias: 'p',
  description: 'Project name override for the indexer (default: package.json "name")',
};
const forceArg = {
  type: 'boolean' as const,
  alias: 'f' as const,
  description: null,
};
const sandboxBaseDirArg = {
  type: 'string' as const,
  description: `Base directory for sandbox entries (default: ${DEFAULT_SANDBOX_BASE_DIR})`,
};
const profileArg = {
  type: 'string' as const,
  description:
    'Sandbox profile for the project. Sets defaults for startup-script and stage-script.',
};
const startupScriptArg = {
  type: 'string' as const,
  description:
    'Path to a shell script run once to install workspace deps (pnpm install, pip install, etc.).',
};
const stageScriptArg = {
  type: 'string' as const,
  description:
    'Path to a shell script mounted into the staging container. Must handle app startup.',
};
const testProfileArg = {
  type: 'string' as const,
  description: 'Test profile id (default: node-vitest).',
};
const testScriptArg = {
  type: 'string' as const,
  description: 'Path to a shell script that overrides test.sh inside the Test Runner container.',
};
const testImageArg = {
  type: 'string' as const,
  description: 'Test runner Docker image tag (default: factory-test-<profile>:latest).',
};

// Tests-only args — used by design-fail2pass, test (staging + test runner, no coder agent)
const featTestsArgs = {
  'sandbox-base-dir': sandboxBaseDirArg,
  profile: profileArg,
  'test-script': testScriptArg,
  'test-image': testImageArg,
  'startup-script': startupScriptArg,
  'stage-script': stageScriptArg,
};

// Agent args — used by run, continue (coder container). NOT used by design-fail2pass.
const featAgentArgs = {
  'gate-script': {
    type: 'string' as const,
    description:
      'Path to a shell script run inside the Leash container after each round. Defaults to profile gate.',
  },
  agent: {
    type: 'string' as const,
    description: 'Agent profile (default: openhands). Used for gate script resolution.',
  },
  'agent-script': {
    type: 'string' as const,
    description: 'Path to the coding agent script. Overrides profile default.',
  },
  'agent-start-script': {
    type: 'string' as const,
    description: 'Path to the agent startup script. Overrides profile default.',
  },
};

// Full orchestrator args — featTestsArgs + featAgentArgs. Used by run, continue when migrated.
export const featOrchestratorArgs = {
  ...featTestsArgs,
  ...featAgentArgs,
};

// Run-specific args (feat run)
const featRunExtraArgs = {
  'max-runs': {
    type: 'string' as const,
    description: 'Max full pipeline runs before giving up (default: 5).',
  },
  'keep-sandbox': {
    type: 'boolean' as const,
    description: 'Preserve sandbox dir on failure for later resume.',
  },
  'test-retries': {
    type: 'string' as const,
    description: 'How many times to retry when the tests fail (default: 1).',
  },
  'resolve-ambiguity': {
    type: 'string' as const,
    description:
      'How to handle test failures caused by ambiguous specs failures. "ai" (use AI for clarification) | "prompt" (ask human for clarification) | "off" (all failures treated as genuine) (default: ai).',
  },
  'dangerous-debug': {
    type: 'boolean' as const,
    description:
      'Skip Leash; run OpenHands directly on the host. Use only for development/debugging.',
  },
  cedar: {
    type: 'string' as const,
    description: 'Absolute path to Cedar policy file for Leash (default: leash-policy.cedar).',
  },
  'coder-image': {
    type: 'string' as const,
    description: 'Docker image for the coder container (default: from --profile).',
  },
  'gate-retries': {
    type: 'string' as const,
    description: 'Max gate retries per run (default: 10).',
  },
  env: {
    type: 'string' as const,
    description: 'Extra env var for the agent container. Format: KEY=VALUE. Repeatable.',
  },
  'env-file': {
    type: 'string' as const,
    description: 'Path to .env file with extra env vars for the agent container.',
  },
  'agent-log-format': {
    type: 'string' as const,
    description: 'How to parse agent stdout. openhands | raw (default: from agent profile).',
  },
  push: {
    type: 'string' as const,
    description:
      'Push feature branch after success. Accepts Git URL, slug (owner/repo), or remote name.',
  },
  pr: {
    type: 'boolean' as const,
    description: 'Open a Pull Request after pushing. Requires --push and provider token env var.',
  },
  'git-provider': {
    type: 'string' as const,
    description:
      'Git hosting provider for push/PR. github | gitlab | bitbucket | azure | gitea (default: github).',
  },
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
      ...nameArg,
      description: 'Feature name (kebab-case, e.g. add-greeting-cmd)',
    },
    yes: yesArg,
    'openspec-dir': openspecDirArg,
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
  'openspec-dir': openspecDirArg,
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
  name: nameArg,
  'openspec-dir': openspecDirArg,
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

// ---------------------------------------------------------------------------
// design-fail2pass: Fail2Pass verification
// ---------------------------------------------------------------------------

const designFail2passArgs = {
  name: nameArg,
  'openspec-dir': openspecDirArg,
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
  featName: string;
  projectDir: string;
  openspecDir: string;
  args: DesignFail2passArgs;
}): Promise<void> {
  const { featName, projectDir, openspecDir, args } = opts;
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

  console.log(`\nFail2Pass verification: ${featName}`);
  const result = await runFail2Pass({
    sandboxProfileId: sandboxProfile.id,
    changeName: featName,
    projectDir,
    openspecDir,
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
    const featName = await getFeatNameOrPrompt(args, projectDir);
    const openspecDir = parseOpenspecDir(args);
    await _runDesignFail2pass({
      featName,
      projectDir,
      openspecDir,
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
    const { featName, projectDir, openspecDir, overrides } = await _runDesignSpecs(args);
    // 2. Generate tests
    await _runDesignTests({
      featName,
      projectDir,
      openspecDir,
      skipCatalog: false,
      force: !!args.force,
      overrides,
      args,
    });
    // 3. Verify tests (expect them to fail)
    await _runDesignFail2pass({
      featName,
      projectDir,
      openspecDir,
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
  'openspec-dir': openspecDirArg,
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

const featRunArgs = {
  name: nameArg,
  'openspec-dir': openspecDirArg,
  'project-dir': projectDirArg,
  project: projectArg,
  'test-profile': testProfileArg,
  ...featOrchestratorArgs,
  ...featRunExtraArgs,
  ...modelOverrideArgs,
};

const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Start an agent to implement the specs. Runs until it passes your tests',
  },
  args: featRunArgs,
  async run({ args }) {
    const projectDir = parseProjectDir(args);
    const featName = await getFeatNameOrPrompt(args, projectDir);
    const runArgs = args as FeatRunArgs;

    const maxRuns = parseMaxRuns(runArgs);
    const keepSandbox = runArgs['keep-sandbox'] === true;
    const overrides = parseModelOverrides(args);
    const openspecDir = parseOpenspecDir(args);
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

    console.log(`\nStarting iterative loop: ${featName}`);
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
    if (keepSandbox) console.log('  Sandbox will be preserved on failure');
    if (push) console.log(`  Push: ${push}${pr ? ` (+ PR via ${gitProvider.id})` : ''}`);

    const result = await runStart({
      sandboxProfileId: sandboxProfile.id,
      changeName: featName,
      projectDir,
      maxRuns,
      keepSandbox,
      overrides,
      openspecDir,
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
      patchPath: null,
      sandboxPath: null,
    });

    console.log(`\n${result.message}`);
    if (result.sandboxPath) {
      console.log(`\nResume with:`);
      console.log(`  pnpm saif feat continue --sandbox-path ${result.sandboxPath} -n ${featName}`);
    }
    if (!result.success) process.exit(1);
  },
});

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
    const featName = await getFeatNameOrPrompt(args, projectDir);
    const openspecDir = parseOpenspecDir(args);
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

    console.log(`\nDebug staging container: ${featName}`);
    console.log('  Ctrl+C to stop and clean up.\n');

    await runDebug({
      sandboxProfileId: sandboxProfile.id,
      changeName: featName,
      projectDir,
      openspecDir,
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
