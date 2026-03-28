# Agent container stdout (high level)

How saifctl turns **raw stdout from the coding container** into readable terminal output during `feat run`, resume, and inspect. This is separate from the **structured CLI logger** (`consola`); see [Logging architecture](./logging.md) for that path.

---

## One stream, two roles

During a run, a single stdout pipe from the coding container carries:

| What | How we call it | Typical content |
| ---------------- | ---------------------- | ---------------- |
| Non-agent work | **`infra`** | Startup scripts, installs, gate output, lines before/after the agent runs |
| Agent work | **`agent`** | Everything the agent script prints while it runs |

The factory needs to know which bytes belong to which role so it can prefix or pretty-print *only* the output made by the agent CLI.

---

## Delimiter lines

`coder-start.sh` wraps the agent invocation with two **single-line markers** (they are not printed to the user):

1. `[SAIFCTL:AGENT_START]` — immediately before `bash "$AGENT_SCRIPT"`
2. `[SAIFCTL:AGENT_END]` — immediately after the agent process exits

Together they define the **agent output region**: bytes between them are tagged as agent phase; everything else (when delimiters are present) is treated as infra. If a stream never emits these lines (some idle inspect paths), the implementation stays in the non-agent path and treats each line as infra.

---

## Why reassemble chunks?

Docker and Leash do not guarantee one `read()` per line or per logical message. Chunks can split mid-line or mid-delimiter. If we printed or classified each chunk immediately, infra and agent text could mix and delimiter detection would be wrong.

So saifctl **buffers and parses** the byte stream: partial lines stay in memory until a newline or delimiter boundary is known, then it emits **typed events** (`AgentLogEvent`: `phase` + `raw`) for the sink to format.

---

## Three layers (conceptual)

| Layer | Role | Why it exists |
| ----- | ------ | ------------- |
| **1. `AgentStdoutStrategy`** (per agent profile) | Split the agent-output region into segments (if needed) and format each segment for the terminal | Some agents emit structured blobs (e.g. OpenHands JSON); others are plain lines. Strategies live under `src/agent-profiles/`; each profile sets `stdoutStrategy` to a strategy object or **`null`**. |
| **2. `createAgentRunnerStdoutMux`** | Chunked stdout → stream of `AgentLogEvent`s | Implements delimiter tracking, line assembly, and optional hand-off to the strategy’s `appendInsideWindow` / `flushInsideWindow`. |
| **3. `createDefaultAgentLog` / `defaultAgentLog`** | Event → `process.stdout` | Infra and line-mode agent events get a `[agent]` or `[inspect]` style prefix; non-null strategies delegate agent-phase segments to `formatSegment`. |

---

## Two ways to handle the agent-output region

**Line-oriented agents** (`stdoutStrategy: null` on the profile): once a line is known to sit inside the agent region (between delimiters), **one event per line** is enough. Newlines + delimiter awareness are sufficient.

**Structured agents** (e.g. OpenHands with a non-null strategy): output can span lines or include in-stream markers (e.g. `--JSON Event--`). The strategy receives **raw bytes** from that region in **safe prefixes** only: the parser holds back a short tail so an incomplete `[SAIFCTL:AGENT_END]` line is never mistaken for real agent content while data is still streaming.

---

## Related docs

- [Logging architecture](./logging.md) — `consola` vs raw stream forwarding
- [Agent profiles](./agents.md) — `stdoutStrategy` on profiles
- [Custom agent script](./v0/swf-custom-agent.md) — choosing a profile when using `--agent-script`
