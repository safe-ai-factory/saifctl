/**
 * Build a merged timeline from `run info` for the Chats webview.
 */

import type { TimelineEntry } from './chatTypes';
import type { RunInfoForChat } from './cliService';

function firstLine(s: string | undefined, maxLen = 80): string {
  if (!s) return '';
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

export function innerRoundLabel(phase: string, gateOutput?: string): string {
  const snippet = firstLine(gateOutput);
  switch (phase) {
    case 'gate_passed':
      return 'Gate passed';
    case 'reviewer_passed':
      return 'Gate + review passed';
    case 'agent_failed':
      return snippet ? `Agent error: ${snippet}` : 'Agent script failed';
    case 'gate_failed':
      return snippet ? `Gate failed: ${snippet}` : 'Gate script failed';
    case 'reviewer_failed':
      return snippet ? `Review feedback: ${snippet}` : 'Reviewer failed';
    default:
      return phase;
  }
}

export function outerAttemptLabel(phase: string, errorFeedback?: string): string {
  switch (phase) {
    case 'tests_passed':
      return 'All tests passed';
    case 'tests_failed': {
      const snippet = firstLine(errorFeedback, 100);
      return snippet ? `Tests failed: ${snippet}` : 'Tests failed';
    }
    case 'no_changes':
      return 'Agent made no changes';
    case 'aborted':
      return 'Aborted';
    default:
      return phase;
  }
}

export function buildTimeline(info: RunInfoForChat): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const attempt of info.roundSummaries ?? []) {
    entries.push({ kind: 'attempt', data: attempt });
  }

  for (const rule of info.rules ?? []) {
    entries.push({ kind: 'rule', data: rule });
  }

  entries.sort((a, b) => {
    const ta = a.kind === 'attempt' ? a.data.startedAt : a.data.createdAt;
    const tb = b.kind === 'attempt' ? b.data.startedAt : b.data.createdAt;
    return ta.localeCompare(tb);
  });

  return entries;
}
