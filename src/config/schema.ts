/**
 * Schema for saifctl/config.* file.
 *
 * All configurable options can be specified under `defaults`. CLI flags override
 * config defaults. Config uses richer formats where applicable (e.g. model overrides
 * as object instead of comma-separated strings).
 *
 * The `environments` block defines service topology for the coding and staging phases.
 * See docs/services.md (user guide) and docs/development/v0/swf-services.md (design).
 */

import { z } from 'zod';

import { isSupportedAgentName, SUPPORTED_AGENT_NAMES } from '../llm-config.js';
import { isSupportedStorageKey, SUPPORTED_STORAGE_KEYS } from '../storage/types.js';

/** Default staging app config. Applied when environments.staging.app is absent. */
export const DEFAULT_STAGING_APP = {
  sidecarPort: 8080,
  sidecarPath: '/exec',
} as const;

/** Staging app container config (sidecar port/path, optional base URL and custom Dockerfile). */
export const stagingAppSchema = z.object({
  sidecarPort: z.number().default(8080),
  sidecarPath: z.string().default('/exec'),
  /** Base URL of the web app. Omit for pure CLI projects. Use "staging" as hostname. */
  baseUrl: z.string().optional(),
  build: z
    .object({
      dockerfile: z.string().optional(),
    })
    .optional(),
});

/**
 * Docker engine — always the default runtime.
 * Optionally points at a Docker Compose file for ephemeral services (databases, queues, etc.).
 * When `file` is omitted, only the isolated bridge network and the core containers
 * (staging, test-runner, coder) are created — no Compose stack is started.
 */
export const dockerEnvironmentSchema = z.object({
  engine: z.literal('docker'),
  /** Path to a Docker Compose file (relative to the project root). Optional. */
  file: z.string().optional(),
  agentEnvironment: z.record(z.string(), z.string()).optional(),
});

/** Helm engine — points at a chart. */
const helmEnvironmentSchema = z.object({
  engine: z.literal('helm'),
  /** Helm chart path or reference; required at runtime when using Helm. */
  chart: z.string().optional(),
  namespacePrefix: z.string().optional(),
  agentEnvironment: z.record(z.string(), z.string()).optional(),
});

/** Local engine — agent runs on the host (coding only; staging must use docker or helm). */
const localEnvironmentSchema = z.object({
  engine: z.literal('local'),
  agentEnvironment: z.record(z.string(), z.string()).optional(),
});

/** Staging-specific fields (app config and appEnvironment) shared across all environment types. */
const stagingExtension = {
  app: stagingAppSchema.optional(),
  /**
   * Environment variables injected directly into the staging application container.
   * Use `environments.coding.agentEnvironment` for the agent (coding) container.
   */
  appEnvironment: z.record(z.string(), z.string()).optional(),
};

/** Environment block — discriminated by `engine`. */
const codingEnvironmentSchema = z.discriminatedUnion('engine', [
  dockerEnvironmentSchema,
  helmEnvironmentSchema,
  localEnvironmentSchema,
]);

const stagingEnvironmentSchema = z.discriminatedUnion('engine', [
  dockerEnvironmentSchema.extend(stagingExtension),
  helmEnvironmentSchema.extend(stagingExtension),
]);

const environmentsSchema = z.object({
  coding: codingEnvironmentSchema.optional(),
  staging: stagingEnvironmentSchema.optional(),
});

/** Inferred type of {@link stagingAppSchema}: staging app sidecar settings. */
export type StagingAppConfig = z.infer<typeof stagingAppSchema>;
/** Inferred type of {@link dockerEnvironmentSchema}: Docker engine config (always-supported runtime). */
export type DockerEnvironment = z.infer<typeof dockerEnvironmentSchema>;
/** Helm engine config — chart-pointing alternative to {@link DockerEnvironment}. */
export type HelmEnvironment = z.infer<typeof helmEnvironmentSchema>;
/** Local engine config — agent runs directly on the host (coding only). */
export type LocalEnvironment = z.infer<typeof localEnvironmentSchema>;
/** Inferred environments block: optional `coding` and `staging` discriminated by `engine`. */
export type EnvironmentsConfig = z.infer<typeof environmentsSchema>;

type RawStagingEnvironment = NonNullable<EnvironmentsConfig['staging']>;

/**
 * Normalized staging environment.
 * - Always present (defaults to `{ engine: 'docker' }` when omitted in config).
 * - `app` is always present (defaults to DEFAULT_STAGING_APP).
 * - `appEnvironment` is always present (defaults to `{}`).
 */
export type NormalizedStagingEnvironment = Omit<RawStagingEnvironment, 'app' | 'appEnvironment'> & {
  app: StagingAppConfig;
  appEnvironment: Record<string, string>;
};

