# Semantic AI Reviewer

The factory can run a semantic code reviewer (Argus) after static checks pass and before accepting an agent’s changes. The reviewer compares the git diff against the original task to catch missed logic, hallucinated APIs, or incomplete implementations. If it finds issues, the gate fails and the agent gets another attempt.

This guide covers the rationale for selecting Argus, what the reviewer does, how to set it up, and how to configure it.

---

## Architectural Rationale: Why Argus?

When designing the reviewer inner gate, we evaluated several approaches to bridging the gap between "dumb" syntax trees and an LLM's ability to semantically understand code changes. The core requirement was a fast, offline, and reliable way to extract codebase context (callers, dependencies, definitions) without relying on heavy IDE infrastructure (like Cursor's LSP) or slow agentic terminal scraping (like OpenHands using `grep`).

### The Options We Evaluated

1. **Custom Go/TypeScript Scripts with Tree-Sitter (`go-repomap`, `LangChainGo`, `AgenticGoKit`)**
   - _Pros:_ High control over orchestration and tool calling. Libraries like `go-repomap` pre-package S-expression queries for 25+ languages, saving us from writing language-specific AST logic.
   - _Cons:_ Still requires building a custom tool/binary from scratch to handle the LLM interaction. If the LLM is asked to output S-expressions directly (interactive tool calling), it hallucinates and crashes the search. If we pre-calculate chunks, we still have to manage context window limits and RAG logic manually.
2. **SCIP / LSIF Indexers (`williamfzc/srctx`)**
   - _Pros:_ Mathematically precise, flawless import resolution across languages (what Sourcegraph and Cursor use natively). No hallucinated call graphs.
   - _Cons:_ Extremely heavyweight. Generating an `index.scip` file requires the codebase's specific compilation environment to be fully set up (e.g., `node_modules` fully installed for `scip-typescript`). If the coding agent writes syntactically broken code, the SCIP indexer fails entirely, blocking the reviewer from even looking at it.
3. **LiteLLM Proxy + Custom Orchestration**
   - _Pros:_ Normalizes all 20+ LLM providers we support (Groq, DeepSeek, etc.) to a single OpenAI schema, solving provider compatibility.
   - _Cons:_ Over-engineered for our needs. Almost all major providers (including Anthropic and Gemini) now natively support OpenAI-compatible HTTP endpoints. Running a background Python proxy inside the container adds unnecessary latency, memory overhead, and complexity.
4. **Rust-based Autonomous Reviewers (`Meru143/argus`, `ChunkHound`)**
   - _Pros:_ Rust dominates the Tree-Sitter ecosystem. Blazing fast, AST-aware chunking without requiring compilation or package installation. Can process thousands of files and build a local vector database in milliseconds. Completely self-contained binaries.
   - _Cons:_ Only part of the solution - we primarily need a _semantic reviewer_, not just a _syntax tree analyzer_.

### The Decision: `Meru143/argus`

We selected **Argus** (specifically its underlying `argus_codelens` engine) as a drop-in Rust binary for the following reasons:

1. **Zero Infrastructure Overhead:** It is a single ~15MB statically compiled binary. It doesn't require Node.js, Python, or a LiteLLM sidecar in the container.
2. **Multi-Language AST Chunking:** It uses Tree-Sitter natively (`argus map`) to build a ranked dependency graph across 10+ languages (TS, Python, Go, Rust, etc.) in milliseconds, even if the code doesn't compile.
3. **Local Vector Search:** It runs a lightweight embedding model (`all-MiniLM-L6-v2`) entirely on the CPU to perform hybrid semantic search over the AST chunks, building the perfect context window for the LLM.
4. **Native Multi-Provider Support:** Even though it's a compiled binary, it natively supports OpenAI, Anthropic, and Gemini. For the other 17+ providers we support (Groq, DeepSeek, etc.), Argus allows overriding the `base_url` for its generic OpenAI client, giving us full flexibility without needing a LiteLLM proxy.
5. **Built-in Multi-Agent Resilience:** Argus natively implements the "two-step prompt chain" (via the `self_reflection` flag) to drastically reduce false positives, which is the #1 reason automated AI reviewers fail in CI/CD.

---

## What It Does

The reviewer is an **inner gate** step that runs inside the Leash coder container after:

1. Static checks (lint, format, etc.) pass
2. The agent has produced a patch

It:

- Builds an AST map of the workspace via `argus map`
- Runs `argus review` on the current git diff
- Uses a **Goal Verification** rule that compares the diff against the original task prompt
- Fails the gate (exit 1) if it finds bugs or warnings; passes (exit 0) otherwise

The reviewer uses a separate LLM config (`reviewer`) so you can pick a different model than the coder — for example, a strong reasoning model for review and a cheaper one for coding.

---

## Gate Flow

When the reviewer is enabled, `coder-start.sh` runs the reviewer after the gate script succeeds:

