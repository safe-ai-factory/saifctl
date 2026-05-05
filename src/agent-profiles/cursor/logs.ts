/**
 * Cursor CLI `--output-format stream-json` log formatter.
 *
 * Cursor emits one JSON object per newline. Each object has a `type` field:
 *   - "system"     — session init (model, cwd, etc.)
 *   - "user"       — the user prompt echo (very large; skipped)
 *   - "assistant"  — model text (thinking/announcing next step)
 *   - "tool_call"  — tool invocation: subtype "started" | "completed"
 *   - "result"     — final result summary
 *
 * Strategy: split on newlines (one JSON per line), parse, and pretty-print.
 */

import type { AgentLogLinePrefix, AgentStdoutStrategy } from '../../orchestrator/logs.js';

/** Newline-delimited: each line is one complete JSON event. */
function appendInsideWindow(input: {
  state: { buf: string };
  chunk: string;
  emitSegment: (segment: string) => void;
}): void {
  const { state, chunk, emitSegment } = input;
  state.buf += chunk;
  const parts = state.buf.split('\n');
  state.buf = parts.pop() ?? '';
  for (const line of parts) {
    if (line.trim()) emitSegment(line);
  }
}

function flushInsideWindow(input: {
  state: { buf: string };
  emitSegment: (segment: string) => void;
}): void {
  const { state, emitSegment } = input;
  if (state.buf.trim()) emitSegment(state.buf);
  state.buf = '';
}

