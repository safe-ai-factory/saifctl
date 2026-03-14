/**
 * Schema for saif/config.* file.
 *
 * All configurable options can be specified under `defaults`. CLI flags override
 * config defaults. Config uses richer formats where applicable (e.g. model overrides
 * as object instead of comma-separated strings).
 */

import { z } from 'zod';

import { isSupportedAgentName, SUPPORTED_AGENT_NAMES } from '../llm-config.js';
import { isSupportedStorageKey, SUPPORTED_STORAGE_KEYS } from '../storage/types.js';

export const saifConfigDefaultsSchema = z.object({
  // Run params
  maxRuns: z.number().int().positive().optional(),
  testRetries: z.number().int().positive().optional(),
  resolveAmbiguity: z.enum(['off', 'prompt', 'ai']).optional(),
  dangerousDebug: z.boolean().optional(),
  cedarPolicyPath: z.string().optional(),
  coderImage: z.string().optional(),
  gateRetries: z.number().int().positive().optional(),
  reviewerEnabled: z.boolean().optional(),
  agentLogFormat: z.enum(['openhands', 'raw']).optional(),
  push: z.string().optional(),
  pr: z.boolean().optional(),
  gitProvider: z.enum(['github', 'gitlab', 'bitbucket', 'azure', 'gitea']).optional(),
  // Agent env vars (object form)
  agentEnv: z.record(z.string(), z.string()).optional(),

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
  // NOTE: projectDir/saifDir are NOT in config - required to find the config file
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
  agentStartScript: z.string().optional(),
});

export const saifConfigSchema = z.object({
  defaults: saifConfigDefaultsSchema.optional(),
});

export type SaifConfig = z.infer<typeof saifConfigSchema>;
export type SaifConfigDefaults = z.infer<typeof saifConfigDefaultsSchema>;
