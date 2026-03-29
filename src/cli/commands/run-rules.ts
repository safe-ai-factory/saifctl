#!/usr/bin/env tsx
/**
 * Run rules CLI — user feedback rules stored on the run artifact (`saifctl run rules …`).
 */

import { defineCommand } from 'citty';

import { loadSaifctlConfig } from '../../config/load.js';
import { consola, outputCliData } from '../../logger.js';
import {
  createRunRule,
  getRunRule,
  patchRunRule,
  removeRunRuleById,
  rulesForPrompt,
} from '../../runs/rules.js';
import {
  type RunArtifact,
  type RunRule,
  type RunRuleScope,
  StaleArtifactError,
} from '../../runs/types.js';
import { readUtf8 } from '../../utils/io.js';
import { projectDirArg, saifctlDirArg, storageArg } from '../args.js';
import {
  parseRunId,
  readProjectDirFromCli,
  readSaifctlDirFromCli,
  readStorageStringFromCli,
  resolveCliProjectDir,
  resolveRunStorage,
  resolveSaifctlDirRelative,
} from '../utils.js';

type ContentCliArgs = {
  content?: string;
  'content-file'?: string;
};

function trimContentFilePath(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t === '' ? undefined : t;
}

type ResolveContentExclusiveOpts = { required: true } | { required: false };

