// ---------------------------------------------------------------------------
// Container logging
// ---------------------------------------------------------------------------
//
// HIGH-LEVEL FLOW
// ───────────────
// Every coding run streams stdout from a container process (Leash + coder-start.sh).
// That stream mixes two logically distinct phases:
//
//   "infra"  — startup, installs, gate checks, etc. (before/after the agent script)
//   "agent"  — the coding agent's own output (between delimiter lines, see below)
//
// coder-start.sh emits:
//   [SAIFCTL:AGENT_START]   ← start of agent output (not shown to the user)
//   ... everything the agent script writes to stdout ...
//   [SAIFCTL:AGENT_END]     ← end of agent output (not shown to the user)
//
// Those two lines are agent/non-agent output delimiters: they mark where agent
// stdout begins and ends so we can tag bytes correctly.
//
// This module's job is to take raw stdout chunks, identify which phase each byte
// belongs to, and call a sink with typed AgentLogEvents so the CLI can format and
// print them correctly.
//
// ARCHITECTURE IN THREE LAYERS
// ────────────────────────────
// 1. AgentStdoutStrategy (per-profile, optional)
//    Some agents (e.g. OpenHands) emit structured data between the delimiters.
//    A strategy knows how to split that window into discrete segments and how to
//    format each segment for human consumption.  Profiles with null strategy use
//    plain line-based output.
//
// 2. createAgentRunnerStdoutMux
//    Docker/Leash deliver stdout in arbitrary chunk sizes, not necessarily aligned to lines or
//    delimiter boundaries.  This function exists so we can wait until we have enough context
//    before printing or classifying text — otherwise infra and agent output would mix and break.
//    It tracks non-agent vs agent-output regions and either forwards whole lines (null strategy)
//    or hands agent bytes to the profile's appendInsideWindow/flushInsideWindow for finer splits.
//
// 3. createDefaultAgentLog / defaultAgentLog
//    AgentLogEvent sink: decides how to print each event to stdout.
//    Infra events and null-strategy agent events get a [prefix] line.
//    Strategy agent events are handed to strategy.formatSegment for richer output.

/** Non-agent (infra) vs agent script output, as separated by coder-start delimiters. */
export type AgentLogPhase = 'infra' | 'agent';

export interface AgentLogEvent {
  phase: AgentLogPhase;
  /**
   * Raw text: typically one line (infra / raw agent) or one segment produced by the profile’s
   * {@link AgentStdoutStrategy} in the agent output region (e.g. OpenHands `--JSON Event--` chunk).
   */
  raw: string;
}

/** Emitted by coder-start.sh immediately before `bash "$AGENT_SCRIPT"` (one line). */
export const SAIFCTL_AGENT_LOG_START = '[SAIFCTL:AGENT_START]';

/** Emitted by coder-start.sh immediately after the agent process exits (one line). */
export const SAIFCTL_AGENT_LOG_END = '[SAIFCTL:AGENT_END]';

const isAgentSegmentDelimiter = (line: string): boolean => {
  return line === SAIFCTL_AGENT_LOG_START || line === SAIFCTL_AGENT_LOG_END;
};

export type AgentLogLinePrefix = 'agent' | 'inspect';

/**
 * Profile-supplied splitting of bytes between the agent output delimiters and CLI formatting
 * per segment. This file does not hard-code any agent's format; strategies live under `agent-profiles/`.
 */
export interface AgentStdoutStrategy {
  appendInsideWindow: (input: {
    state: { buf: string };
    chunk: string;
    emitSegment: (segment: string) => void;
  }) => void;
  flushInsideWindow: (input: {
    state: { buf: string };
    emitSegment: (segment: string) => void;
  }) => void;
  formatSegment: (segment: string, linePrefix: AgentLogLinePrefix) => void;
}

/**
 * Logger for the agent coder container's stdout.
 *
 * Infra lines and agent lines without a profile {@link AgentStdoutStrategy} use `[prefix] line`;
 * agent phase with a non-null strategy delegates to {@link AgentStdoutStrategy.formatSegment}.
 */
