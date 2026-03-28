/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openhandsStdoutStrategy } from '../agent-profiles/openhands/logs.js';
import {
  createAgentRunnerStdoutMux,
  createAgentStdoutPipe,
  createDefaultAgentLog,
  SAIFCTL_AGENT_LOG_END,
  SAIFCTL_AGENT_LOG_START,
} from './logs.js';

describe('createAgentRunnerStdoutMux', () => {
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

  it('without stdoutStrategy, prefixes lines and skips delimiter lines', () => {
    const parser = createAgentRunnerStdoutMux({
      onAgentLog: createDefaultAgentLog({ linePrefix: 'agent', stdoutStrategy: null }),
      stdoutStrategy: null,
    });
    parser.push(`boot\n${SAIFCTL_AGENT_LOG_START}\nagent line\n${SAIFCTL_AGENT_LOG_END}\n`);
    parser.flush();
    const out = writes.join('');
    expect(out).toContain('[agent] boot');
    expect(out).toContain('[agent] agent line');
    expect(out).not.toContain(SAIFCTL_AGENT_LOG_START);
    expect(out).not.toContain(SAIFCTL_AGENT_LOG_END);
  });

  it('openhands strategy parses JSON only between delimiters', () => {
    const parser = createAgentRunnerStdoutMux({
      onAgentLog: createDefaultAgentLog({
        linePrefix: 'agent',
        stdoutStrategy: openhandsStdoutStrategy,
      }),
      stdoutStrategy: openhandsStdoutStrategy,
    });
    parser.push('pnpm ok\n');
    parser.push(`${SAIFCTL_AGENT_LOG_START}\n`);
    parser.push('plain agent\n');
    parser.push(
      `--JSON Event--\n{"kind":"ActionEvent","thought":[],"action":{"kind":"X","summary":"y"}}\n`,
    );
    parser.push(`${SAIFCTL_AGENT_LOG_END}\n`);
    parser.push('gate done\n');
    parser.flush();
    const out = writes.join('');
    expect(out).toContain('[agent] pnpm ok');
    expect(out).toContain('[agent] gate done');
    expect(out).toContain('plain agent');
    expect(out).toContain('[agent] X');
  });

  it('invokes onAgentLog with phase when stdoutStrategy is null', () => {
    const events: { phase: string; raw: string }[] = [];
    const parser = createAgentRunnerStdoutMux({
      onAgentLog: (e) => {
        events.push({ phase: e.phase, raw: e.raw });
      },
      stdoutStrategy: null,
    });
    parser.push(`boot\n${SAIFCTL_AGENT_LOG_START}\nagent line\n${SAIFCTL_AGENT_LOG_END}\n`);
    parser.flush();
    expect(events.some((e) => e.phase === 'infra' && e.raw === 'boot')).toBe(true);
    expect(events.some((e) => e.phase === 'agent' && e.raw === 'agent line')).toBe(true);
  });

  it('createAgentStdoutPipe forwards chunks to the same push/flush behavior', () => {
    const events: { phase: string; raw: string }[] = [];
    const pipe = createAgentStdoutPipe({
      onAgentLog: (e) => events.push({ phase: e.phase, raw: e.raw }),
      stdoutStrategy: null,
    });
    pipe.onAgentStdout(`x\n${SAIFCTL_AGENT_LOG_START}\ny\n`);
    pipe.onAgentStdoutEnd();
    expect(events.some((e) => e.phase === 'infra' && e.raw === 'x')).toBe(true);
    expect(events.some((e) => e.phase === 'agent' && e.raw === 'y')).toBe(true);
  });
});
