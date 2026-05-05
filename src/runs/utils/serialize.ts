/**
 * Serialization of IterativeLoopOpts for run storage.
 *
 * Converts non-JSON-serializable fields (gitProvider, testProfile, patchExclude RegExp)
 * to string/plain-object forms for persistence.
 */

import type { SupportedAgentProfileId } from '../../agent-profiles/types.js';
import type {
  NormalizedCodingEnvironment,
  NormalizedStagingEnvironment,
} from '../../config/schema.js';
import { DEFAULT_ORCHESTRATOR_MAX_RUNS } from '../../constants.js';
import { getGitProvider } from '../../git/index.js';
import type { GitProvider } from '../../git/types.js';
import type { LlmOverrides } from '../../llm-config.js';
import type { IterativeLoopOpts } from '../../orchestrator/loop.js';
import type { PatchExcludeRule } from '../../orchestrator/sandbox.js';
import { resolveTestProfile, type TestProfile } from '../../test-profiles/index.js';
import type { RunSubtaskInput } from '../types.js';

/** JSON-serializable form of patch exclude rules (RegExp -> pattern string) */
export interface SerializedPatchExcludeRule {
  type: 'glob' | 'regex';
  pattern: string;
}

/**
 * Script bodies plus reporting paths — required when serializing opts for run storage.
 * Execution uses the script strings; *File fields are for artifacts / tooling only.
 */
export interface PersistedScriptBundle {
  gateScript: string;
  startupScript: string;
  agentInstallScript: string;
  agentScript: string;
  stageScript: string;
  startupScriptFile: string;
  gateScriptFile: string;
  stageScriptFile: string;
  testScriptFile: string;
  agentInstallScriptFile: string;
  agentScriptFile: string;
}

/**
 * JSON-serializable form of IterativeLoopOpts plus script bundle.
 * Used as RunArtifact.config for persistence.
 */
export type SerializedLoopOpts = {
  sandboxProfileId: string;
  agentProfileId: SupportedAgentProfileId;
  featureName: string;
  /** Repo-relative path to the feature directory (e.g. saifctl/features/my-feat). */
  featureRelativePath: string;
  projectDir: string;
  /** Max outer attempts per subtask (formerly `maxRuns` on persisted artifacts). */
  maxAttemptsPerSubtask: number;
  /** Subtask definitions (single-task runs use one element). */
  subtasks: RunSubtaskInput[];
  /** Effective LLM config (models + base URLs) for this run. */
  llm: LlmOverrides;
  saifctlDir: string;
  projectName: string;
  testImage: string;
  resolveAmbiguity: 'off' | 'prompt' | 'ai';
  dangerousNoLeash: boolean;
  cedarPolicyPath: string;
  cedarScript: string;
  coderImage: string;
  push: string | null;
  pr: boolean;
  targetBranch?: string | null;
  gitProviderId: string;
  gateRetries: number;
  agentEnv: Record<string, string>;
  /** Host env var names only; values are re-read from `process.env` when starting from a Run. */
  agentSecretKeys: string[];
  /**
   * Project-relative secret file paths (`KEY=value` .env files). Re-read when starting from a Run; values are not
   * stored in the artifact.
   */
  agentSecretFiles?: string[];
  testScript: string;
  testProfileId: string;
  testRetries: number;
  reviewerEnabled: boolean;
  includeDirty: boolean;
  /** When true, saifctl/ paths are not stripped from run commit diffs (POC designer). */
  allowSaifctlInPatch?: boolean;
  /** When true, staging + tests are skipped (`saifctl sandbox` / POC designer). */
  skipStagingTests?: boolean;
  /** Host apply mode after sandbox agent when tests are skipped. */
  sandboxExtract?: 'none' | 'host-apply' | 'host-apply-filtered';
  sandboxExtractInclude?: string;
  sandboxExtractExclude?: string;
  patchExcludeStr?: SerializedPatchExcludeRule[];
  /**
   * Normalized staging environment — always present.
   * Contains `app` (with DEFAULT_STAGING_APP defaults), `appEnvironment`,
   * and the engine config (type, file/chart). Used to configure the staging
   * container and to instantiate the engine JIT when resuming a run.
   */
  stagingEnvironment: NormalizedStagingEnvironment;
  /**
   * Normalized coding environment — always present (defaults to `{ engine: 'docker' }`).
   * Persisted so that the coding engine stack can be re-used correctly when starting from a Run.
   */
  codingEnvironment: NormalizedCodingEnvironment;
  /** When true, verbose logs are enabled. */
  verbose?: boolean;
} & PersistedScriptBundle;

