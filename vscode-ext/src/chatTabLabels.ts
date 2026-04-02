/**
 * Disambiguate chat tab titles when multiple open runs share the same feature name.
 */

export interface ChatTabLabelInput {
  runId: string;
  /** Base label from the Runs tree (feature name). */
  featureName: string;
}

/** Alphanumeric tail of run id, for compact disambiguation (e.g. "ktkw1re"). */
export function runIdShortToken(runId: string, len: number): string {
  const alnum = runId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (alnum.length <= len) {
    return alnum || runId.toLowerCase();
  }
  return alnum.slice(-len);
}

function collisionGroupKey(tab: ChatTabLabelInput): string {
  const n = tab.featureName.trim();
  if (n === '') {
    return `__id:${tab.runId}`;
  }
  return `__name:${n.toLowerCase()}`;
}

/**
 * Tab label shown in the Chats strip: plain feature name, or `name (suffix)` when
 * another open tab shares the same feature name (case-insensitive, trimmed).
 */
export function chatTabDisplayName(
  tabs: readonly ChatTabLabelInput[],
  tab: ChatTabLabelInput,
): string {
  const base = tab.featureName.trim() || tab.runId;
  const gk = collisionGroupKey(tab);
  const group = tabs.filter((t) => collisionGroupKey(t) === gk);
  if (group.length <= 1) {
    return base;
  }

  const maxLen = Math.max(32, ...group.map((t) => t.runId.length));
  for (let len = 7; len <= maxLen; len++) {
    const mine = runIdShortToken(tab.runId, len);
    const matches = group.filter((t) => runIdShortToken(t.runId, len) === mine);
    if (matches.length === 1) {
      return `${base} (${mine})`;
    }
  }

  return `${base} (${tab.runId})`;
}