/** Extract and truncate the text content from an assistant message. */
function extractAssistantText(message: Record<string, unknown> | undefined): string {
  const content = (message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return '';
  for (const part of content as Record<string, unknown>[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text.trim().replaceAll('\n', ' ').slice(0, 200);
    }
  }
  return '';
}

/** Build a short label for a tool_call event. */
function toolCallLabel(toolCall: Record<string, unknown>): string {
  // shellToolCall
  const shell = toolCall.shellToolCall as Record<string, unknown> | undefined;
  if (shell) {
    const args = shell.args as Record<string, unknown> | undefined;
    const desc = typeof shell.description === 'string' ? shell.description : '';
    const cmd = typeof args?.command === 'string' ? args.command.trim() : '';
    if (desc) return `${desc}: ${cmd.slice(0, 100)}`;
    return `$ ${cmd.slice(0, 140)}`;
  }

  // readToolCall
  const read = toolCall.readToolCall as Record<string, unknown> | undefined;
  if (read) {
    const args = read.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === 'string' ? args.path : '';
    return `read ${path}`;
  }

  // editToolCall
  const edit = toolCall.editToolCall as Record<string, unknown> | undefined;
  if (edit) {
    const args = edit.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === 'string' ? args.path : '';
    return `edit ${path}`;
  }

  // writeToolCall
  const write = toolCall.writeToolCall as Record<string, unknown> | undefined;
  if (write) {
    const args = write.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === 'string' ? args.path : '';
    return `write ${path}`;
  }

  // searchToolCall / grep-style
  const search = (toolCall.searchToolCall ?? toolCall.grepToolCall) as
    | Record<string, unknown>
    | undefined;
  if (search) {
    const args = search.args as Record<string, unknown> | undefined;
    const query =
      typeof args?.query === 'string'
        ? args.query
        : typeof args?.pattern === 'string'
          ? args.pattern
          : '';
    return `search ${query.slice(0, 100)}`;
  }

  // Fallback: show first known key
  const keys = Object.keys(toolCall);
  return keys[0] ?? 'tool';
}

/** Extract the outcome of a completed tool_call for a short result annotation. */
function toolCallResult(toolCall: Record<string, unknown>): string {
  const shell = toolCall.shellToolCall as Record<string, unknown> | undefined;
  if (shell) {
    const result = shell.result as Record<string, unknown> | undefined;
    if (!result) return '';
    const success = result.success as Record<string, unknown> | undefined;
    const failure = result.failure as Record<string, unknown> | undefined;
    if (success) {
      const stdout = typeof success.stdout === 'string' ? success.stdout.trim() : '';
      if (stdout) return ` → ${stdout.split('\n')[0]?.slice(0, 80)}`;
      return ' → ok';
    }
    if (failure) {
      const exit = typeof failure.exitCode === 'number' ? failure.exitCode : '?';
      const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
      if (stderr) return ` → exit ${exit}: ${stderr.split('\n')[0]?.slice(0, 80)}`;
      return ` → exit ${exit}`;
    }
  }

  const read = toolCall.readToolCall as Record<string, unknown> | undefined;
  if (read) {
    const result = read.result as Record<string, unknown> | undefined;
    const success = result?.success as Record<string, unknown> | undefined;
    const error = result?.error as Record<string, unknown> | undefined;
    if (error) {
      const msg = typeof error.errorMessage === 'string' ? error.errorMessage : 'error';
      return ` → ✗ ${msg}`;
    }
    if (success) {
      const lines = typeof success.totalLines === 'number' ? success.totalLines : '';
      return lines ? ` → ${lines} lines` : ' → ok';
    }
  }

  const edit = toolCall.editToolCall as Record<string, unknown> | undefined;
  if (edit) {
    const result = edit.result as Record<string, unknown> | undefined;
    const success = result?.success as Record<string, unknown> | undefined;
    const error = result?.error as Record<string, unknown> | undefined;
    if (error) {
      const msg = typeof error.errorMessage === 'string' ? error.errorMessage : 'error';
      return ` → ✗ ${msg}`;
    }
    if (success) {
      const added = typeof success.linesAdded === 'number' ? success.linesAdded : 0;
      const removed = typeof success.linesRemoved === 'number' ? success.linesRemoved : 0;
      return ` → +${added}/-${removed} lines`;
    }
  }

  return '';
}

/**
 * Format a single Cursor stream-json line for human-readable terminal output.
 * Skips verbose event types (user prompt echo); surfaces model thinking, tool
 * calls, and the final result summary.
 */
export function formatCursorSegment(segment: string, linePrefix: AgentLogLinePrefix): void {
  const tag = linePrefix === 'inspect' ? 'inspect' : 'agent';
  const trimmed = segment.trim();
  if (!trimmed) return;

  // Non-JSON lines (e.g. shell startup echo from agent.sh itself): pass through.
  if (!trimmed.startsWith('{')) {
    process.stdout.write(`[${tag}] ${trimmed}\n`);
    return;
  }

  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    process.stdout.write(`[${tag}] ${trimmed}\n`);
    return;
  }

  const type = typeof evt.type === 'string' ? evt.type : '';

  switch (type) {
    case 'system': {
      // Show init info: model + cwd.
      const model = typeof evt.model === 'string' ? evt.model : '';
      const cwd = typeof evt.cwd === 'string' ? evt.cwd : '';
      const parts = [model && `model=${model}`, cwd && `cwd=${cwd}`].filter(Boolean);
      process.stdout.write(`[${tag}] init${parts.length ? ': ' + parts.join(' ') : ''}\n`);
      break;
    }

    case 'user':
      // Skip: the full user prompt echo is enormous and not useful in the log.
      break;

    case 'assistant': {
      const text = extractAssistantText(evt.message as Record<string, unknown> | undefined);
      if (text) process.stdout.write(`[think] ${text}\n`);
      break;
    }

    case 'tool_call': {
      const subtype = typeof evt.subtype === 'string' ? evt.subtype : '';
      const rawToolCall = evt.tool_call as Record<string, unknown> | undefined;
      if (!rawToolCall) break;

      if (subtype === 'started') {
        const label = toolCallLabel(rawToolCall);
        process.stdout.write(`[${tag}] → ${label}\n`);
      } else if (subtype === 'completed') {
        const label = toolCallLabel(rawToolCall);
        const outcome = toolCallResult(rawToolCall);
        process.stdout.write(`[${tag}] ✓ ${label}${outcome}\n`);
      }
      break;
    }

    case 'result': {
      const subtype = typeof evt.subtype === 'string' ? evt.subtype : '';
      const isError = evt.is_error === true || subtype === 'error';
      const raw = typeof evt.result === 'string' ? evt.result.trim() : '';
      // Cursor concatenates all assistant turn text into result; use last sentence for brevity.
      const sentences = raw.split(/\.\s+/);
      const summary = (sentences[sentences.length - 1] ?? raw).slice(0, 200);
      if (isError) {
        process.stdout.write(`[${tag}] ✗ result: ${summary}\n`);
      } else {
        process.stdout.write(`[${tag}] ✓ done: ${summary}\n`);
      }
      // Print token usage if present.
      const usage = evt.usage as Record<string, unknown> | undefined;
      if (usage) {
        const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
        const cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
        process.stdout.write(
          `[${tag}] tokens: in=${input} out=${output} cache_read=${cacheRead}\n`,
        );
      }
      break;
    }

    default:
      // Unknown event type: emit as-is so nothing is silently lost.
      process.stdout.write(`[${tag}] ${trimmed}\n`);
  }
}

/** Wired into the orchestrator mux: one segment per newline-delimited JSON line. */
export const cursorStdoutStrategy: AgentStdoutStrategy = {
  appendInsideWindow,
  flushInsideWindow,
  formatSegment: formatCursorSegment,
};
