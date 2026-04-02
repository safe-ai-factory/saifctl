/**
 * Chats sidebar webview: timeline of attempts + user rules, feedback input.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { chatTabDisplayName } from './chatTabLabels';
import { buildTimeline } from './chatTimelineBuilder';
import type { ChatTabState, ChatTabStatus, HostMessage, WebviewMessage } from './chatTypes';
import type { RunInfoForChat, RunRule, SaifctlCliService } from './cliService';
import { logger } from './logger';
import type { RunInfoStore } from './runInfoStore';
import type { RunsTreeProvider } from './RunsTreeProvider';

interface PinnedChat {
  runId: string;
  /** Feature name from Runs tree; may collide across tabs. */
  featureName: string;
  projectPath: string;
  /** User override for tab title; persisted in workspace. */
  customName?: string;
}

const CHAT_TABS_STORAGE_KEY = 'saifctl.openChatTabs';

interface PersistedChatState {
  tabs: PinnedChat[];
  activeRunId: string | null;
}

export interface ChatWebviewProviderDeps {
  extensionUri: vscode.Uri;
  cli: SaifctlCliService;
  runsProvider: RunsTreeProvider;
  runInfoStore: RunInfoStore;
  workspaceState: vscode.Memento;
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'saifctl-chats';

  private _view: vscode.WebviewView | undefined;
  private _tabs: PinnedChat[] = [];
  private _activeRunId: string | null = null;
  private _runsSub: vscode.Disposable | undefined;

  constructor(private readonly _deps: ChatWebviewProviderDeps) {
    const saved = _deps.workspaceState.get<PersistedChatState>(CHAT_TABS_STORAGE_KEY);
    if (saved?.tabs?.length) {
      this._tabs = saved.tabs;
      const active = saved.activeRunId;
      this._activeRunId =
        active && saved.tabs.some((t) => t.runId === active)
          ? active
          : (saved.tabs[0]?.runId ?? null);
      void _deps.workspaceState.update(CHAT_TABS_STORAGE_KEY, {
        tabs: this._tabs,
        activeRunId: this._activeRunId,
      });
    }
  }

  private saveTabs(): void {
    void this._deps.workspaceState.update(CHAT_TABS_STORAGE_KEY, {
      tabs: this._tabs,
      activeRunId: this._activeRunId,
    });
  }

  /** Shown tab title: custom name, else disambiguated feature name. */
  private tabDisplayName(tab: PinnedChat): string {
    const custom = tab.customName?.trim();
    if (custom) return custom;
    return chatTabDisplayName(this._tabs, tab);
  }

  private renameTab(runId: string, name: string): void {
    const tab = this._tabs.find((t) => t.runId === runId);
    if (!tab) return;
    const trimmed = name.trim();
    tab.customName = trimmed ? trimmed : undefined;
    this.saveTabs();
    this.postTabDisplayNamesUpdated();
  }

  private closeOtherTabs(keepRunId: string): void {
    const keep = this._tabs.find((t) => t.runId === keepRunId);
    this._tabs = keep ? [keep] : [];
    this._activeRunId = keep?.runId ?? null;
    this.saveTabs();
    void this.sendInit();
  }

  /** Apply tab order from the webview after drag-and-drop reorder. */
  private reorderTabs(orderedRunIds: string[]): void {
    const byId = new Map(this._tabs.map((t) => [t.runId, t]));
    const next: PinnedChat[] = [];
    for (const id of orderedRunIds) {
      const t = byId.get(id);
      if (t) {
        next.push(t);
        byId.delete(id);
      }
    }
    for (const t of this._tabs) {
      if (byId.has(t.runId)) next.push(t);
    }
    this._tabs = next;
    this.saveTabs();
  }