function defaultAgentLog(
  event: AgentLogEvent,
  opts: { linePrefix: AgentLogLinePrefix; stdoutStrategy?: AgentStdoutStrategy | null },
): void {
  // Case: We're currently NOT in the agent phase (agent.sh).
  //       Log everything as-is.
  if (event.phase === 'infra') {
    if (!event.raw.trim()) return;
    if (isAgentSegmentDelimiter(event.raw)) return;
    process.stdout.write(`[${opts.linePrefix}] ${event.raw}\n`);
    return;
  }

  // Case: We're in agent phase (inside `agent.sh`), but no agent-specific formatting is configured.
  //       Log everything as-is with the `[prefix]` prefix.
  if (!opts.stdoutStrategy) {
    if (!event.raw.trim()) return;
    if (isAgentSegmentDelimiter(event.raw)) return;
    process.stdout.write(`[${opts.linePrefix}] ${event.raw}\n`);
    return;
  }

  // Case: Agent-specific formatting is configured. And we're currently
  //       in the agent phase (inside `agent.sh`).
  //       Delegate to agent-specific formatter.
  opts.stdoutStrategy.formatSegment(event.raw, opts.linePrefix);
}

/** Options for {@link createDefaultAgentLog}. */
export interface CreateDefaultAgentLogOpts {
  linePrefix: AgentLogLinePrefix;
  /** Agent-specific formatter (e.g. OpenHands JSON parsing); `null` for line-wise agent events. */
  stdoutStrategy: AgentStdoutStrategy | null;
}

/**
 * Logger for the agent coder container's stdout.
 * Prints to stdout. Agent-specific formatting is applied here (e.g. OpenHands JSON parsing)
 */
export function createDefaultAgentLog(
  opts: CreateDefaultAgentLogOpts,
): (event: AgentLogEvent) => void {
  return (event) => defaultAgentLog(event, opts);
}

// ---------------------------------------------------------------------------
// Chunked stdout → AgentLogEvent stream
// ---------------------------------------------------------------------------
//
// Line-oriented agents only need newline boundaries: once we know
// which side of the delimiters a line belongs to, one event per line is enough.
//
// Structured agents (e.g. OpenHands) can emit multi-line JSON or markers mid-byte; their profile
// supplies a strategy so we can split that region into meaningful pieces before formatting.
// That path buffers raw bytes between delimiters and only forwards "safe" prefixes to the
// strategy so a trailing chunk cannot be mistaken for the start of the END delimiter line.

export interface CreateAgentRunnerStdoutMuxOpts {
  onAgentLog: (event: AgentLogEvent) => void;
  /**
   * When non-null, splits agent-output bytes (between delimiters) into segments;
   * otherwise each line is one agent event.
   */
  stdoutStrategy: AgentStdoutStrategy | null;
}

/** Wraps a raw string from strategy.appendInsideWindow into an agent-phase event. */
function emitAgentSegment(sink: (e: AgentLogEvent) => void, raw: string): void {
  if (raw.trim()) sink({ phase: 'agent', raw });
}

/**
 * Handles stdout chunks from the Leash/docker child (e.g. `coder-start.sh` for runAgent).
 *
 * Uses `[SAIFCTL:AGENT_*]` delimiter lines when present. Streams without them (e.g. inspect idle)
 * stay in the non-agent region: every line is infra. Emits {@link AgentLogEvent}s; formatting is
 * {@link createDefaultAgentLog}.
 */
