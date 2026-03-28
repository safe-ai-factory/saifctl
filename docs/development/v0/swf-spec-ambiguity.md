# Software Factory: Spec Ambiguity & the Vague Specs Checker

## Overview

When the iterative loop runs (OpenHands → extract patch → Mutual Verification), the Test Runner container may report test failures. In some cases, these failures are **not** caused by the implementation agent getting the code wrong. They are caused by an **ambiguous or incomplete specification**: the test-writing agent wrote tests that assume behavior the spec never explicitly defined, while the implementation agent made a different (and equally reasonable) interpretation.

This document describes that edge case, how the **Vague Specs Checker** detects it, and the three resolution modes: `off`, `prompt`, and `ai`.

---

## The Edge Case: Divergent Interpretations

The Software Factory has three distinct AI agents involved in a single feature cycle:

| Agent             | Role                                 | Input                                               |
| ----------------- | ------------------------------------ | --------------------------------------------------- |
| **Tests Planner** | Generates the test plan (tests.md)   | specification.md, plan.md                           |
| **Tests Catalog** | Produces tests.json + runner.spec.ts | tests.md, spec files                                |
| **OpenHands**     | Implements the feature               | plan.md, specification.md, tests.json (public only) |

The Planner and Catalog share the same spec. The implementation agent (OpenHands) also sees the spec, but **not** the hidden (holdout) tests. When the spec is vague, both the test writer and the implementer must "guess" the intended behavior. If they guess differently, holdout tests fail even though the implementation is arguably correct.

### Example

**Spec says:** "The `greet` command outputs a greeting."

**Planner/Catalog infers:** Greeting must include the name passed as argument (e.g. `Hello, Alice`).

**OpenHands infers:** Greeting can be generic (e.g. `Hello, world`).

**Outcome:** The hidden test expects `stdout` to contain the name. The implementation prints a fixed string. Tests fails — but the spec never said the greeting had to be personalized. The test is _unfair_ given the spec as written.

---

## The Vague Specs Checker

After each tests failure, when `--resolve-ambiguity` is `prompt` or `ai`, the orchestrator invokes a **Vague Specs Checker** — a high-capability LLM (genius tier) that acts as an impartial judge.

### Inputs to the Vague Specs Checker

1. **Feature specification** — Contents of `specification.md` (and shotgun spec files)
2. **Failing test details** — From results.xml (JUnit XML report): test names, descriptions, failure messages

The Vague Specs Checker does _not_ receive the implementation patch (git diff). Agent-controlled content would enable prompt-injection attacks to bias spec updates away from user intent.

### Vague Specs Checker Output (JSON)

```json
{
  "isAmbiguous": boolean,
  "reason": "1–3 sentences explaining the verdict",
  "proposedSpecAddition": "Clarification to append to the spec (if ambiguous)",
  "sanitizedHintForAgent": "Behavioral hint for genuine failures (never reveals test internals)"
}
```

### Decision Criteria

- **`isAmbiguous: false`** — The spec explicitly or strongly implies the expected behavior. The implementation agent made a mistake. The Vague Specs Checker provides a `sanitizedHintForAgent` that describes _what_ is wrong in behavioral terms (e.g. "The command exits with code 1 when no arguments are provided, but should exit with code 0") without quoting hidden test code.
- **`isAmbiguous: true`** — The expected behavior is nowhere in the spec, or it requires interpretation a reasonable engineer could make differently. The test is unfair. The Vague Specs Checker proposes a `proposedSpecAddition` to append to the spec.
- **When in doubt** — The Vague Specs Checker leans toward ambiguous spec; it flags ambiguity when there is uncertainty, favoring spec improvement over blaming the agent.

### Holdout Protection

The Vague Specs Checker never leaks holdout test details to the implementation agent. The `sanitizedHintForAgent` describes the _observed_ problem (wrong exit code, wrong output shape) in abstract terms, not the literal assertions from the hidden tests.

---

## Resolution Modes

The `--resolve-ambiguity` flag controls how the orchestrator handles tests failures. It applies to `saifctl feat run` and `saifctl run start`.

