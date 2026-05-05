/**
 * POC designer profile.
 *
 * Runs a full containerised agent Run — labelled `<feat>-poc` — whose goal is to
 * explore the feature through a quick-and-dirty proof-of-concept implementation.
 * The agent may write anywhere under `saifctl/features/` (primary outputs go under
 * `saifctl/features/<feat>/`).
 *
 * Delegates entirely to {@link runSandbox} with `host-apply-filtered` extract mode
 * so the orchestrator copies only the real feature's changes back to the host.
 */

import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSaifctlConfig } from '../../config/load.js';
import { getSaifctlRoot } from '../../constants.js';
import { consola } from '../../logger.js';
import type { OrchestratorCliInput } from '../../orchestrator/options.js';
import { runSandbox } from '../../orchestrator/sandbox-run.js';
import type { Feature } from '../../specs/discover.js';
import { pathExists, readUtf8 } from '../../utils/io.js';
import type { DesignerBaseOpts, DesignerProfile, DesignerRunOpts } from '../types.js';
import { buildPocTask } from './task.js';

const POC_SUFFIX = '-poc';

/** Output files required in the REAL feature dir for hasRun() to return true. */
const REQUIRED_OUTPUT_FILES = ['specification.md', 'plan.md'] as const;

/**
 * Designer profile for the proof-of-concept (PoC) workflow.
 * Runs a containerised exploration agent that lands `specification.md` + `plan.md`
 * for the feature; used as the default when no `--designer` flag or config is set.
 */
export const pocDesignerProfile: DesignerProfile = {
  id: 'poc',
  displayName: 'POC Explorer',

  async hasRun({ feature }: DesignerBaseOpts): Promise<boolean> {
    for (const f of REQUIRED_OUTPUT_FILES) {
      if (!(await pathExists(join(feature.absolutePath, f)))) return false;
    }
    return true;
  },

  async run({ cwd, feature, saifctlDir, model, prompt }: DesignerRunOpts): Promise<void> {
    const projectDir = cwd;
    const realFeatName = feature.name;
    const pocFeatName = `${realFeatName}${POC_SUFFIX}`;

    const pocTask = await buildPocTask({
      targetFeatureName: realFeatName,
      targetFeatureAbsolutePath: feature.absolutePath,
      saifctlDir,
      pocFeatureName: pocFeatName,
      prompt,
    });

    const pocTmpDir = join(tmpdir(), `saifctl-poc-${pocFeatName}`);
    await mkdir(pocTmpDir, { recursive: true });

    const pocFeature: Feature = {
      name: pocFeatName,
      absolutePath: pocTmpDir,
      relativePath: `(sandbox)/${pocFeatName}`,
    };

    const config = await loadSaifctlConfig(saifctlDir, projectDir);
    const cliOverrides = await buildPocCliOverrides();

    consola.log(`\n[poc-designer] Starting POC run for feature: ${realFeatName}`);
    consola.log(`[poc-designer] POC run name: ${pocFeatName}`);

    const result = await runSandbox({
      projectDir,
      saifctlDir,
      config,
      feature: pocFeature,
      cli: cliOverrides,
      cliModelDelta: model ? { globalModel: model } : undefined,
      task: pocTask,
      extract: 'host-apply-filtered',
      extractInclude: `${saifctlDir}/features/`,
      extractExclude: `${saifctlDir}/features/${pocFeatName}/`,
    });

    consola.log(`\n[poc-designer] POC run finished (status: ${result.status})`);
  },
};

async function buildPocCliOverrides(): Promise<OrchestratorCliInput> {
  const saifctlRoot = getSaifctlRoot();
  const pocCedarPolicyPath = join(saifctlRoot, 'src', 'orchestrator', 'policies', 'sandbox.cedar');
  const pocGateScriptPath = join(saifctlRoot, 'src', 'orchestrator', 'scripts', 'sandbox-gate.sh');

  const gateScript = await readUtf8(pocGateScriptPath);

  return {
    cedarPolicyPath: pocCedarPolicyPath,
    cedarScript: undefined,
    gateScript,
    gateScriptFile: pocGateScriptPath,
    reviewerEnabled: false,
    maxRuns: 1,
    allowSaifctlInPatch: true,
    sandboxProfileId: undefined,
    agentProfileId: undefined,
    feature: undefined,
    projectDir: undefined,
    saifctlDir: undefined,
    sandboxBaseDir: undefined,
    projectName: undefined,
    testImage: undefined,
    resolveAmbiguity: undefined,
    testRetries: undefined,
    dangerousNoLeash: undefined,
    coderImage: undefined,
    startupScript: undefined,
    startupScriptFile: undefined,
    agentInstallScript: undefined,
    agentInstallScriptFile: undefined,
    agentScript: undefined,
    agentScriptFile: undefined,
    stageScript: undefined,
    stageScriptFile: undefined,
    testScript: undefined,
    testScriptFile: undefined,
    testProfile: undefined,
    agentEnv: undefined,
    agentSecretKeys: undefined,
    agentSecretFiles: undefined,
    gateRetries: undefined,
    includeDirty: undefined,
    strict: undefined,
    push: undefined,
    pr: undefined,
    targetBranch: undefined,
    gitProvider: undefined,
    runStorage: undefined,
    stagingEnvironment: undefined,
    codingEnvironment: undefined,
    patchExclude: undefined,
    fromArtifact: undefined,
    verbose: undefined,
    llm: undefined,
    subtasks: undefined,
    currentSubtaskIndex: undefined,
    enableSubtaskSequence: undefined,
    subtasksFilePath: undefined,
    skipStagingTests: undefined,
    sandboxExtract: undefined,
    sandboxExtractInclude: undefined,
    sandboxExtractExclude: undefined,
  };
}