/** At most one of --content or --content-file. When `required`, exactly one must be present. */
async function resolveContentExclusive(
  args: ContentCliArgs,
  options: { required: true },
): Promise<string>;
async function resolveContentExclusive(
  args: ContentCliArgs,
  options: { required: false },
): Promise<string | undefined>;
async function resolveContentExclusive(
  args: ContentCliArgs,
  options: ResolveContentExclusiveOpts,
): Promise<string | undefined> {
  const filePath = trimContentFilePath(args['content-file']);
  const hasInline = args.content !== undefined;
  const inline = typeof args.content === 'string' ? args.content.trim() : '';

  if (filePath != null && hasInline) {
    consola.error('Use either --content or --content-file, not both.');
    process.exit(1);
  }

  if (filePath != null) {
    try {
      const text = (await readUtf8(filePath)).trim();
      if (!text) {
        consola.error(`File ${filePath} is empty or whitespace-only.`);
        process.exit(1);
      }
      return text;
    } catch (e) {
      consola.error(
        `Could not read --content-file ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    }
  }

  if (hasInline) {
    if (!inline) {
      consola.error(
        options.required ? '--content cannot be empty.' : '--content cannot be empty when set.',
      );
      process.exit(1);
    }
    return inline;
  }

  if (options.required) {
    consola.error('Provide --content or --content-file.');
    process.exit(1);
  }
  return undefined;
}

const commonRunArgs = {
  'project-dir': projectDirArg,
  'saifctl-dir': saifctlDirArg,
  storage: storageArg,
};

/** Shared CLI shape for `run rules` subcommands (storage + optional content flags). */
type RunRulesCliArgs = {
  runId: string;
  'project-dir'?: string;
  'saifctl-dir'?: string;
  storage?: string;
} & ContentCliArgs;

function parseScope(raw: string | undefined, fallback: RunRuleScope): RunRuleScope {
  if (raw === 'once' || raw === 'always') return raw;
  if (raw === undefined) return fallback;
  consola.error(`Invalid scope "${raw}" (expected once or always).`);
  process.exit(1);
}

async function withRunArtifact(
  args: RunRulesCliArgs,
  fn: (artifact: RunArtifact, save: (nextRules: RunRule[]) => Promise<void>) => Promise<void>,
): Promise<void> {
  const projectDir = resolveCliProjectDir(readProjectDirFromCli(args));
  const saifctlDir = resolveSaifctlDirRelative(readSaifctlDirFromCli(args));
  const config = await loadSaifctlConfig(saifctlDir, projectDir);
  const storage = resolveRunStorage(readStorageStringFromCli(args), projectDir, config);
  if (!storage) {
    consola.error('Run storage is disabled (--storage none).');
    process.exit(1);
  }
  const runId = parseRunId(args);
  const artifact = await storage.getRun(runId);
  if (!artifact) {
    consola.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  const save = async (nextRules: RunRule[]) => {
    const expectedRev = artifact.artifactRevision ?? 0;
    const updated: RunArtifact = {
      ...artifact,
      rules: nextRules,
      updatedAt: new Date().toISOString(),
    };
    try {
      await storage.saveRun(runId, updated, { ifRevisionEquals: expectedRev });
    } catch (e) {
      if (e instanceof StaleArtifactError) {
        consola.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  };

  await fn(artifact, save);
}

const rulesCreateCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Append a user rule to a stored run',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID',
      required: true,
    },
    content: {
      type: 'string' as const,
      description: 'Rule text shown to the agent (mutually exclusive with --content-file)',
    },
    'content-file': {
      type: 'string' as const,
      description: 'Rule text shown to the agent (as file path; mutually exclusive with --content)',
    },
    scope: {
      type: 'string' as const,
      description: 'once (next coding round only) or always (default: once)',
    },
  },
  async run({ args }) {
    const scope = parseScope(args.scope, 'once');
    const content = await resolveContentExclusive(args, { required: true });
    await withRunArtifact(args, async (artifact, save) => {
      const prev = artifact.rules;
      const next = [...prev, createRunRule(content, scope)];
      await save(next);
      const created = next[next.length - 1]!;
      consola.log(`Created rule ${created.id} on run ${artifact.runId} (${created.scope}).`);
    });
  },
});

const rulesRemoveCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a rule from a stored run',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID',
      required: true,
    },
    ruleId: {
      type: 'positional' as const,
      description: 'Rule id',
      required: true,
    },
  },
  async run({ args }) {
    await withRunArtifact(args, async (artifact, save) => {
      const prev = artifact.rules;
      try {
        const next = removeRunRuleById(prev, args.ruleId);
        await save(next);
        consola.log(`Removed rule ${args.ruleId} from run ${artifact.runId}.`);
      } catch (e) {
        consola.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });
  },
});

const rulesListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all rules for a run (table)',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID',
      required: true,
    },
  },
  async run({ args }) {
    await withRunArtifact(args as RunRulesCliArgs, async (artifact) => {
      const rules = artifact.rules ?? [];
      if (rules.length === 0) {
        outputCliData('No rules on this run.');
        return;
      }
      const active = rulesForPrompt(rules);
      const hId = 'ID';
      const hScope = 'SCOPE';
      const hConsumed = 'CONSUMED';
      const hContent = 'CONTENT';
      const wId = Math.max(hId.length, ...rules.map((r) => r.id.length));
      const wScope = Math.max(hScope.length, ...rules.map((r) => r.scope.length));
      const consumedStr = (r: (typeof rules)[number]) => (r.consumedAt ? 'yes' : 'no');
      const wConsumed = Math.max(hConsumed.length, ...rules.map((r) => consumedStr(r).length));
      const preview = (r: (typeof rules)[number]) => {
        const line = r.content.replace(/\s+/g, ' ').trim();
        return line.length > 64 ? `${line.slice(0, 61)}...` : line;
      };
      const wContent = Math.max(hContent.length, ...rules.map((r) => preview(r).length));
      /* eslint-disable-next-line max-params -- table row layout */
      const row = (a: string, b: string, c: string, d: string) =>
        `  ${a.padEnd(wId)}  ${b.padEnd(wScope)}  ${c.padEnd(wConsumed)}  ${d.padEnd(wContent)}`;
      outputCliData(`${rules.length} rule(s) (${active.length} active in next prompt):\n`);
      outputCliData(row(hId, hScope, hConsumed, hContent));
      for (const r of rules.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        outputCliData(row(r.id, r.scope, consumedStr(r), preview(r)));
      }
    });
  },
});

const rulesGetCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Print a single rule as JSON',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID',
      required: true,
    },
    ruleId: {
      type: 'positional' as const,
      description: 'Rule id',
      required: true,
    },
    pretty: {
      type: 'boolean' as const,
      default: true,
      description: 'Pretty-print JSON (default: true)',
    },
  },
  async run({ args }) {
    await withRunArtifact(args as RunRulesCliArgs, async (artifact) => {
      const rules = artifact.rules ?? [];
      const rid = (args.ruleId as string).trim();
      const one = getRunRule(rules, rid);
      if (!one) {
        consola.error(`Rule not found: ${rid}`);
        process.exit(1);
      }
      const pretty = args.pretty !== false;
      outputCliData(JSON.stringify(one, null, pretty ? 2 : undefined));
    });
  },
});

const rulesUpdateCommand = defineCommand({
  meta: {
    name: 'update',
    description: 'Update a rule (content and/or scope)',
  },
  args: {
    ...commonRunArgs,
    runId: {
      type: 'positional' as const,
      description: 'Run ID',
      required: true,
    },
    ruleId: {
      type: 'positional' as const,
      description: 'Rule id',
      required: true,
    },
    content: {
      type: 'string' as const,
      description: 'New rule text (mutually exclusive with --content-file)',
    },
    'content-file': {
      type: 'string' as const,
      description: 'Rule text shown to the agent (as file path; mutually exclusive with --content)',
    },
    scope: {
      type: 'string' as const,
      description: 'once or always',
    },
  },
  async run({ args }) {
    const contentPatch = await resolveContentExclusive(args, { required: false });
    const hasScope = typeof args.scope === 'string';
    if (contentPatch === undefined && !hasScope) {
      consola.error('Provide --content, --content-file, and/or --scope to update.');
      process.exit(1);
    }
    const scopePatch = hasScope ? parseScope(args.scope as string, 'once') : undefined;
    await withRunArtifact(args, async (artifact, save) => {
      const prev = artifact.rules ?? [];
      try {
        const next = patchRunRule(prev, {
          id: args.ruleId as string,
          ...(contentPatch !== undefined ? { content: contentPatch } : {}),
          ...(scopePatch !== undefined ? { scope: scopePatch } : {}),
        });
        await save(next);
        consola.log(`Updated rule ${args.ruleId} on run ${artifact.runId}.`);
      } catch (e) {
        consola.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });
  },
});

/** `run rules` — kubectl-style subcommands for run-scoped user rules. */
export const runRulesCommand = defineCommand({
  meta: {
    name: 'rules',
    description: 'Create, list, get, update, or remove user feedback rules on a stored run',
  },
  subCommands: {
    create: rulesCreateCommand,
    remove: rulesRemoveCommand,
    rm: rulesRemoveCommand,
    update: rulesUpdateCommand,
    get: rulesGetCommand,
    list: rulesListCommand,
    ls: rulesListCommand,
  },
});