| Mode       | Flag                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **off**    | `--resolve-ambiguity off`          | Vague Specs Checker is disabled. On any failure, the agent receives a generic message ("An external consumer encountered unexpected behavior..."). No ambiguity check. Holdout protection: no specific feedback.                                                                                                                                                                                                                        |
| **prompt** | `--resolve-ambiguity prompt`       | Vague Specs Checker runs on every failure. If ambiguity is detected, the orchestrator **pauses**, shows the Vague Specs Checker's reasoning and suggestion, and asks the human: _"What is the correct behavior?"_ The human's answer (not the Vague Specs Checker's) is appended to `specification.md`, tests are regenerated, and the attempt counter is reset. If the human skips, treats as genuine failure and uses sanitized hint. |
| **ai**     | `--resolve-ambiguity ai` (default) | Vague Specs Checker runs on every failure. If ambiguity is detected, the orchestrator **automatically** appends the proposed clarification to `specification.md`, re-runs the Black Box Design pipeline (Tests Planner + Tests Catalog), regenerates `runner.spec.ts`, resets the attempt counter, and continues the loop — all without human input. Fully autonomous.                                                                  |

### Mode Comparison

| Aspect                          | off                                                | prompt                                      | ai                                      |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| Vague Specs Checker invoked     | No                                                 | Yes                                         | Yes                                     |
| Human intervention on ambiguity | N/A                                                | Required                                    | None                                    |
| Feedback on genuine failure     | Generic only                                       | Sanitized hint from Vague Specs Checker     | Sanitized hint from Vague Specs Checker |
| Spec auto-updated               | No                                                 | Only if human accepts                       | Yes                                     |
| Autonomous operation            | Yes (but may fail indefinitely on ambiguous specs) | No (blocks on ambiguity)                    | Yes                                     |
| Use case                        | Debugging, or when you want no spec drift          | Review every ambiguity before changing spec | Production; fully hands-off factory     |

---

## Flow: What Happens When Tests Fail

```
Tests FAILED
       │
       ▼
┌─────────────────────────────────────────┐
│ resolveAmbiguity === 'off' ?             │
└─────────────────────────────────────────┘
       │                    │
       │ Yes                │ No (prompt or ai)
       ▼                    ▼
┌─────────────────┐   ┌─────────────────────────────────────────┐
│ Generic message │   │ Run Vague Specs Checker (spec + failures)     │
│ No Vague Specs Checker│   └─────────────────────────────────────────┘
└─────────────────┘                      │
       │                                 ▼
       │                    ┌───────────────────────────────────┐
       │                    │ Vague Specs Checker says isAmbiguous?   │
       │                    └───────────────────────────────────┘
       │                                 │
       │                    No (genuine) │          Yes
       │                                 ▼          ▼
       │                    ┌────────────────┐  ┌──────────────────────┐
       │                    │ Use sanitized  │  │ prompt mode?         │
       │                    │ hint as        │  │ Ask human to confirm │
       │                    │ errorFeedback  │  └──────────────────────┘
       │                    └────────────────┘          │
       │                                 │       Accept │ Decline
       │                                 │          ▼    ▼
       │                                 │  ┌─────────┐ ┌─────────────┐
       │                                 │  │ Append  │ │ Use hint;   │
       │                                 │  │ to spec │ │ treat as    │
       │                                 │  │ Re-run  │ │ genuine     │
       │                                 │  │ design  │ └─────────────┘
       │                                 │  │ Reset   │
       │                                 │  │ attempts│
       │                                 │  └─────────┘
       │                                 │       (ai: same path, no prompt)
       ▼                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Reset sandbox (git reset --hard, git clean -fd)                 │
│ Continue loop with errorFeedback                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configuration

**CLI flag:** `--resolve-ambiguity <off|prompt|ai>`

**Default:** `ai`

**Example:**

```bash
saifctl feat run                    # ai (default)
saifctl feat run --resolve-ambiguity prompt
saifctl feat run --resolve-ambiguity off
```

---

## Spec Updates (ai / prompt accept)

When the Vague Specs Checker resolves ambiguity, it appends a block to `specification.md`:

```markdown
<!-- Vague Specs Checker clarification (auto-added) -->

The greet command MUST output the name passed as an argument, e.g. "Hello, Alice".
```

The full Black Box Design pipeline is then re-run:

1. **Tests Planner** — Re-reads the updated spec, produces a new tests.md
2. **Tests Catalog** — Produces a new tests.json
3. **generateTests** — Regenerates runner.spec.ts from tests.json

The sandbox's `tests.full.json` (public + hidden) is rebuilt from the updated catalog. The attempt counter is reset to 0 so the implementation agent gets a fresh start with the clarified spec.

---

## Security & Integrity

- **No test leakage:** The Vague Specs Checker runs in the orchestrator process, which has access to results.xml (JUnit XML). It never passes raw test assertions to OpenHands. The `sanitizedHintForAgent` is behavioral, not literal.
- **Spec provenance:** Auto-added clarifications are wrapped in an HTML comment so humans can identify them during review.
- **Regeneration atomicity:** If `runDesignTests` fails after appending to the spec, the orchestrator treats the failure as genuine and does not reset the attempt counter. The spec change remains; the next iteration will use it.
