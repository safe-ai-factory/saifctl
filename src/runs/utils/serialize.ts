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
import { getGitProvider } from '../../git/index.js';
import type { GitProvider } from '../../git/types.js';
import type { ModelOverrides } from '../../llm-config.js';
import type { IterativeLoopOpts } from '../../orchestrator/loop.js';
import type { PatchExcludeRule } from '../../orchestrator/sandbox.js';
import { resolveTestProfile, type TestProfile } from '../../test-profiles/index.js';

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
  projectDir: string;
  maxRuns: number;
  overrides: ModelOverrides;
  saifDir: string;
  projectName: string;
  testImage: string;
  resolveAmbiguity: 'off' | 'prompt' | 'ai';
  dangerousDebug: boolean;
  dangerousNoLeash: boolean;
  cedarPolicyPath: string;
  coderImage: string;
  push: string | null;
  pr: boolean;
  targetBranch?: string | null;
  gitProviderId: string;
  gateRetries: number;
  agentEnv: Record<string, string>;
  agentLogFormat: 'openhands' | 'raw';
  testScript: string;
  testProfileId: string;
  testRetries: number;
  reviewerEnabled: boolean;
  includeDirty: boolean;
  patchExcludeStr?: SerializedPatchExcludeRule[];
  /**
   * Normalized staging environment — always present.
   * Contains `app` (with DEFAULT_STAGING_APP defaults), `appEnvironment`,
   * and the provisioner config (type, file/chart). Used to configure the staging
   * container and to instantiate the provisioner JIT when resuming a run.
   */
  stagingEnvironment: NormalizedStagingEnvironment;
  /**
   * Normalized coding environment — always present (defaults to `{ provisioner: 'docker' }`).
   * Persisted so that the coding provisioner stack can be re-used correctly on resume.
   */
  codingEnvironment: NormalizedCodingEnvironment;
  /** When true, verbose logs are enabled. */
  verbose?: boolean;
} & PersistedScriptBundle;

export function serializeArtifactConfig(
  opts: IterativeLoopOpts & PersistedScriptBundle,
): SerializedLoopOpts {
  // Ephemeral CLI mode — never persist (resume must run the full agent loop).
  const {
    feature,
    gitProvider,
    testProfile,
    patchExclude,
    testOnly: _testOnly,
    seedRunCommits: _seedRunCommits,
    seedRoundSummaries: _seedRoundSummaries,
    ...rest
  } = opts;
  return {
    ...rest,
    featureName: feature.name,
    gitProviderId: gitProvider.id,
    testProfileId: testProfile.id,
    patchExcludeStr: patchExclude?.map((rule) => ({
      type: rule.type,
      pattern: rule.type === 'regex' ? (rule.pattern as RegExp).source : (rule.pattern as string),
    })),
  };
}

/**
 * Converts SerializedLoopOpts back to the shape expected by runIterativeLoop.
 */
export function deserializeArtifactConfig(serialized: SerializedLoopOpts): Omit<
  SerializedLoopOpts,
  'gitProviderId' | 'testProfileId' | 'patchExcludeStr'
> & {
  gitProvider: GitProvider;
  testProfile: TestProfile;
  patchExclude?: PatchExcludeRule[];
} {
  const { gitProviderId, testProfileId, patchExcludeStr, ...rest } = serialized;
  return {
    ...rest,
    gitProvider: getGitProvider(gitProviderId),
    testProfile: resolveTestProfile(testProfileId),
    patchExclude: patchExcludeStr?.map((rule) =>
      rule.type === 'regex'
        ? { type: 'regex' as const, pattern: new RegExp(rule.pattern) }
        : { type: 'glob' as const, pattern: rule.pattern },
    ),
  };
}