  // eslint-disable-next-line max-params -- VS Code WebviewViewProvider API
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._deps.extensionUri],
    };

    const nonce = randomBytes(16).toString('base64');
    webviewView.webview.html = getWebviewHtml(webviewView.webview, nonce);

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          void this.sendInit();
          break;
        case 'switchTab':
          this._activeRunId = msg.runId;
          this.saveTabs();
          this.post({ type: 'activeTabChanged', runId: msg.runId });
          break;
        case 'closeTab':
          this.closeTab(msg.runId);
          break;
        case 'closeOtherTabs':
          this.closeOtherTabs(msg.runId);
          break;
        case 'renameTab':
          this.renameTab(msg.runId, msg.name);
          break;
        case 'reorderTabs':
          this.reorderTabs(msg.orderedRunIds);
          break;
        case 'submitFeedback':
          void this.handleSubmitFeedback({
            runId: msg.runId,
            content: msg.content,
            scope: msg.scope,
          });
          break;
        case 'updateRule':
          void this.handleUpdateRule({
            runId: msg.runId,
            ruleId: msg.ruleId,
            content: msg.content,
          });
          break;
        case 'deleteRule':
          void this.handleDeleteRule({ runId: msg.runId, ruleId: msg.ruleId });
          break;
        default:
          break;
      }
    });

    this._runsSub?.dispose();
    this._runsSub = this._deps.runsProvider.onDidChangeTreeData(() => {
      if (this._tabs.length === 0) return;
      for (const tab of this._tabs) {
        void this.refreshTab(tab.runId, { force: false });
      }
    });

    webviewView.onDidDispose(() => {
      this._runsSub?.dispose();
      this._runsSub = undefined;
      this._view = undefined;
    });
  }

  /** Pin or focus a run in the Chats view. */
  public openTab(opts: { runId: string; runName: string; projectPath: string }): void {
    const { runId, runName, projectPath } = opts;
    if (!this._tabs.some((t) => t.runId === runId)) {
      this._tabs.push({ runId, featureName: runName, projectPath });
    }
    this._activeRunId = runId;
    this.saveTabs();

    void Promise.resolve(
      vscode.commands.executeCommand(`${ChatWebviewProvider.viewId}.focus`),
    ).catch(() => vscode.commands.executeCommand('workbench.view.extension.saifctl-explorer'));

    if (this._view) {
      this._view.show(true);
      const tabRow = this._tabs.find((t) => t.runId === runId);
      if (tabRow) {
        const cached = this._deps.runInfoStore.get(tabRow.projectPath, runId);
        if (cached) {
          this.post({ type: 'tabUpdated', tab: this.tabStateFromInfo(tabRow, cached) });
        }
      }
      this.postTabDisplayNamesUpdated();
      void this.refreshTab(runId, { force: true });
      this.post({ type: 'activeTabChanged', runId });
    }
  }

  private closeTab(runId: string): void {
    this._tabs = this._tabs.filter((t) => t.runId !== runId);
    if (this._activeRunId === runId) {
      this._activeRunId = this._tabs[this._tabs.length - 1]?.runId ?? null;
    }
    this.post({ type: 'tabClosed', runId });
    this.post({ type: 'activeTabChanged', runId: this._activeRunId });
    this.postTabDisplayNamesUpdated();
    this.saveTabs();
  }

  private post(msg: HostMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /** Sync disambiguated tab titles when tabs open/close (webview may already show stale labels). */
  private postTabDisplayNamesUpdated(): void {
    if (!this._view || this._tabs.length === 0) return;
    this.post({
      type: 'tabDisplayNamesUpdated',
      labels: this._tabs.map((t) => ({
        runId: t.runId,
        runName: this.tabDisplayName(t),
      })),
    });
  }

  private async sendInit(): Promise<void> {
    const tabs: ChatTabState[] = this._tabs.map((t) => {
      const cached = this._deps.runInfoStore.get(t.projectPath, t.runId);
      if (cached) {
        return this.tabStateFromInfo(t, cached);
      }
      return {
        runId: t.runId,
        runName: this.tabDisplayName(t),
        projectPath: t.projectPath,
        status: 'loading',
        timeline: [],
      };
    });
    this.post({ type: 'init', tabs, activeRunId: this._activeRunId });
    await Promise.all(this._tabs.map((t) => this.refreshTab(t.runId, { force: false })));
  }

  private tabStateFromInfo(tab: PinnedChat, info: RunInfoForChat): ChatTabState {
    return {
      runId: tab.runId,
      runName: this.tabDisplayName(tab),
      projectPath: tab.projectPath,
      status: info.status as ChatTabStatus,
      timeline: buildTimeline(info),
      startedAt: info.startedAt,
      updatedAt: info.updatedAt,
    };
  }

  private async refreshTab(runId: string, opts?: { force?: boolean }): Promise<void> {
    const tab = this._tabs.find((t) => t.runId === runId);
    if (!tab || !this._view) return;

    const info = await this._deps.runInfoStore.fetch({
      cli: this._deps.cli,
      runId,
      projectPath: tab.projectPath,
      force: opts?.force,
    });
    if (!info) {
      logger.warn(`Chats: run info failed for ${runId}`);
      this.post({
        type: 'tabUpdated',
        tab: {
          runId: tab.runId,
          runName: this.tabDisplayName(tab),
          projectPath: tab.projectPath,
          status: 'not_found',
          timeline: [],
        },
      });
      return;
    }

    this.post({ type: 'tabUpdated', tab: this.tabStateFromInfo(tab, info) });
  }

  private async handleSubmitFeedback(opts: {
    runId: string;
    content: string;
    scope: 'once' | 'always';
  }): Promise<void> {
    const { runId, content, scope } = opts;
    const tab = this._tabs.find((t) => t.runId === runId);
    if (!tab) return;

    const pendingEntry = {
      kind: 'rule' as const,
      data: {
        id: `pending-${Date.now()}`,
        content,
        scope,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      isPending: true,
    };
    this.post({ type: 'rulePending', runId, entry: pendingEntry });

    const ruleId = await this._deps.cli.createRunRule({
      runId,
      cwd: tab.projectPath,
      content,
      scope,
    });

    if (!ruleId) {
      this.post({ type: 'ruleDeleted', runId, ruleId: pendingEntry.data.id });
      this.post({
        type: 'ruleError',
        runId,
        message: 'Failed to submit feedback. Check SaifCTL logs or try again.',
      });
      return;
    }

    const newRule: RunRule = {
      id: ruleId,
      content,
      scope,
      createdAt: pendingEntry.data.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const cachedAfterCreate = this._deps.runInfoStore.get(tab.projectPath, runId);
    if (cachedAfterCreate) {
      cachedAfterCreate.rules = [...(cachedAfterCreate.rules ?? []), newRule];
    }
    this.post({
      type: 'ruleConfirmed',
      runId,
      pendingId: pendingEntry.data.id,
      rule: newRule,
    });
  }

  private async handleUpdateRule(opts: {
    runId: string;
    ruleId: string;
    content: string;
  }): Promise<void> {
    const { runId, ruleId, content } = opts;
    const tab = this._tabs.find((t) => t.runId === runId);
    if (!tab) return;
    const trimmed = content.trim();
    if (!trimmed) {
      this.post({
        type: 'ruleError',
        runId,
        message: 'Feedback text cannot be empty.',
      });
      return;
    }

    const cached = this._deps.runInfoStore.get(tab.projectPath, runId);
    const prevRow = cached?.rules?.find((r) => r.id === ruleId);
    const previousContent = prevRow?.content;

    this.post({ type: 'ruleUpdated', runId, ruleId, content: trimmed });
    const now = new Date().toISOString();
    if (prevRow) {
      prevRow.content = trimmed;
      prevRow.updatedAt = now;
    }

    const ok = await this._deps.cli.updateRunRule({
      runId,
      cwd: tab.projectPath,
      ruleId,
      content: trimmed,
    });
    if (!ok) {
      this.post({
        type: 'ruleError',
        runId,
        message: 'Failed to update feedback. Check SaifCTL logs or try again.',
      });
      if (previousContent !== undefined) {
        this.post({ type: 'ruleUpdated', runId, ruleId, content: previousContent });
        const revertRow = cached?.rules?.find((r) => r.id === ruleId);
        if (revertRow) {
          revertRow.content = previousContent;
        }
      } else {
        void this.refreshTab(runId, { force: true });
      }
      return;
    }
  }

  private async handleDeleteRule(opts: { runId: string; ruleId: string }): Promise<void> {
    const { runId, ruleId } = opts;
    const tab = this._tabs.find((t) => t.runId === runId);
    if (!tab) return;
    const pick = await vscode.window.showWarningMessage(
      'Remove this feedback rule? It will no longer be sent to the agent.',
      { modal: true },
      'Delete',
    );
    if (pick !== 'Delete') return;

    const cached = this._deps.runInfoStore.get(tab.projectPath, runId);
    const snapshot = cached?.rules?.find((r) => r.id === ruleId);
    if (cached?.rules) {
      cached.rules = cached.rules.filter((r) => r.id !== ruleId);
    }
    this.post({ type: 'ruleDeleted', runId, ruleId });

    const ok = await this._deps.cli.deleteRunRule({
      runId,
      cwd: tab.projectPath,
      ruleId,
    });
    if (!ok) {
      this.post({
        type: 'ruleError',
        runId,
        message: 'Failed to delete feedback. Check SaifCTL logs or try again.',
      });
      if (snapshot) {
        const c = this._deps.runInfoStore.get(tab.projectPath, runId);
        if (c) {
          const next = [...(c.rules ?? []), snapshot];
          next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          c.rules = next;
        }
        this.post({ type: 'ruleRestored', runId, rule: snapshot });
      } else {
        void this.refreshTab(runId, { force: true });
      }
      return;
    }
  }
}

function getWebviewHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const script = getWebviewScript();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SaifCTL Chats</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
    }
    #tab-bar {
      position: relative;
      flex-shrink: 0;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      overflow-x: auto;
      overflow-y: hidden;
      min-width: 0;
      scrollbar-width: thin;
    }
    #tab-bar::-webkit-scrollbar {
      height: 6px;
    }
    #tab-bar::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    #tab-strip {
      display: flex;
      flex-wrap: nowrap;
      gap: 4px;
      padding: 6px 8px;
      align-items: center;
      min-height: 36px;
    }
    #drop-indicator {
      position: absolute;
      top: 6px;
      bottom: 6px;
      width: 2px;
      margin-left: -1px;
      background: var(--vscode-focusBorder, var(--vscode-button-background));
      border-radius: 1px;
      pointer-events: none;
      display: none;
      z-index: 2;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: grab;
      font-size: 12px;
      background: var(--vscode-tab-inactiveBackground);
      color: var(--vscode-tab-inactiveForeground);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .tab.dragging {
      opacity: 0.45;
      cursor: grabbing;
    }
    .tab.active {
      background: var(--vscode-tab-activeBackground);
      color: var(--vscode-tab-activeForeground);
    }
    .tab-close {
      padding: 0 2px;
      opacity: 0.8;
      cursor: pointer;
      border: none;
      background: transparent;
      color: inherit;
      font-size: 14px;
      line-height: 1;
    }
    #timeline {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .entry {
      margin-bottom: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    }
    .entry-attempt .attempt-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .chip {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }
    .chip-pass { background: var(--vscode-testing-iconPassed, #3fb950); color: #252526; }
    .chip-fail { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
    .chip-neutral { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .inner-round {
      font-size: 12px;
      margin: 4px 0 0 12px;
      opacity: 0.95;
      font-family: var(--vscode-editor-font-family);
    }
    .entry-rule .rule-head {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .rule-head.rule-head--editable { padding-right: 28px; }
    .rule-head-main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .rule-kebab {
      position: absolute;
      top: 0;
      right: 0;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0.55;
      padding: 0 4px;
      font-size: 16px;
      line-height: 1;
      border-radius: 3px;
    }
    .rule-kebab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .rule-body {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      cursor: default;
    }
    .entry-rule .rule-body.editable { cursor: text; }
    .rule-edit-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 3px;
      padding: 6px 8px;
      font-size: 13px;
      font-family: var(--vscode-editor-font-family);
      resize: vertical;
      min-height: 64px;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .entry-pending { opacity: 0.75; }
    #error-banner {
      display: none;
      padding: 6px 10px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border-bottom: 1px solid var(--vscode-inputValidation-errorBorder);
      font-size: 12px;
    }
    #error-banner.visible { display: block; }
    #input-area {
      flex-shrink: 0;
      padding: 8px;
      border-top: 1px solid var(--vscode-editorGroup-border);
    }
    #feedback-input {
      width: 100%;
      min-height: 56px;
      resize: vertical;
      padding: 6px 8px;
      margin-bottom: 6px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    #feedback-input:disabled { opacity: 0.6; }
    #scope-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    #send-btn {
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    #send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .empty-hint {
      padding: 16px;
      text-align: center;
      opacity: 0.7;
      font-size: 13px;
    }
    .tab-label {
      cursor: pointer;
      user-select: none;
    }
    .tab-rename-input {
      font-size: 12px;
      font-family: inherit;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 2px;
      padding: 0 4px;
      outline: none;
      min-width: 48px;
      width: 120px;
      max-width: 200px;
      height: 20px;
      flex: 1;
    }
    #ctx-menu {
      position: fixed;
      display: none;
      z-index: 1000;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border, var(--vscode-editorGroup-border));
      border-radius: 4px;
      padding: 4px 0;
      min-width: 168px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    }
    #ctx-menu .ctx-item {
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
      color: var(--vscode-menu-foreground);
      user-select: none;
    }
    #ctx-menu .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-hoverForeground));
    }
    #ctx-menu .ctx-sep {
      height: 1px;
      margin: 4px 0;
      background: var(--vscode-menu-separatorBackground, var(--vscode-editorGroup-border));
    }
    details { margin-top: 6px; font-size: 12px; }
    summary { cursor: pointer; }
  </style>