/** Serializes loop options for persistence: drops ephemeral fields, replaces non-JSON values (gitProvider/testProfile/RegExp patches) with stable id/string forms. */
export function serializeArtifactConfig(
  opts: IterativeLoopOpts & PersistedScriptBundle,
): SerializedLoopOpts {
  // Ephemeral CLI mode — never persist (`run start` must run the full agent loop).
  const {
    feature,
    gitProvider,
    testProfile,
    patchExclude,
    testOnly: _testOnly,
    seedRunCommits: _seedRunCommits,
    seedRoundSummaries: _seedRoundSummaries,
    maxRuns,
    subtasks: optSubtasks,
    ...rest
  } = opts;

  const subtasks: RunSubtaskInput[] =
    optSubtasks && optSubtasks.length > 0
      ? optSubtasks
      : [{ content: `Implement feature: ${feature.name}`, title: feature.name }];

  return {
    ...rest,
    featureName: feature.name,
    featureRelativePath: feature.relativePath,
    maxAttemptsPerSubtask: maxRuns,
    subtasks,
    gitProviderId: gitProvider.id,
    testProfileId: testProfile.id,
    patchExcludeStr: patchExclude?.map((rule) => ({
      type: rule.type,
      pattern: rule.type === 'regex' ? (rule.pattern as RegExp).source : (rule.pattern as string),
    })),
  };
}

/**
 * Converts SerializedLoopOpts (persisted config JSON) back to the shape
 * expected by runIterativeLoop.
 */
export type DeserializeArtifactConfigInput = SerializedLoopOpts & {
  maxRuns?: number;
};

/** Inverse of {@link serializeArtifactConfig}: rehydrates gitProvider/testProfile instances and `RegExp` patch rules from the persisted form. */
export function deserializeArtifactConfig(serialized: DeserializeArtifactConfigInput): Omit<
  SerializedLoopOpts,
  'gitProviderId' | 'testProfileId' | 'patchExcludeStr' | 'maxAttemptsPerSubtask' | 'subtasks'
> & {
  gitProvider: GitProvider;
  testProfile: TestProfile;
  patchExclude?: PatchExcludeRule[];
  /** Restored for {@link IterativeLoopOpts#maxRuns}. */
  maxRuns: number;
  subtasks: RunSubtaskInput[];
} {
  const maxRuns =
    typeof serialized.maxAttemptsPerSubtask === 'number'
      ? serialized.maxAttemptsPerSubtask
      : typeof serialized.maxRuns === 'number'
        ? serialized.maxRuns
        : DEFAULT_ORCHESTRATOR_MAX_RUNS;

  const featureName = String(serialized.featureName ?? '');
  const saifctlDir = String(serialized.saifctlDir ?? 'saifctl');
  const subtasks: RunSubtaskInput[] =
    Array.isArray(serialized.subtasks) && serialized.subtasks.length > 0
      ? serialized.subtasks
      : [
          {
            content: `Implement feature: ${featureName || 'run'}`,
            title: featureName || undefined,
          },
        ];

  const featureRelativePath =
    typeof serialized.featureRelativePath === 'string' && serialized.featureRelativePath.trim()
      ? serialized.featureRelativePath.trim()
      : `${saifctlDir}/features/${featureName}`;

  const {
    gitProviderId,
    testProfileId,
    patchExcludeStr,
    agentSecretFiles: _agentSecretFilesIn,
    llm,
    maxAttemptsPerSubtask: _m,
    maxRuns: _legacyMr,
    subtasks: _st,
    featureRelativePath: _frp,
    ...rest
  } = serialized;

  return {
    ...rest,
    featureRelativePath,
    llm,
    agentSecretKeys: serialized.agentSecretKeys ?? [],
    agentSecretFiles: serialized.agentSecretFiles ?? [],
    gitProvider: getGitProvider(gitProviderId),
    testProfile: resolveTestProfile(testProfileId),
    patchExclude: patchExcludeStr?.map((rule) =>
      rule.type === 'regex'
        ? { type: 'regex' as const, pattern: new RegExp(rule.pattern) }
        : { type: 'glob' as const, pattern: rule.pattern },
    ),
    maxRuns,
    subtasks,
  };
}
