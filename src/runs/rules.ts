/**
 * Helpers for {@link RunRule} — prompt selection and lifecycle (once-rule consumption),
 * storage polling for live user rules, and pending-task formatting.
 */

import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { consola } from '../logger.js';
import { writeUtf8 } from '../utils/io.js';
import type { RunStorage } from './storage.js';
import type { RunRule, RunRuleScope } from './types.js';

/**
 * Host path for human feedback queued by the orchestrator between inner rounds.
 * Same `.saifctl/` directory as the inner-round stats file (`stats.jsonl`) under the workspace
 * — consumed by `coder-start.sh`.
 */
export function pendingRulesPath(sandboxBasePath: string): string {
  return join(sandboxBasePath, 'code', '.saifctl', 'pending-rules.md');
}

/** Clears the pending-rules file before each outer coding attempt. */
export async function preparePendingRulesFile(sandboxBasePath: string): Promise<void> {
  const p = pendingRulesPath(sandboxBasePath);
  await mkdir(dirname(p), { recursive: true });
  await writeUtf8(p, '');
}

/** Short stable id: 6 lowercase hex characters (3 random bytes). */
export function newRunRuleId(): string {
  return randomBytes(3).toString('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Rules that belong in the agent task: `always` every round; `once` only until consumed.
 * Sorted by {@link RunRule#createdAt} (chronological).
 */
export function rulesForPrompt(rules: readonly RunRule[] | undefined): RunRule[] {
  if (rules == null || rules.length === 0) return [];
  const active = rules.filter(
    (r) => r.scope === 'always' || (r.scope === 'once' && r.consumedAt == null),
  );
  return active.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * IDs of `once` rules that are currently active (would appear in the prompt).
 */
export function activeOnceRuleIds(rules: readonly RunRule[]): string[] {
  return rules.filter((r) => r.scope === 'once' && r.consumedAt == null).map((r) => r.id);
}

/** After a coding round, mark the given once-rules as consumed (mutates `rules` in place). */
export function markOnceRulesConsumed(rules: RunRule[], onceIds: readonly string[]): void {
  if (onceIds.length === 0) return;
  const idSet = new Set(onceIds);
  const t = nowIso();
  for (const r of rules) {
    if (idSet.has(r.id) && r.scope === 'once' && r.consumedAt == null) {
      r.consumedAt = t;
      r.updatedAt = t;
    }
  }
}

export function createRunRule(content: string, scope: RunRuleScope): RunRule {
  const t = nowIso();
  return {
    id: newRunRuleId(),
    content,
    scope,
    createdAt: t,
    updatedAt: t,
  };
}

export function removeRunRuleById(rules: RunRule[], ruleId: string): RunRule[] {
  const next = rules.filter((r) => r.id !== ruleId);
  if (next.length === rules.length) {
    throw new Error(`Rule not found: ${ruleId}`);
  }
  return next;
}

export function patchRunRule(
  rules: RunRule[],
  opts: { id: string; content?: string; scope?: RunRuleScope },
): RunRule[] {
  const { id: ruleId, content, scope } = opts;
  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx < 0) {
    throw new Error(`Rule not found: ${ruleId}`);
  }
  const t = nowIso();
  const cur = rules[idx]!;
  const next: RunRule = {
    ...cur,
    ...(content !== undefined ? { content } : {}),
    ...(scope !== undefined ? { scope } : {}),
    updatedAt: t,
  };
  const copy = rules.slice();
  copy[idx] = next;
  return copy;
}

export function getRunRule(rules: readonly RunRule[], ruleId: string): RunRule | undefined {
  return rules.find((r) => r.id === ruleId);
}

/** Deep copy rules (e.g. fork). */
export function cloneRunRules(rules: readonly RunRule[] | undefined): RunRule[] {
  if (rules == null || rules.length === 0) return [];
  return rules.map((r) => ({ ...r }));
}

/**
 * Reconciles in-memory rules with a full list from storage (e.g. at the start of an outer attempt).
 *
 * **Storage is authoritative** for every rule ID present in {@link fromStorage} (content, scope,
 * `consumedAt`). The orchestrator persists `consumedAt` to storage immediately after marking
 * once-rules consumed, so storage is never stale relative to in-memory for that field.
 *
 * Order follows {@link fromStorage}. Rows present only in memory (defensive) are appended after
 * storage rows. When {@link fromStorage} is null or empty, returns {@link inMemory} unchanged.
 */
export function reconcileRunRulesWithStorage(opts: {
  inMemory: RunRule[];
  fromStorage: readonly RunRule[] | undefined | null;
}): RunRule[] {
  const { inMemory, fromStorage } = opts;
  if (fromStorage == null || fromStorage.length === 0) return inMemory;
  const storageIds = new Set(fromStorage.map((r) => r.id));
  const result: RunRule[] = fromStorage.map((r) => ({ ...r }));
  for (const r of inMemory) {
    if (!storageIds.has(r.id)) {
      result.push(r);
    }
  }
  return result;
}

/** Appends rules whose ids are not already present (used when delivering new rules from a poller). */
export function appendMissingRunRules(opts: {
  inMemory: RunRule[];
  incoming: readonly RunRule[];
}): RunRule[] {
  const { inMemory, incoming } = opts;
  if (incoming.length === 0) return inMemory;
  const memoryById = new Map(inMemory.map((r) => [r.id, r]));
  const next = [...inMemory];
  for (const r of incoming) {
    if (!memoryById.has(r.id)) {
      next.push(r);
      memoryById.set(r.id, r);
    }
  }
  return next;
}

/** Markdown block appended to the pending-rules file for `coder-start.sh` (caller writes the file). */
export function formatRuleBlockForPending(rules: readonly RunRule[]): string {
  const lines: string[] = [];
  for (const r of rules) {
    const label = r.scope === 'once' ? 'once' : 'always';
    const body = r.content.replace(/\r\n/g, '\n').trimEnd();
    if (body.includes('\n')) {
      lines.push(`- [${label}]`);
      for (const line of body.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`- [${label}] ${body}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface RulesWatcher {
  stop(): void;
}

/**
 * Polls run storage for new active rules and invokes {@link onNewRules} with each batch.
 */
export function startRulesWatcher(opts: {
  runStorage: RunStorage;
  runId: string;
  /** Rule ids already included in the task for this outer attempt. */
  knownRuleIds: ReadonlySet<string>;
  onNewRules: (rules: RunRule[]) => void | Promise<void>;
  /** When set, updates this after each successful read so optimistic locking
   * can update the revision number and stay aligned with storage.
   */
  onArtifactRevision?: (rev: number) => void;
  pollIntervalMs?: number;
}): RulesWatcher {
  const {
    runStorage,
    runId,
    knownRuleIds,
    onNewRules,
    onArtifactRevision,
    pollIntervalMs = 2000,
  } = opts;

  const deliveredIds = new Set<string>(knownRuleIds);
  let busy = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const artifact = await runStorage.getRun(runId);
      if (!artifact) return;
      if (artifact.artifactRevision !== undefined) {
        onArtifactRevision?.(artifact.artifactRevision);
      }
      const rules = artifact.rules ?? [];
      const pending = rulesForPrompt(rules).filter((r) => !deliveredIds.has(r.id));
      if (pending.length === 0) return;

      await Promise.resolve(onNewRules(pending));
      for (const r of pending) {
        deliveredIds.add(r.id);
      }
    } catch (err) {
      consola.warn('[rules-watcher] Poll failed:', err);
    } finally {
      busy = false;
    }
  };

  void tick();
  const id = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}