</head>
<body>
  <div id="error-banner"></div>
  <div id="ctx-menu" role="menu" aria-hidden="true"></div>
  <div id="tab-bar">
    <div id="tab-strip"></div>
    <div id="drop-indicator" aria-hidden="true"></div>
  </div>
  <div id="timeline"></div>
  <div id="input-area">
    <textarea id="feedback-input" placeholder="Send feedback to agent… (Ctrl+Enter to send)"></textarea>
    <div id="scope-row">
      <label><input type="radio" name="scope" value="once" checked> Once (next round)</label>
      <label><input type="radio" name="scope" value="always"> Always</label>
    </div>
    <button type="button" id="send-btn">Send</button>
  </div>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

function getWebviewScript(): string {
  return `
(function() {
  const vscode = acquireVsCodeApi();

  function innerRoundLabel(phase, gateOutput) {
    function firstLine(s, maxLen) {
      maxLen = maxLen || 80;
      if (!s) return '';
      var line = (s.split('\\n').find(function(l) { return l.trim(); }) || '');
      return line.length > maxLen ? line.slice(0, maxLen) + '…' : line;
    }
    var snippet = firstLine(gateOutput);
    switch (phase) {
      case 'gate_passed': return 'Gate passed';
      case 'reviewer_passed': return 'Gate + review passed';
      case 'agent_failed': return snippet ? 'Agent error: ' + snippet : 'Agent script failed';
      case 'gate_failed': return snippet ? 'Gate failed: ' + snippet : 'Gate script failed';
      case 'reviewer_failed': return snippet ? 'Review feedback: ' + snippet : 'Reviewer failed';
      default: return phase;
    }
  }

  function outerAttemptLabel(phase, errorFeedback) {
    function firstLine(s, maxLen) {
      maxLen = maxLen || 100;
      if (!s) return '';
      var line = (s.split('\\n').find(function(l) { return l.trim(); }) || '');
      return line.length > maxLen ? line.slice(0, maxLen) + '…' : line;
    }
    switch (phase) {
      case 'tests_passed': return 'Passed';
      case 'tests_failed':
        var sn = firstLine(errorFeedback, 100);
        return sn ? 'Failed: ' + sn : 'Failed';
      case 'no_changes': return 'No changes';
      case 'aborted': return 'Aborted';
      default: return phase;
    }
  }

  function phaseChipClass(phase) {
    if (phase === 'tests_passed') return 'chip chip-pass';
    if (phase === 'tests_failed' || phase === 'no_changes') return 'chip chip-fail';
    return 'chip chip-neutral';
  }

  function formatDurationMs(startedAt, completedAt) {
    try {
      var a = new Date(startedAt).getTime();
      var b = new Date(completedAt).getTime();
      if (isNaN(a) || isNaN(b) || b < a) return '';
      var totalSec = Math.floor((b - a) / 1000);
      var totalMin = Math.floor(totalSec / 60);
      if (totalMin < 1) return '<1m';
      if (totalMin < 60) return totalMin + 'm';
      var h = Math.floor(totalMin / 60);
      var rem = totalMin % 60;
      if (h < 24) return h + 'h' + (rem > 0 ? ' ' + rem + 'm' : '');
      var d = Math.floor(h / 24);
      var remH = h % 24;
      return d + 'd' + (remH > 0 ? ' ' + remH + 'h' : '');
    } catch (e) { return ''; }
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      var dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var yesterdayStart = new Date(dayStart.getTime() - 86400000);
      if (d >= dayStart) return timeStr;
      if (d >= yesterdayStart) return 'Yesterday ' + timeStr;
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + timeStr;
    } catch (e) { return ''; }
  }

  var state = vscode.getState() || { tabs: [], activeRunId: null };
  var renamingRunId = null;
  var renamingRuleId = null;
  /** @type {null | { kind: 'rule', anchor: Element } | { kind: 'tab', clientX: number, clientY: number }} */
  var ctxMenuPlacement = null;

  function saveState() {
    vscode.setState(state);
  }

  var CTX_MENU_MARGIN = 6;
  var CTX_RULE_GAP = 4;

  function clampCtxMenuXY(left, top, menuW, menuH) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var m = CTX_MENU_MARGIN;
    if (left < m) left = m;
    if (left + menuW > vw - m) left = Math.max(m, vw - menuW - m);
    if (top < m) top = m;
    if (top + menuH > vh - m) top = Math.max(m, vh - menuH - m);
    return { left: left, top: top };
  }

  function layoutCtxMenu(menu) {
    if (!menu || !ctxMenuPlacement) return;
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var left;
    var top;
    if (ctxMenuPlacement.kind === 'rule') {
      var anchor = ctxMenuPlacement.anchor;
      if (!anchor.isConnected) {
        hideCtxMenu();
        return;
      }
      var rect = anchor.getBoundingClientRect();
      var preferLeft = rect.left - w - CTX_RULE_GAP;
      var preferTop = rect.bottom + 2;
      var c = clampCtxMenuXY(preferLeft, preferTop, w, h);
      left = c.left;
      top = c.top;
      if (left + w > rect.left - CTX_RULE_GAP) {
        var c2 = clampCtxMenuXY(rect.right + CTX_RULE_GAP, preferTop, w, h);
        left = c2.left;
        top = c2.top;
      }
    } else {
      var ct = clampCtxMenuXY(ctxMenuPlacement.clientX, ctxMenuPlacement.clientY, w, h);
      left = ct.left;
      top = ct.top;
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function repositionOpenCtxMenu() {
    var menu = document.getElementById('ctx-menu');
    if (!menu || menu.style.display !== 'block' || !ctxMenuPlacement) return;
    if (ctxMenuPlacement.kind === 'rule' && !ctxMenuPlacement.anchor.isConnected) {
      hideCtxMenu();
      return;
    }
    layoutCtxMenu(menu);
  }

  function hideCtxMenu() {
    ctxMenuPlacement = null;
    var menu = document.getElementById('ctx-menu');
    if (!menu) return;
    menu.style.display = 'none';
    menu.style.visibility = '';
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
  }

  function beginRename(runId) {
    renamingRunId = runId;
    hideCtxMenu();
    render();
  }

  function isEditableRuleEntry(entry) {
    if (entry.kind !== 'rule') return false;
    if (entry.isPending) return false;
    return !entry.data.consumedAt;
  }

  function beginRuleRename(ruleId) {
    renamingRuleId = ruleId;
    hideCtxMenu();
    render();
  }

  function showRuleCtxMenu(anchorEl, ruleId) {
    var menu = document.getElementById('ctx-menu');
    function item(label, action) {
      var el = document.createElement('div');
      el.className = 'ctx-item';
      el.setAttribute('role', 'menuitem');
      el.textContent = label;
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        hideCtxMenu();
        action();
      });
      menu.appendChild(el);
    }
    ctxMenuPlacement = { kind: 'rule', anchor: anchorEl };
    menu.innerHTML = '';
    item('Edit Feedback', function() {
      beginRuleRename(ruleId);
    });
    item('Delete Feedback', function() {
      if (!state.activeRunId) return;
      vscode.postMessage({ type: 'deleteRule', runId: state.activeRunId, ruleId: ruleId });
    });
    menu.style.visibility = 'hidden';
    menu.style.display = 'block';
    menu.style.left = '0';
    menu.style.top = '0';
    layoutCtxMenu(menu);
    menu.style.visibility = 'visible';
    menu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function() {
      repositionOpenCtxMenu();
    });
  }

  function showCtxMenu(x, y, runId) {
    var menu = document.getElementById('ctx-menu');

    function item(label, action) {
      var el = document.createElement('div');
      el.className = 'ctx-item';
      el.setAttribute('role', 'menuitem');
      el.textContent = label;
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        hideCtxMenu();
        action();
      });
      menu.appendChild(el);
    }

    function sep() {
      var el = document.createElement('div');
      el.className = 'ctx-sep';
      menu.appendChild(el);
    }

    ctxMenuPlacement = { kind: 'tab', clientX: x, clientY: y };
    menu.innerHTML = '';
    item('Rename Chat', function() {
      beginRename(runId);
    });
    sep();
    item('Close Chat', function() {
      vscode.postMessage({ type: 'closeTab', runId: runId });
    });
    item('Close Other Chats', function() {
      vscode.postMessage({ type: 'closeOtherTabs', runId: runId });
    });

    menu.style.visibility = 'hidden';
    menu.style.display = 'block';
    menu.style.left = '0';
    menu.style.top = '0';
    layoutCtxMenu(menu);
    menu.style.visibility = 'visible';
    menu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(function() {
      repositionOpenCtxMenu();
    });
  }

  function setupGlobalUiHandlers() {
    if (document.body.dataset.ctxUi) return;
    document.body.dataset.ctxUi = '1';

    document.addEventListener('mousedown', function(e) {
      var menu = document.getElementById('ctx-menu');
      if (!menu || menu.style.display !== 'block') return;
      if (menu.contains(e.target)) return;
      hideCtxMenu();
    });

    window.addEventListener('resize', function() {
      repositionOpenCtxMenu();
    });

    if (typeof ResizeObserver !== 'undefined' && !document.body.dataset.ctxResizeObs) {
      document.body.dataset.ctxResizeObs = '1';
      var ro = new ResizeObserver(function() {
        repositionOpenCtxMenu();
      });
      ro.observe(document.body);
    }
  }

  function showError(msg) {
    var el = document.getElementById('error-banner');
    if (!msg) {
      el.classList.remove('visible');
      el.textContent = '';
      return;
    }
    el.textContent = msg;
    el.classList.add('visible');
    setTimeout(function() {
      el.classList.remove('visible');
      el.textContent = '';
    }, 8000);
  }

  function canSendFeedback(status) {
    return status !== 'loading' && status !== 'not_found';
  }

  var dragState = { dragRunId: null, dropIndex: null };

  function getDropIndex(clientX, stripEl) {
    var tabs = stripEl.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var rect = tabs[i].getBoundingClientRect();
      var mid = rect.left + rect.width / 2;
      if (clientX < mid) return i;
    }
    return tabs.length;
  }

  function clearDropIndicator() {
    var el = document.getElementById('drop-indicator');
    if (el) el.style.display = 'none';
    dragState.dropIndex = null;
  }

  function positionDropIndicator(tabBarEl, stripEl, idx) {
    var indicator = document.getElementById('drop-indicator');
    var tabs = stripEl.querySelectorAll('.tab');
    var barRect = tabBarEl.getBoundingClientRect();
    var scrollL = tabBarEl.scrollLeft;
    var x;
    if (tabs.length === 0) {
      x = 8 + scrollL;
    } else if (idx === 0) {
      x = tabs[0].getBoundingClientRect().left - barRect.left + scrollL - 2;
    } else if (idx >= tabs.length) {
      x = tabs[tabs.length - 1].getBoundingClientRect().right - barRect.left + scrollL + 2;
    } else {
      var pr = tabs[idx - 1].getBoundingClientRect();
      var nx = tabs[idx].getBoundingClientRect();
      x = (pr.right + nx.left) / 2 - barRect.left + scrollL;
    }
    indicator.style.left = x + 'px';
    indicator.style.display = 'block';
  }

  function setupTabBarDnD() {
    var tabBar = document.getElementById('tab-bar');
    var strip = document.getElementById('tab-strip');
    if (!tabBar || !strip || tabBar.dataset.dndBound) return;
    tabBar.dataset.dndBound = '1';

    tabBar.addEventListener('dragover', function(e) {
      if (dragState.dragRunId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var idx = getDropIndex(e.clientX, strip);
      if (idx !== dragState.dropIndex) {
        dragState.dropIndex = idx;
        positionDropIndicator(tabBar, strip, idx);
      }
    });

    tabBar.addEventListener('dragleave', function(e) {
      var rt = e.relatedTarget;
      if (!rt || !tabBar.contains(rt)) {
        clearDropIndicator();
      }
    });

    tabBar.addEventListener('drop', function(e) {
      e.preventDefault();
      var fromId = dragState.dragRunId;
      var toIdx = dragState.dropIndex;
      if (toIdx === null) toIdx = getDropIndex(e.clientX, strip);
      clearDropIndicator();
      dragState.dragRunId = null;
      strip.querySelectorAll('.tab.dragging').forEach(function(el) {
        el.classList.remove('dragging');
      });

      if (fromId === null || toIdx === null) return;

      var fromIdx = state.tabs.findIndex(function(t) { return t.runId === fromId; });
      if (fromIdx === -1) return;

      var moved = state.tabs.splice(fromIdx, 1)[0];
      var insertAt = toIdx;
      if (fromIdx < toIdx) insertAt = toIdx - 1;
      state.tabs.splice(insertAt, 0, moved);

      vscode.postMessage({
        type: 'reorderTabs',
        orderedRunIds: state.tabs.map(function(t) { return t.runId; }),
      });
      render();
    });
  }

  function render() {
    var strip = document.getElementById('tab-strip');
    var timeline = document.getElementById('timeline');
    var input = document.getElementById('feedback-input');
    var sendBtn = document.getElementById('send-btn');

    strip.innerHTML = '';
    clearDropIndicator();
    if (!state.tabs || state.tabs.length === 0) {
      timeline.innerHTML = '<div class="empty-hint">No chats open. In Runs, use the chat icon on a run row or right-click → Open in Chat.</div>';
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = 'Open a run in Chat first';
      saveState();
      return;
    }

    state.tabs.forEach(function(tab) {
      var row = document.createElement('div');
      row.className = 'tab' + (tab.runId === state.activeRunId ? ' active' : '');
      row.setAttribute('role', 'tab');
      row.setAttribute('draggable', 'true');
      row.dataset.runId = tab.runId;
      row.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, tab.runId);
      });
      row.addEventListener('dragstart', function(e) {
        if (renamingRunId === tab.runId) {
          e.preventDefault();
          return;
        }
        if (e.target && e.target.closest && e.target.closest('.tab-close')) {
          e.preventDefault();
          return;
        }
        dragState.dragRunId = tab.runId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.runId);
        requestAnimationFrame(function() {
          row.classList.add('dragging');
        });
      });
      row.addEventListener('dragend', function() {
        dragState.dragRunId = null;
        row.classList.remove('dragging');
        clearDropIndicator();
      });
      row.onclick = function(e) {
        if (e.target && e.target.closest && e.target.closest('.tab-close')) return;
        if (e.target && e.target.closest && e.target.closest('.tab-rename-input')) return;
        if (e.target && e.target.closest && e.target.closest('.tab-label') && e.detail >= 2) return;
        if (state.activeRunId === tab.runId) return;
        state.activeRunId = tab.runId;
        vscode.postMessage({ type: 'switchTab', runId: tab.runId });
        render();
      };
      var close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close tab');
      close.setAttribute('draggable', 'false');
      close.textContent = '×';
      close.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({ type: 'closeTab', runId: tab.runId });
      };

      var nameInputRef = null;
      if (renamingRunId === tab.runId) {
        var nameInput = document.createElement('input');
        nameInputRef = nameInput;
        nameInput.type = 'text';
        nameInput.className = 'tab-rename-input';
        nameInput.value = tab.runName || tab.runId;
        nameInput.setAttribute('draggable', 'false');
        nameInput.setAttribute('aria-label', 'Rename chat tab');

        var blurActive = false;

        function commitRenameFromBlur() {
          if (renamingRunId !== tab.runId) return;
          if (blurActive) return;
          blurActive = true;
          var val = nameInput.value.trim();
          renamingRunId = null;
          vscode.postMessage({ type: 'renameTab', runId: tab.runId, name: val });
          render();
        }

        function cancelRename() {
          blurActive = true;
          nameInput.removeEventListener('blur', commitRenameFromBlur);
          renamingRunId = null;
          render();
        }

        nameInput.addEventListener('blur', function() {
          requestAnimationFrame(commitRenameFromBlur);
        });
        nameInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            nameInput.blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
          }
        });
        nameInput.addEventListener('click', function(e) {
          e.stopPropagation();
        });
        nameInput.addEventListener('dblclick', function(e) {
          e.stopPropagation();
        });
        row.appendChild(nameInput);
      } else {
        var label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = tab.runName || tab.runId;
        label.addEventListener('dblclick', function(e) {
          e.stopPropagation();
          e.preventDefault();
          beginRename(tab.runId);
        });
        row.appendChild(label);
      }
      row.appendChild(close);
      strip.appendChild(row);

      if (nameInputRef) {
        requestAnimationFrame(function() {
          nameInputRef.focus();
          nameInputRef.select();
        });
      }
    });

    var active = state.tabs.find(function(t) { return t.runId === state.activeRunId; });
    if (!active && state.tabs.length) {
      active = state.tabs[0];
      state.activeRunId = active.runId;
    }

    if (!active) {
      timeline.innerHTML = '';
      input.disabled = true;
      sendBtn.disabled = true;
      saveState();
      return;
    }

    var canSend = canSendFeedback(active.status);
    input.disabled = !canSend;
    sendBtn.disabled = !canSend;
    input.placeholder =
      active.status === 'loading'
        ? 'Loading run data…'
        : active.status === 'not_found'
          ? 'Run not found — it may have been deleted'
          : 'Send feedback to agent… (Ctrl+Enter to send)';

    timeline.innerHTML = '';
    if (!active.timeline || active.timeline.length === 0) {
      timeline.innerHTML =
        '<div class="empty-hint">' +
        (active.status === 'loading'
          ? 'Loading…'
          : active.status === 'not_found'
            ? 'Run data could not be loaded. The run may have been deleted.'
            : 'No timeline yet.') +
        '</div>';
    } else {
      active.timeline.forEach(function(entry) {
        if (entry.kind === 'attempt') {
          var a = entry.data;
          var div = document.createElement('div');
          div.className = 'entry entry-attempt';
          var head = document.createElement('div');
          head.className = 'attempt-head';
          head.innerHTML = '<span>Attempt ' + a.attempt + '</span>' +
            '<span class="' + phaseChipClass(a.phase) + '">' + outerAttemptLabel(a.phase, a.errorFeedback) + '</span>' +
            '<span style="opacity:0.8;font-size:11px">' + formatTime(a.startedAt) + ' · ' + formatDurationMs(a.startedAt, a.completedAt) + '</span>';
          div.appendChild(head);
          (a.innerRounds || []).forEach(function(ir) {
            var irEl = document.createElement('div');
            irEl.className = 'inner-round';
            irEl.textContent = '↳ Round ' + ir.round + ' — ' + innerRoundLabel(ir.phase, ir.gateOutput);
            div.appendChild(irEl);
          });
          if (a.errorFeedback) {
            var det = document.createElement('details');
            det.innerHTML = '<summary>Feedback detail</summary><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;margin:6px 0 0">' +
              escapeHtml(a.errorFeedback) + '</pre>';
            div.appendChild(det);
          }
          timeline.appendChild(div);
        } else if (entry.kind === 'rule') {
          var r = entry.data;
          var div = document.createElement('div');
          div.className = 'entry entry-rule' + (entry.isPending ? ' entry-pending' : '');
          var editable = isEditableRuleEntry(entry);
          var head = document.createElement('div');
          head.className = 'rule-head' + (editable ? ' rule-head--editable' : '');
          var scopeBadge = entry.isPending
            ? '<span class="badge">Sending…</span>'
            : r.scope === 'always'
              ? '<span class="badge">always</span>'
              : r.consumedAt
                ? '<span class="badge">consumed</span>'
                : '<span class="badge">up next</span>';
          var main = document.createElement('div');
          main.className = 'rule-head-main';
          main.innerHTML = '<span>💬 You</span>' + scopeBadge + '<span style="opacity:0.7">' + formatTime(r.createdAt) + '</span>';
          head.appendChild(main);
          if (editable) {
            var kebab = document.createElement('button');
            kebab.type = 'button';
            kebab.className = 'rule-kebab';
            kebab.setAttribute('aria-label', 'Rule actions');
            kebab.setAttribute('draggable', 'false');
            kebab.textContent = '⋮';
            kebab.addEventListener('click', function(e) {
              e.stopPropagation();
              e.preventDefault();
              showRuleCtxMenu(kebab, r.id);
            });
            head.appendChild(kebab);
          }
          div.appendChild(head);
          if (editable && renamingRuleId === r.id) {
            var ta = document.createElement('textarea');
            ta.className = 'rule-edit-input';
            ta.value = r.content;
            ta.setAttribute('aria-label', 'Edit feedback');
            ta.setAttribute('draggable', 'false');
            var blurCommitted = false;
            function commitRuleEditFromBlur() {
              if (blurCommitted) return;
              blurCommitted = true;
              if (renamingRuleId !== r.id) return;
              var val = ta.value.trim();
              renamingRuleId = null;
              if (val && state.activeRunId) {
                vscode.postMessage({ type: 'updateRule', runId: state.activeRunId, ruleId: r.id, content: val });
              }
              render();
            }
            function cancelRuleEdit() {
              blurCommitted = true;
              ta.removeEventListener('blur', onRuleBlur);
              renamingRuleId = null;
              render();
            }
            function onRuleBlur() {
              requestAnimationFrame(commitRuleEditFromBlur);
            }
            ta.addEventListener('blur', onRuleBlur);
            ta.addEventListener('keydown', function(e) {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelRuleEdit();
              }
            });
            ta.addEventListener('click', function(e) {
              e.stopPropagation();
            });
            div.appendChild(ta);
            requestAnimationFrame(function() {
              ta.focus();
              ta.setSelectionRange(ta.value.length, ta.value.length);
            });
          } else {
            var body = document.createElement('div');
            body.className = 'rule-body' + (editable ? ' editable' : '');
            body.textContent = r.content;
            if (editable) {
              body.addEventListener('dblclick', function(e) {
                e.stopPropagation();
                e.preventDefault();
                beginRuleRename(r.id);
              });
            }
            div.appendChild(body);
          }
          timeline.appendChild(div);
        }
      });
    }

    saveState();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'init':
        state.tabs = msg.tabs || [];
        state.activeRunId = msg.activeRunId;
        renamingRunId = null;
        renamingRuleId = null;
        hideCtxMenu();
        break;
      case 'tabUpdated':
        var idx = state.tabs.findIndex(function(t) { return t.runId === msg.tab.runId; });
        if (idx >= 0) state.tabs[idx] = msg.tab;
        else state.tabs.push(msg.tab);
        break;
      case 'tabDisplayNamesUpdated':
        (msg.labels || []).forEach(function(u) {
          var t = state.tabs.find(function(x) { return x.runId === u.runId; });
          if (t) t.runName = u.runName;
        });
        break;
      case 'tabClosed':
        state.tabs = state.tabs.filter(function(t) { return t.runId !== msg.runId; });
        if (state.activeRunId === msg.runId) {
          state.activeRunId = state.tabs.length ? state.tabs[state.tabs.length - 1].runId : null;
        }
        if (renamingRunId === msg.runId) renamingRunId = null;
        renamingRuleId = null;
        hideCtxMenu();
        break;
      case 'activeTabChanged':
        state.activeRunId = msg.runId;
        renamingRuleId = null;
        hideCtxMenu();
        break;
      case 'rulePending':
        var tab = state.tabs.find(function(t) { return t.runId === msg.runId; });
        if (tab) {
          tab.timeline = tab.timeline || [];
          tab.timeline.push(msg.entry);
        }
        break;
      case 'ruleError':
        showError(msg.message);
        break;
      case 'ruleUpdated':
        var tu = state.tabs.find(function(x) { return x.runId === msg.runId; });
        if (tu && tu.timeline) {
          tu.timeline.forEach(function(ent) {
            if (ent.kind === 'rule' && ent.data.id === msg.ruleId) {
              ent.data.content = msg.content;
              ent.data.updatedAt = new Date().toISOString();
            }
          });
        }
        break;
      case 'ruleDeleted':
        var td = state.tabs.find(function(x) { return x.runId === msg.runId; });
        if (td && td.timeline) {
          td.timeline = td.timeline.filter(function(ent) {
            return !(ent.kind === 'rule' && ent.data.id === msg.ruleId);
          });
        }
        if (renamingRuleId === msg.ruleId) renamingRuleId = null;
        break;
      case 'ruleConfirmed':
        var tc = state.tabs.find(function(t) { return t.runId === msg.runId; });
        if (tc && tc.timeline) {
          for (var ci = 0; ci < tc.timeline.length; ci++) {
            var entC = tc.timeline[ci];
            if (entC.kind === 'rule' && entC.data.id === msg.pendingId) {
              tc.timeline[ci] = { kind: 'rule', data: msg.rule };
              break;
            }
          }
        }
        break;
      case 'ruleRestored':
        var tr = state.tabs.find(function(t) { return t.runId === msg.runId; });
        if (tr && tr.timeline) {
          tr.timeline.push({ kind: 'rule', data: msg.rule });
          tr.timeline.sort(function(a, b) {
            var ta = a.kind === 'attempt' ? a.data.startedAt : a.data.createdAt;
            var tb = b.kind === 'attempt' ? b.data.startedAt : b.data.createdAt;
            return ta.localeCompare(tb);
          });
        }
        break;
      default:
        return;
    }
    render();
  });

  document.getElementById('send-btn').addEventListener('click', function() {
    var content = document.getElementById('feedback-input').value.trim();
    if (!content || !state.activeRunId) return;
    var scopeEl = document.querySelector('input[name="scope"]:checked');
    var scope = scopeEl ? scopeEl.value : 'once';
    vscode.postMessage({ type: 'submitFeedback', runId: state.activeRunId, content: content, scope: scope });
    document.getElementById('feedback-input').value = '';
  });

  document.getElementById('feedback-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.getElementById('send-btn').click();
    }
  });

  setupGlobalUiHandlers();
  setupTabBarDnD();
  render();
  vscode.postMessage({ type: 'ready' });
})();
`;
}
