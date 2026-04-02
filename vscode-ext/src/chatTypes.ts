/**
 * Host ↔ webview messages for the SaifCTL Chats panel.
 */

import type { OuterAttemptSummary, RunRule } from './cliService';

/** One merged, time-sorted row in the chat timeline. */
export type TimelineEntry =
  | { kind: 'attempt'; data: OuterAttemptSummary }
  | { kind: 'rule'; data: RunRule; isPending?: boolean };

/** UI + run lifecycle status for a chat tab (includes host-only sentinels). */
export type ChatTabStatus =
  | 'loading'
  | 'not_found'
  | 'running'
  | 'paused'
  | 'resuming'
  | 'starting'
  | 'pausing'
  | 'stopping'
  | 'inspecting'
  | 'failed'
  | 'completed';

export interface ChatTabState {
  runId: string;
  runName: string;
  projectPath: string;
  status: ChatTabStatus;
  timeline: TimelineEntry[];
  startedAt?: string;
  updatedAt?: string;
}

export type HostMessage =
  | { type: 'init'; tabs: ChatTabState[]; activeRunId: string | null }
  | { type: 'tabUpdated'; tab: ChatTabState }
  | { type: 'tabDisplayNamesUpdated'; labels: Array<{ runId: string; runName: string }> }
  | { type: 'tabClosed'; runId: string }
  | { type: 'activeTabChanged'; runId: string | null }
  | { type: 'rulePending'; runId: string; entry: Extract<TimelineEntry, { kind: 'rule' }> }
  | { type: 'ruleError'; runId: string; message: string }
  | { type: 'ruleUpdated'; runId: string; ruleId: string; content: string }
  | { type: 'ruleDeleted'; runId: string; ruleId: string }
  | { type: 'ruleConfirmed'; runId: string; pendingId: string; rule: RunRule }
  | { type: 'ruleRestored'; runId: string; rule: RunRule };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'switchTab'; runId: string }
  | { type: 'closeTab'; runId: string }
  | { type: 'closeOtherTabs'; runId: string }
  | { type: 'renameTab'; runId: string; name: string }
  | { type: 'reorderTabs'; orderedRunIds: string[] }
  | { type: 'submitFeedback'; runId: string; content: string; scope: 'once' | 'always' }
  | { type: 'updateRule'; runId: string; ruleId: string; content: string }
  | { type: 'deleteRule'; runId: string; ruleId: string };