```
Gate script (e.g. lint, format)
       ↓ pass
Reviewer (argus review) — in coder-start.sh
       ↓ pass
Round complete → exit 0
```

If the gate script fails, the reviewer is never run. If the reviewer fails, the round is treated like a gate failure and the agent receives feedback for the next attempt.

---

## Setup

### Prerequisites

- **Leash mode** (default). The reviewer runs inside the coder container. It is **not** used in `--dangerous-debug` mode.
- **Argus binary.** The factory downloads the Linux binary from [Meru143/argus](https://github.com/Meru143/argus) GitHub releases on first use. Architectures: `amd64` and `arm64`.

### Enable the Reviewer

The reviewer is **enabled by default**. No setup is needed if you have a compatible API key.

To disable it:

```sh
saifac feat run --no-reviewer
```

### First Run

On the first run with the reviewer enabled, the factory will:

1. Fetch the Argus binary for your host architecture (`argus-linux-amd64` or `argus-linux-arm64`)
2. Store it in `src/orchestrator/argus/out/`
3. Mount it and `reviewer.sh` into the coder container

If the download fails (e.g. release 404), use `--no-reviewer` to skip the reviewer until the binary is available.

---

## Configuration

### Reviewer Model

Configure the reviewer model independently from the coder:

```sh
# Use GPT-4o for the reviewer, Claude for the coder
saifac feat run --model coder=anthropic/claude-sonnet-4-6,reviewer=openai/gpt-4o

# Single global — both use the same model
saifac feat run --model anthropic/claude-sonnet-4-6
```

The reviewer uses the same resolution order as other agents: per-agent override → global override → auto-discovery from API keys.

### Config File

In `saifac/config.json` (or equivalent):

```json
{
  "defaults": {
    "reviewerEnabled": true,
    "agentModels": {
      "coder": "anthropic/claude-sonnet-4-6",
      "reviewer": "openai/gpt-4o"
    }
  }
}
```

`reviewerEnabled` defaults to `true`. Set to `false` to disable the reviewer by default (equivalent to always passing `--no-reviewer`).

---

## Environment Variables

The orchestrator injects these into the coder container when the reviewer is enabled:

| Variable                 | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `SAIFAC_REVIEWER_SCRIPT` | Path to `reviewer.sh` (`/saifac/reviewer.sh`) |
| `REVIEWER_LLM_PROVIDER`  | LLM provider (e.g. `anthropic`, `openai`)     |
| `REVIEWER_LLM_MODEL`     | Model string                                  |
| `REVIEWER_LLM_API_KEY`   | API key for the provider                      |
| `REVIEWER_LLM_BASE_URL`  | Optional custom base URL                      |

These are **reserved** — do not override them with `--agent-env`. See [env-vars.md](env-vars.md) for details.

---

## When the Reviewer Does Not Run

The reviewer is **skipped** in these cases:

| Scenario                            | Reviewer runs?                         |
| ----------------------------------- | -------------------------------------- |
| `saifac feat run` (default)         | Yes                                    |
| `saifac feat run --no-reviewer`     | No                                     |
| `saifac feat run --dangerous-debug` | No                                     |
| `saifac feat design-fail2pass`      | No (no coder agent)                    |
| `saifac run resume`                 | Same as initial run (from stored opts) |
| `saifac run test <runId>`           | No (no coder agent)                    |

---

## Notes

### Argus Version

The factory uses Argus v0.5.2. Binaries are fetched from the `argus-review-v0.5.2` GitHub release. If the release or assets are unavailable, the run will fail unless you pass `--no-reviewer`.

### Goal Verification Rule

`reviewer.sh` configures a single Argus rule called **Goal Verification**. It passes the original task prompt to the LLM and asks: did the agent fully fulfill the request? Missing logic, hallucinated APIs, or incomplete work are flagged as bugs or warnings.

### Review Output

On failure, the reviewer prints findings to stdout. If `jq` is available in the container, it formats comments as `file:line: message`. Otherwise it dumps the raw JSON.

### Self-Reflection

Argus is run with `self_reflection = true`, so the model can reconsider its own findings before concluding.

---

## Troubleshooting

### "Failed to download binary from ..."

The Argus release or asset is missing (404). Options:

1. Use `--no-reviewer` to skip the reviewer.
2. Build Argus from source and place the binary where the factory expects it (see `ensure-argus.ts`).

### Reviewer passes but tests fail

The reviewer only checks semantic correctness against the task. It does not run your test suite. Mutual verification (actual tests) happens after the gate.

### Wrong model for reviewer

Override with `--model reviewer=provider/model`:

```sh
saifac feat run --model reviewer=anthropic/claude-opus-4-5
```

---

## See Also

- [Environment variables](env-vars.md) — `REVIEWER_LLM_*` and container vars
- [Models](models.md) — Agent reference and `--model` usage
- [Meru143/argus](https://github.com/Meru143/argus) — Argus semantic review tool
