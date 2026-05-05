import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatCursorSegment } from './logs.js';

describe('formatCursorSegment', () => {
  let writes: string[];

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses inspect tag when linePrefix is inspect', () => {
    formatCursorSegment('{"type":"system","model":"claude","cwd":"/tmp"}', 'inspect');
    expect(writes.some((w) => w.includes('[inspect]'))).toBe(true);
    expect(writes.some((w) => w.includes('[agent]'))).toBe(false);
  });

  it('formats system init event', () => {
    formatCursorSegment('{"type":"system","model":"claude-4.6","cwd":"/workspace"}', 'agent');
    expect(writes.join('')).toContain('init: model=claude-4.6 cwd=/workspace');
  });

  it('skips user prompt echo', () => {
    formatCursorSegment(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}',
      'agent',
    );
    expect(writes).toHaveLength(0);
  });

  it('formats assistant thinking text', () => {
    formatCursorSegment(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will read the file first."}]}}',
      'agent',
    );
    expect(writes.join('')).toContain('[think] I will read the file first.');
  });

  it('formats tool_call started for shellToolCall', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: {
          shellToolCall: {
            description: 'List files',
            args: { command: 'ls -la /tmp' },
          },
        },
      }),
      'agent',
    );
    const out = writes.join('');
    expect(out).toContain('[agent] → List files: ls -la /tmp');
  });

  it('formats tool_call completed for readToolCall with line count', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/foo.md' },
            result: { success: { totalLines: 42 } },
          },
        },
      }),
      'agent',
    );
    const out = writes.join('');
    expect(out).toContain('[agent] ✓ read /tmp/foo.md → 42 lines');
  });

  it('formats tool_call completed for readToolCall with error', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/missing.md' },
            result: { error: { errorMessage: 'File not found' } },
          },
        },
      }),
      'agent',
    );
    const out = writes.join('');
    expect(out).toContain('[agent] ✓ read /tmp/missing.md → ✗ File not found');
  });

  it('formats tool_call completed for editToolCall with line counts', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          editToolCall: {
            args: { path: '/tmp/bar.md' },
            result: { success: { linesAdded: 10, linesRemoved: 2 } },
          },
        },
      }),
      'agent',
    );
    const out = writes.join('');
    expect(out).toContain('[agent] ✓ edit /tmp/bar.md → +10/-2 lines');
  });

  it('formats result success with token usage', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'The file has been written.',
        usage: { inputTokens: 11, outputTokens: 500, cacheReadTokens: 12000 },
      }),
      'agent',
    );
    const out = writes.join('');
    expect(out).toContain('[agent] ✓ done:');
    expect(out).toContain('tokens: in=11 out=500 cache_read=12000');
  });

  it('formats result error', () => {
    formatCursorSegment(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Something went wrong.',
        usage: null,
      }),
      'agent',
    );
    expect(writes.join('')).toContain('[agent] ✗ result:');
  });

  it('passes through non-JSON lines', () => {
    formatCursorSegment('[agent/cursor] Starting agent cursor in agent.sh...', 'agent');
    expect(writes.join('')).toContain(
      '[agent] [agent/cursor] Starting agent cursor in agent.sh...',
    );
  });

  it('passes through unknown JSON event types', () => {
    formatCursorSegment('{"type":"unknown_future_event","data":42}', 'agent');
    expect(writes.join('')).toContain('[agent]');
  });
});
