/**
 * Serialization / deserialization of OrchestratorOpts for Hatchet workflow I/O.
 *
 * Hatchet requires all workflow inputs/outputs to be JSON-serializable (JsonObject).
 * OrchestratorOpts contains non-serializable values (gitProvider class instance,
 * testProfile class instance, patchExclude RegExp). This module converts to/from
 * plain objects that can cross the Hatchet wire protocol.
 *
 * The pattern mirrors `serializeArtifactConfig` / `deserializeArtifactConfig` in
 * src/runs/utils/serialize.ts but includes the extra OrchestratorOpts fields.
 */

import { getGitProvider } from '../../git/index.js';
import type { OrchestratorOpts } from '../../orchestrator/modes.js';
import type { PatchExcludeRule } from '../../orchestrator/sandbox.js';
import { createRunStorage } from '../../runs/storage.js';
import type { OuterAttemptSummary, RunCommit, RunRule } from '../../runs/types.js';
import type { SerializedPatchExcludeRule } from '../../runs/utils/serialize.js';
import { resolveTestProfile } from '../../test-profiles/index.js';

export interface SerializedOrchestratorOpts extends Record<string, unknown> {
  sandboxProfileId: string;
  agentProfileId: string;
  featureName: string;
  featureAbsolutePath: string;
  featureRelativePath: string;
  projectDir: string;
  maxRuns: number;
  overrides: Record<string, unknown>;
  saifDir: string;
  projectName: string;
  testImage: string;
  resolveAmbiguity: 'off' | 'prompt' | 'ai';
  dangerousDebug: boolean;
  dangerousNoLeash?: boolean;
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
  patchExcludeStr?: SerializedPatchExcludeRule[];
  stagingEnvironment: Record<string, unknown>;
  codingEnvironment: Record<string, unknown>;
  // OrchestratorOpts-specific
  sandboxBaseDir: string;
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
  resume: {
    sandboxSourceDir: string;
    baseSnapshotPath?: string;
    seedRunCommits?: RunCommit[];
    seedRoundSummaries?: OuterAttemptSummary[];
    initialErrorFeedback?: string;
    persistedRunId?: string;
    artifactRevisionAtResume?: number;
    runContext: {
      baseCommitSha: string;
      basePatchDiff?: string;
      lastErrorFeedback?: string;
      rules?: RunRule[];
    };
  } | null;
  /** URI passed to createRunStorage, or null when storage is disabled. */
  runStorageUri: string | null;
  /** When true, verbose logs are enabled. */
  verbose?: boolean;
  /** When true, sandbox includes uncommitted/untracked files. */
  includeDirty?: boolean;
}

export function serializeOrchestratorOpts(opts: OrchestratorOpts): SerializedOrchestratorOpts {
  const {
    feature,
    gitProvider,
    testProfile,
    patchExclude,
    runStorage: _rs,
    resume,
    ...rest
  } = opts;
  return {
    ...rest,
    featureName: feature.name,
    featureAbsolutePath: feature.absolutePath,
    featureRelativePath: feature.relativePath,
    gitProviderId: gitProvider.id,
    testProfileId: testProfile.id,
    patchExcludeStr: patchExclude?.map((rule) => ({
      type: rule.type,
      pattern: rule.type === 'regex' ? (rule.pattern as RegExp).source : (rule.pattern as string),
    })),
    resume: resume
      ? {
          sandboxSourceDir: resume.sandboxSourceDir,
          baseSnapshotPath: resume.baseSnapshotPath,
          seedRunCommits: resume.seedRunCommits,
          seedRoundSummaries: resume.seedRoundSummaries,
          initialErrorFeedback: resume.initialErrorFeedback,
          persistedRunId: resume.persistedRunId,
          artifactRevisionAtResume: resume.artifactRevisionAtResume,
          runContext: {
            baseCommitSha: resume.runContext.baseCommitSha,
            basePatchDiff: resume.runContext.basePatchDiff,
            lastErrorFeedback: resume.runContext.lastErrorFeedback,
            rules: resume.runContext.rules,
          },
        }
      : null,
    runStorageUri: opts.runStorage?.uri ?? null,
  } as unknown as SerializedOrchestratorOpts;
}