export function createAgentRunnerStdoutMux(opts: CreateAgentRunnerStdoutMuxOpts): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  const sink = opts.onAgentLog;
  const strategy = opts.stdoutStrategy;

  // Skip delimiter lines themselves — they are markers only, not user-facing log text.
  const emitInfraLine = (line: string): void => {
    if (line === SAIFCTL_AGENT_LOG_START || line === SAIFCTL_AGENT_LOG_END) return;
    if (line.trim()) sink({ phase: 'infra', raw: line });
  };

  // ── null-strategy path: simple line splitter ──────────────────────────────
  // Each '\n'-terminated line becomes one event.  No segment splitting needed;
  // the strategy formatter will see whole lines tagged with the correct phase.
  if (!strategy) {
    let lineBuf = '';
    let inAgent = false;
    return {
      push(chunk: string) {
        lineBuf += chunk;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (line === SAIFCTL_AGENT_LOG_START) {
            inAgent = true;
            continue;
          }
          if (line === SAIFCTL_AGENT_LOG_END) {
            inAgent = false;
            continue;
          }
          sink({
            phase: inAgent ? 'agent' : 'infra',
            raw: line,
          });
        }
      },
      flush() {
        if (!lineBuf.trim()) return;
        const line = lineBuf;
        if (line === SAIFCTL_AGENT_LOG_START) {
          inAgent = true;
          lineBuf = '';
          return;
        }
        if (line === SAIFCTL_AGENT_LOG_END) {
          inAgent = false;
          lineBuf = '';
          return;
        }
        sink({
          phase: inAgent ? 'agent' : 'infra',
          raw: line,
        });
        lineBuf = '';
      },
    };
  }

  // ── non-null strategy path: non-agent lines vs raw agent output ───────────
  // Non-agent region: each line is infra until we see the START delimiter; then we
  // collect raw agent bytes in rawInside and feed safe chunks to the strategy.
  // END delimiter closes the agent region; anything after it goes back to non-agent parsing.

  type StreamRegion = 'nonAgent' | 'agentOutput';
  let region: StreamRegion = 'nonAgent';
  let nonAgentLineBuf = '';

  // rawInside   — bytes since the START delimiter (tail may still be growing).
  // fedInto     — how many leading bytes of rawInside have already been fed to the strategy.
  // bufferState — scratch buffer owned by the strategy (e.g. OpenHands segment assembly).
  let rawInside = '';
  let fedInto = 0;
  const bufferState = { buf: '' };

  const pushNonAgentLines = (chunk: string) => {
    nonAgentLineBuf += chunk;
    const lines = nonAgentLineBuf.split('\n');
    nonAgentLineBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line === SAIFCTL_AGENT_LOG_START) {
        region = 'agentOutput';
        rawInside = '';
        fedInto = 0;
        bufferState.buf = '';
      } else {
        emitInfraLine(line);
      }
    }
  };

  // When we see the END delimiter: flush the agent window, emit segments, resume outside with any trailing bytes.
  const pushAgentOutput = (chunk: string) => {
    rawInside += chunk;
    const endIdx = rawInside.indexOf(SAIFCTL_AGENT_LOG_END);
    // END delimiter found: process bytes up to it, flush segments, then parse any trailing bytes as non-agent.
    if (endIdx >= 0) {
      const feed = rawInside.slice(fedInto, endIdx);
      strategy.appendInsideWindow({
        state: bufferState,
        chunk: feed,
        emitSegment: (s) => emitAgentSegment(sink, s),
      });
      strategy.flushInsideWindow({
        state: bufferState,
        emitSegment: (s) => emitAgentSegment(sink, s),
      });
      const after = rawInside.slice(endIdx + SAIFCTL_AGENT_LOG_END.length);
      rawInside = '';
      fedInto = 0;
      region = 'nonAgent';
      nonAgentLineBuf = '';
      if (after) pushNonAgentLines(after);
      return;
    }

    // Still in agent output: do not feed the last few bytes — they might be the start of the END delimiter line.
    const reserve = SAIFCTL_AGENT_LOG_END.length - 1;
    const safeEnd = rawInside.length - reserve;
    if (safeEnd <= fedInto) return;
    const feed = rawInside.slice(fedInto, safeEnd);
    fedInto += feed.length;
    strategy.appendInsideWindow({
      state: bufferState,
      chunk: feed,
      emitSegment: (s) => emitAgentSegment(sink, s),
    });
  };

  return {
    push(chunk: string) {
      if (region === 'nonAgent') pushNonAgentLines(chunk);
      else pushAgentOutput(chunk);
    },
    flush() {
      if (region === 'nonAgent') {
        if (nonAgentLineBuf.trim()) emitInfraLine(nonAgentLineBuf);
      } else if (rawInside.indexOf(SAIFCTL_AGENT_LOG_END) < 0) {
        // Stream ended before END delimiter: flush whatever agent output we buffered.
        strategy.appendInsideWindow({
          state: bufferState,
          chunk: rawInside.slice(fedInto),
          emitSegment: (s) => emitAgentSegment(sink, s),
        });
        strategy.flushInsideWindow({
          state: bufferState,
          emitSegment: (s) => emitAgentSegment(sink, s),
        });
      }
    },
  };
}

/**
 * Builds {@link Engine.runAgent} / {@link Engine.startInspect} stdout callbacks.
 * The engine only forwards opaque chunks; here we pair {@link createAgentRunnerStdoutMux}
 * with a sink (e.g. {@link createDefaultAgentLog}) so bytes become tagged events before they hit the terminal.
 */
export function createAgentStdoutPipe(opts: {
  onAgentLog: (event: AgentLogEvent) => void;
  stdoutStrategy: AgentStdoutStrategy | null;
}): {
  onAgentStdout: (chunk: string) => void;
  onAgentStdoutEnd: () => void;
} {
  const parser = createAgentRunnerStdoutMux(opts);
  return {
    onAgentStdout: (chunk) => {
      parser.push(chunk);
    },
    onAgentStdoutEnd: () => {
      parser.flush();
    },
  };
}
