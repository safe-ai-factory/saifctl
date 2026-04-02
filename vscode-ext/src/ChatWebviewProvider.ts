/**
 * Chats sidebar webview: timeline of attempts + user rules, feedback input.
 */

import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { chatTabDisplayName } from './chatTabLabels';
import { buildTimeline } from './chatTimelineBuilder';
import type { ChatTabState, ChatTabStatus, HostMessage, WebviewMessage } from './chatTypes';
import type { RunInfoForChat, SaifctlCliService } from './cliService';
import { logger } from './logger';
import type { RunInfoStore } from './runInfoStore';
import type { RunsTreeProvider } from './RunsTreeProvider';

interface PinnedChat {
  runId: string;
  /** Feature name from Runs tree; may collide across tabs. */
  featureName: string;
  projectPath: string;
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
        case 'submitFeedback':
          void this.handleSubmitFeedback({
            runId: msg.runId,
            content: msg.content,
            scope: msg.scope,
          });
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
        runName: chatTabDisplayName(this._tabs, t),
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
        runName: chatTabDisplayName(this._tabs, t),
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
      runName: chatTabDisplayName(this._tabs, tab),
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
          runName: chatTabDisplayName(this._tabs, tab),
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
      this.post({
        type: 'ruleError',
        runId,
        message: 'Failed to submit feedback. Check SaifCTL logs or try again.',
      });
      await this.refreshTab(runId, { force: true });
      return;
    }

    await this.refreshTab(runId, { force: true });
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
      display: flex;
      flex-wrap: nowrap;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-editorGroup-border);
      flex-shrink: 0;
      align-items: center;
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
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      background: var(--vscode-tab-inactiveBackground);
      color: var(--vscode-tab-inactiveForeground);
      flex-shrink: 0;
      white-space: nowrap;
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
    .chip-pass { background: var(--vscode-testing-iconPassed, #3fb950); color: #fff; }
    .chip-fail { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
    .chip-neutral { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .inner-round {
      font-size: 12px;
      margin: 4px 0 0 12px;
      opacity: 0.95;
      font-family: var(--vscode-editor-font-family);
    }
    .entry-rule .rule-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .rule-body {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
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
    details { margin-top: 6px; font-size: 12px; }
    summary { cursor: pointer; }
  </style>
</head>
<body>
  <div id="error-banner"></div>
  <div id="tab-bar"></div>
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
      case 'tests_passed': return 'All tests passed';
      case 'tests_failed':
        var sn = firstLine(errorFeedback, 100);
        return sn ? 'Tests failed: ' + sn : 'Tests failed';
      case 'no_changes': return 'Agent made no changes';
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
      var m = Math.round((b - a) / 60000);
      return m < 1 ? '<1m' : m + 'm';
    } catch (e) { return ''; }
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  var state = vscode.getState() || { tabs: [], activeRunId: null };

  function saveState() {
    vscode.setState(state);
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

  function render() {
    var tabBar = document.getElementById('tab-bar');
    var timeline = document.getElementById('timeline');
    var input = document.getElementById('feedback-input');
    var sendBtn = document.getElementById('send-btn');

    tabBar.innerHTML = '';
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
      row.onclick = function(e) {
        if (e.target && e.target.closest && e.target.closest('.tab-close')) return;
        state.activeRunId = tab.runId;
        vscode.postMessage({ type: 'switchTab', runId: tab.runId });
        render();
      };
      var label = document.createElement('span');
      label.textContent = tab.runName || tab.runId;
      var close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Close tab');
      close.textContent = '×';
      close.onclick = function(e) {
        e.stopPropagation();
        e.preventDefault();
        vscode.postMessage({ type: 'closeTab', runId: tab.runId });
      };
      row.appendChild(label);
      row.appendChild(close);
      tabBar.appendChild(row);
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
          var head = document.createElement('div');
          head.className = 'rule-head';
          var scopeBadge = entry.isPending
            ? '<span class="badge">Sending…</span>'
            : r.scope === 'always'
              ? '<span class="badge">always</span>'
              : r.consumedAt
                ? '<span class="badge">consumed</span>'
                : '<span class="badge">up next</span>';
          head.innerHTML = '<span>💬 You</span>' + scopeBadge + '<span style="opacity:0.7">' + formatTime(r.createdAt) + '</span>';
          div.appendChild(head);
          var body = document.createElement('div');
          body.className = 'rule-body';
          body.textContent = r.content;
          div.appendChild(body);
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
        break;
      case 'activeTabChanged':
        state.activeRunId = msg.runId;
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

  render();
  vscode.postMessage({ type: 'ready' });
})();
`;
}