/** Normalized coding environment — always present (defaults to `{ engine: 'docker' }` when omitted). */
export type NormalizedCodingEnvironment = NonNullable<EnvironmentsConfig['coding']>;

const saifctlConfigDefaultsSchema = z.object({
  // Run params
  maxRuns: z.number().int().positive().optional(),
  testRetries: z.number().int().positive().optional(),
  resolveAmbiguity: z.enum(['off', 'prompt', 'ai']).optional(),
  /** Skip Leash; run the coder image with `docker run` (same mounts/env as Leash, no Cedar/eBPF). */
  dangerousNoLeash: z.boolean().optional(),
  cedarPolicyPath: z.string().optional(),
  coderImage: z.string().optional(),
  gateRetries: z.number().int().positive().optional(),
  reviewerEnabled: z.boolean().optional(),
  /**
   * When true, the sandbox copy includes untracked and uncommitted files (rsync working tree).
   * When false (default), only files at `HEAD` are copied (`git archive`).
   */
  includeDirty: z.boolean().optional(),
  /**
   * Project-wide default for test mutability (Block 7 / §5.6). `true` (default)
   * means feature- and phase-level test directories are immutable unless an
   * explicit `tests.mutable: true` is declared. `false` flips the default to
   * mutable. `saifctl/tests/` is always immutable regardless. CLI flags
   * `--strict` / `--no-strict` override this per-run.
   */
  strict: z.boolean().optional(),
  push: z.string().optional(),
  pr: z.boolean().optional(),
  gitProvider: z.enum(['github', 'gitlab', 'bitbucket', 'azure', 'gitea']).optional(),
  // Agent env vars (object form)
  agentEnv: z.record(z.string(), z.string()).optional(),
  /** Env var names; values are read from the host process when starting the coder container. */
  agentSecretKeys: z.array(z.string()).optional(),

  // Model overrides (object form)
  globalModel: z.string().optional(),
  globalBaseUrl: z.string().optional(),
  agentModels: z
    .record(z.string(), z.string())
    .optional()
    .refine(
      (record) => record === undefined || Object.keys(record).every((k) => isSupportedAgentName(k)),
      {
        message: `agentModels keys must be one of: ${SUPPORTED_AGENT_NAMES.join(', ')}`,
      },
    ),
  agentBaseUrls: z
    .record(z.string(), z.string())
    .optional()
    .refine(
      (record) => record === undefined || Object.keys(record).every((k) => isSupportedAgentName(k)),
      {
        message: `agentBaseUrls keys must be one of: ${SUPPORTED_AGENT_NAMES.join(', ')}`,
      },
    ),

  // Storage (object form)
  globalStorage: z.string().optional(),
  storages: z
    .record(z.string(), z.string())
    .optional()
    .refine(
      (record) =>
        record === undefined || Object.keys(record).every((k) => isSupportedStorageKey(k)),
      {
        message: `storages keys must be one of: ${SUPPORTED_STORAGE_KEYS.join(', ')}`,
      },
    ),

  // Profile IDs
  testProfile: z.string().optional(),
  agentProfile: z.string().optional(),
  designerProfile: z.string().optional(),
  indexerProfile: z.string().optional(),
  sandboxProfile: z.string().optional(),

  // Paths and project
  // NOTE: projectDir/saifctlDir are NOT in config - required to find the config file
  project: z.string().optional(),
  sandboxBaseDir: z.string().optional(),

  // Discovery (context gathering before design-specs)
  discoveryMcps: z.record(z.string(), z.string()).optional(),
  discoveryTools: z.string().optional(),
  discoveryPrompt: z.string().optional(),
  discoveryPromptFile: z.string().optional(),

  // Script paths (overrides for profile defaults)
  testScript: z.string().optional(),
  testImage: z.string().optional(),
  startupScript: z.string().optional(),
  stageScript: z.string().optional(),
  gateScript: z.string().optional(),
  agentScript: z.string().optional(),
  agentInstallScript: z.string().optional(),
});

/** Top-level zod schema for `saifctl/config.*`: optional `defaults` and `environments` blocks. */
export const saifctlConfigSchema = z.object({
  defaults: saifctlConfigDefaultsSchema.optional(),
  environments: environmentsSchema.optional(),
});

/** Inferred type of {@link saifctlConfigSchema} — the parsed `saifctl/config.*` shape. */
export type SaifctlConfig = z.infer<typeof saifctlConfigSchema>;
/** Inferred type for the `defaults` block (CLI-flag defaults, profile ids, storage, model overrides, etc). */
export type SaifctlConfigDefaults = z.infer<typeof saifctlConfigDefaultsSchema>;