/**
 * Reconstruct OrchestratorOpts from the serialized form.
 * All fields are derived purely from the serialized wire data — no ambient
 * in-process object is needed, making this safe to call in a remote worker.
 */
export function deserializeOrchestratorOpts(serialized: Record<string, unknown>): OrchestratorOpts {
  const s = serialized as SerializedOrchestratorOpts;

  const patchExclude: PatchExcludeRule[] | undefined = s.patchExcludeStr?.map((rule) =>
    rule.type === 'regex'
      ? { type: 'regex' as const, pattern: new RegExp(rule.pattern) }
      : { type: 'glob' as const, pattern: rule.pattern },
  );

  return {
    sandboxProfileId: s.sandboxProfileId as OrchestratorOpts['sandboxProfileId'],
    agentProfileId: s.agentProfileId as OrchestratorOpts['agentProfileId'],
    feature: {
      name: s.featureName,
      absolutePath: s.featureAbsolutePath,
      relativePath: s.featureRelativePath,
    },
    projectDir: s.projectDir,
    maxRuns: s.maxRuns,
    overrides: s.overrides as OrchestratorOpts['overrides'],
    saifDir: s.saifDir,
    projectName: s.projectName,
    testImage: s.testImage,
    resolveAmbiguity: s.resolveAmbiguity,
    dangerousDebug: s.dangerousDebug,
    dangerousNoLeash: s.dangerousNoLeash ?? false,
    cedarPolicyPath: s.cedarPolicyPath,
    coderImage: s.coderImage,
    push: s.push,
    pr: s.pr,
    targetBranch: s.targetBranch ?? null,
    gitProvider: getGitProvider(s.gitProviderId),
    gateRetries: s.gateRetries,
    agentEnv: s.agentEnv,
    agentLogFormat: s.agentLogFormat,
    testScript: s.testScript,
    testProfile: resolveTestProfile(s.testProfileId),
    testRetries: s.testRetries,
    reviewerEnabled: s.reviewerEnabled,
    patchExclude,
    stagingEnvironment: s.stagingEnvironment as OrchestratorOpts['stagingEnvironment'],
    codingEnvironment: s.codingEnvironment as OrchestratorOpts['codingEnvironment'],
    sandboxBaseDir: s.sandboxBaseDir,
    gateScript: s.gateScript,
    startupScript: s.startupScript,
    agentInstallScript: s.agentInstallScript,
    agentScript: s.agentScript,
    stageScript: s.stageScript,
    startupScriptFile: s.startupScriptFile,
    gateScriptFile: s.gateScriptFile,
    stageScriptFile: s.stageScriptFile,
    testScriptFile: s.testScriptFile,
    agentInstallScriptFile: s.agentInstallScriptFile,
    agentScriptFile: s.agentScriptFile,
    resume: s.resume
      ? {
          sandboxSourceDir: s.resume.sandboxSourceDir,
          baseSnapshotPath: s.resume.baseSnapshotPath,
          seedRunCommits: s.resume.seedRunCommits ?? [],
          seedRoundSummaries: s.resume.seedRoundSummaries,
          initialErrorFeedback: s.resume.initialErrorFeedback,
          persistedRunId: s.resume.persistedRunId,
          artifactRevisionAtResume: s.resume.artifactRevisionAtResume,
          runContext: {
            ...s.resume.runContext,
            rules: s.resume.runContext.rules ?? [],
          },
        }
      : null,
    runStorage: s.runStorageUri ? createRunStorage(s.runStorageUri, s.projectDir) : null,
    verbose: !!s.verbose,
    includeDirty: s.includeDirty ?? false,
  };
}
