# Software Factory Component B: Black Box Testing

## What is the Black Box Testing Agent?

The **Black Box Testing Agent** is a custom Mastra worker within our AI-Driven Software Factory. Professionally this role is known as SDET (Software Development Engineer in Test). It acts as the critical bridge between the Specification Layer (OpenSpec + Shotgun) and the Factory Floor (The Convergence Loop).

Its sole responsibility is translating human intent and technical plans into **executable, failing black-box tests**.

## Input: The Spec Dir

The black box testing agent reads the entire spec directory for a feature (e.g. `openspec/features/<name>/`). This WILL contain:

- `proposal.md` — Human PM requirements

It may contain Shotgun-generated spec files (written directly into the feature dir):

- `specification.md` — Requirements, architecture, acceptance criteria
- `plan.md` — Implementation plan with stages and success criteria
- `research.md` — Research findings (and `research/` subdir if present)

It prepares an **exhaustive** list of test cases, then implements them as executable black-box tests.

---

## How it Works: Two-Phase Workflow

The black box testing agent uses a **two-phase** approach validated by recent research: design first, implement second. This enables easier human review and traceability.

### Phase 1: Test Case Design (`saifctl feat design <feature>`)

**Cost & duration:** The full planning workflow (Shotgun spec gen + tests design + tests write) costs ~$1 and takes 1–2 min on Sonnet 4.6.

**Input:** All files in the spec dir.

**Output:** A structured **Test Catalog** (JSON) describing every test case to run.

To solve for the LLM's context limits when dealing with complex specs, this phase is split internally into two steps:

- **1a. Markdown Plan (Tests Planner):** The agent reads the specs and outputs a plain Markdown list of everything that should be tested (`tests.md`). This acts as a "Chain of Thought" scratchpad.
- **1b. JSON Generation (Tests Catalog):** The agent receives the Markdown plan and expands it into the strict JSON schema (`tests.json`), assigning `visibility` (public/hidden).

**Design techniques applied:**

- **Equivalence partitioning** — Representative inputs from each equivalence class
- **Boundary value analysis** — Min/max, off-by-one, empty string, zero
- **State transitions** — Create → verify → update → delete flows
- **Failure modes** — 4xx, 5xx, validation errors, unauthorized access, malformed payloads

Each test case MUST **trace back** to a specific success criterion or acceptance criterion in `plan.md` or `specification.md`.

### Human Review Gate (The "Back and Forth")

A human reviews `tests.json` in their IDE before Phase 2 runs. If it's incomplete, the user can iterate:

1. **Agentic Iteration:** Edit `tests.json` manually in your IDE, or add `--prompt` support to `saifctl feat design` to refine the catalog.
2. **Manual/IDE Iteration:** The user can use standard IDE tools (like Cursor's inline chat) to modify the JSON directly.

### Phase 2: Test Implementation (runs automatically after Phase 1 in `saifctl feat design`)

**Input:** The Test Catalog (`tests.json`) from Phase 1.

**Output:** Runnable test files written to `openspec/features/<feature-name>/tests/`.

#### Test Styles

Each test case in `tests.json` points to a `.spec.ts` file relative to `tests/`. Phase 2 writes:

- `helpers.ts` — shared transport helpers (`execSidecar`, `httpRequest`, `baseUrl`)
- `infra.spec.ts` — sidecar health checks (CLI containers only)
- AI-generated `.spec.ts` files in `public/` and `hidden/` for each `entrypoint`, with full implementations

The AI agent writes complete test implementations using full imperative TypeScript. An SDET may refine or extend these as needed. This enables complex logic: multi-step flows, external data fetching, stateful assertions, and Playwright browser interactions.

Tests always communicate via **HTTP**:

- **Web server:** Hit endpoints directly (GET, POST, etc.).
- **Non-web (CLI, scripts):** The staging container runs an **HTTP Sidecar** that accepts commands (e.g. `{ "cmd": "pnpm run greeting" }`), executes them in the container, and returns `stdout`, `stderr`, and exit code. Tests POST to the sidecar and assert on the response.

---

## WHY We Are Using It

In a fully autonomous Software Factory, there are no humans reviewing the AI's code for logic errors on every iteration. **The tests are the only source of truth.**

- **Eliminating "Vibe Coding":** Without tests, we have no programmatic way to verify the Coder Agent actually completed the work.
- **Preventing Hallucination Cascades:** An executable test is an objective `true/false` signal; an LLM "reviewer" can hallucinate agreement.
- **Enabling the Loop:** The Convergence Loop requires a rigid target. The black box testing agent defines that target.

---

## Defining the Black-Box Interface

All tests must use a **serialization layer** over HTTP. No shared memory, no `docker exec`, no white-box mocks.

| System Type             | How We Test                                        | Serialization Layer                                 |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------- |
| **Web server**          | HTTP requests to endpoints                         | JSON response, status code                          |
| **CLI / non-web**       | POST commands to HTTP Sidecar in staging container | Sidecar returns `{ stdout, stderr, exitCode }`      |
| **Backend API with DB** | HTTP to API + DB verification                      | JSON response + query ephemeral DB for side effects |

### Database and External Dependencies

When the system under test involves a database or other external services:

- **Spin up ephemeral containers** (Digital Twin) — e.g. PostgreSQL, Redis — alongside the staging container. Prefer real infrastructure over mocks.
- **Verify side effects** — e.g. after `POST /api/user`, assert that a user row exists in the DB with the expected fields.
- Phase 1 enumerates **DB assertions** (which table, which columns, expected values). Phase 2 implements the actual queries.

---

## Sidecar Communication: Request and Response

The Test Runner sends HTTP requests to the sidecar running inside the staging container. The sidecar executes the command and returns the result.

### Request Format

`POST` to `http://<test-host>:<sidecarPort><sidecarPath>` (e.g. `http://saifctl-stage-abc123:8080/exec`):

```json
{
  "cmd": "pnpm run greeting",
  "args": ["--help"],
  "env": { "GREETING": "Hi" }
}
```

- **cmd** (required): The command to run in the staging container (e.g. `pnpm run greeting`, `node dist/cli.js greeting`).
- **args** (optional): Array of CLI arguments (e.g. `["--help"]`, `["--invalid"]`). The sidecar concatenates these to the command.
- **env** (optional): Additional environment variables to set for this run. Merged with the container's existing env.

### Response Format

The sidecar returns `200 OK` with JSON:

```json
{
  "stdout": "Hello\n",
  "stderr": "",
  "exitCode": 0
}
```

- **stdout**: Captured stdout from the command.
- **stderr**: Captured stderr from the command.
- **exitCode**: Process exit code (0 = success, non-zero = failure).

### Example: Vitest Test That Uses the Sidecar

This test sends a request to run `pnpm run greeting` in the staging container and asserts on the returned output:

```typescript
import { describe, it, expect } from 'vitest';

// Orchestrator injects SAIFCTL_TARGET_URL (e.g. http://staging:8080/exec for sidecar, http://staging:3000 for web)
const TARGET_URL = process.env.SAIFCTL_TARGET_URL ?? 'http://localhost:8080/exec';

async function execInAgent(cmd: string, args: string[] = [], env: Record<string, string> = {}) {
  const res = await fetch(TARGET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args, env }),
  });
  if (!res.ok) throw new Error(`Sidecar request failed: ${res.status}`);
  return res.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

describe('greeting command (via sidecar)', () => {
  it('default greeting when GREETING not set', async () => {
    const { stdout, stderr, exitCode } = await execInAgent('pnpm run greeting', []);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('Hello\n');
    expect(stderr).toBe('');
  });

  it('custom greeting from GREETING env', async () => {
    const { stdout, stderr, exitCode } = await execInAgent('pnpm run greeting', [], {
      GREETING: 'Hi',
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe('Hi\n');
    expect(stderr).toBe('');
  });

  it('invalid option exits 1', async () => {
    const { stdout, stderr, exitCode } = await execInAgent('pnpm run greeting', ['--invalid']);

    expect(exitCode).toBe(1);
    // stdout/stderr may contain error message; we only assert exit code
  });
});
```

The Orchestrator injects `SAIFCTL_TARGET_URL` into the Test Runner container (e.g. `http://staging:8080/exec` for the sidecar, or `http://staging:3000` for a web server). Tests read `process.env.SAIFCTL_TARGET_URL`. For local development without the Orchestrator, fall back to `http://localhost:8080/exec`.

---

## JSON Schema: Test Catalog

The Phase 1 output is a JSON object compatible with `generateObject` and similar structured-generation tools.

### Test Catalog (Root)

`tests.json` defines test cases only. Infrastructure (sidecarPort, sidecarPath, baseUrl, build, additional containers) comes from `saifctl/config.ts` `environments.staging`. See [Environments and Infrastructure](../../services.md) for a user guide; [Software Factory Services](./swf-services.md) for the architecture.

For a CLI application, `tests.json` looks like this:

```json
{
  "version": "1.0",
  "featureName": "shotgun-test",
  "specDir": "openspec/features/shotgun-test",
  "testCases": []
}
```

For a web API with a database, you would configure the infrastructure in `saifctl/config.ts`:

```typescript
// saifctl/config.ts
export default {
  environments: {
    staging: {
      engine: 'docker',
      // This compose file would define your postgres container
      file: './docker-compose.test.yml',
      app: {
        baseUrl: 'http://staging:3000',
        sidecarPort: 8080,
        sidecarPath: '/exec',
      },
    },
  },
};
```

And the `tests.json` remains strictly focused on the test cases:

```json
{
  "version": "1.0",
  "featureName": "add-user-api",
  "specDir": "openspec/features/add-user-api",
  "testCases": []
}
```

### Test Case (Single Entry)

```json
{
  "id": "tc-greeting-001",
  "title": "Default greeting when GREETING not set",
  "description": "Running greeting with no env var outputs Hello",
  "tracesTo": ["plan.md Stage 1 Success Criterion 2"],
  "category": "happy_path",
  "interface": "sidecar",
  "visibility": "public",
  "env": {},
  "input": {
    "cmd": "pnpm run greeting",
    "args": []
  },
  "expected": {
    "exitCode": 0,
    "stdout": "Hello\n",
    "stderr": "",
    "statusCode": null,
    "body": null
  },
  "dbAssertions": null,
  "dependsOn": [],
  "runOrder": 1
}
```

For an HTTP API test with DB verification:

```json
{
  "id": "tc-user-001",
  "title": "POST /api/user creates user in database",
  "description": "Valid user payload creates row and returns 201",
  "tracesTo": ["specification.md Acceptance Criterion 1"],
  "category": "happy_path",
  "interface": "http",
  "visibility": "public",
  "env": {},
  "input": {
    "method": "POST",
    "path": "/api/user",
    "headers": { "Content-Type": "application/json" },
    "body": { "email": "test@example.com", "name": "Test User" }
  },
  "expected": {
    "exitCode": null,
    "stdout": null,
    "stderr": null,
    "statusCode": 201,
    "body": {
      "id": "{{uuid}}",
      "email": "test@example.com",
      "name": "Test User"
    }
  },
  "dbAssertions": [
    {
      "query": "SELECT id, email, name, created_at FROM users WHERE email = $1",
      "params": ["test@example.com"],
      "assert": "exactlyOne",
      "columns": {
        "email": "test@example.com",
        "name": "Test User"
      }
    }
  ],
  "dependsOn": [],
  "runOrder": 1
}
```

### Categories and Interface Types

- **category:** `"happy_path"` | `"boundary"` | `"negative"` | `"error_handling"`
- **interface:** `"sidecar"` | `"http"`
- **tracesTo:** Array of strings referencing plan/spec sections for traceability
- **visibility:** `"public"` | `"hidden"` — see [Public vs Holdout Split](#public-vs-holdout-split) below.

---

## Public vs Holdout Split

Phase 1 assigns each test case a **visibility** of `"public"` or `"hidden"`. The Orchestrator gives public tests to the Coder Agent for debugging; it keeps hidden tests for Mutual Verification and runs them only after the agent claims success.

### Reasoning

- **Public tests** tell the agent _what_ to build (architecture, interfaces, success criteria).
- **Hidden (holdout) tests** verify the agent built real logic instead of hardcoding answers to pass public tests. If all tests were public, the agent could `if input === "Alice" return "Alice"`; a holdout with a different input catches that.

### Split Criteria

**Public (visible to Coder Agent):**

- **Core happy path** — Standard, expected use cases (e.g. `POST /api/user` with valid payload returns 201).
- **Setup/teardown** — Basic state transitions so the agent understands how DB/state must mutate.
- **Explicit spec requirements** — If the PM/spec says "must return 400 on missing email," a public test ensures the agent knows to implement it.

**Hidden (holdout, for Mutual Verification only):**

- **Isomorphic variations** — Same behavior, different data (e.g. public creates user "Alice", holdout creates "Bob"). Prevents hardcoding `return { name: "Alice" }`.
- **Boundary / edge cases** — Min/max, off-by-one, empty string, null, zero.
- **Negative / security paths** — Invalid formats, unauthorized access, wrong HTTP methods.
- **Complex state mutations** — Multi-step flows too complex to fake with in-memory mocks.

The human reviewer validates the split in Phase 1 before Phase 2 generates the test code.

---

## Example: Greeting CLI Test Catalog

For the greeting command (`openspec/features/shotgun-test/`):

```json
{
  "version": "1.0",
  "featureName": "shotgun-test",
  "specDir": "openspec/features/shotgun-test",
  "testCases": [
    {
      "id": "tc-greeting-001",
      "title": "Default greeting when GREETING not set",
      "description": "Outputs Hello to stdout",
      "tracesTo": ["plan.md Success Criterion 2"],
      "category": "happy_path",
      "interface": "sidecar",
      "visibility": "public",
      "env": {},
      "input": { "cmd": "pnpm run greeting", "args": [] },
      "expected": {
        "exitCode": 0,
        "stdout": "Hello\n",
        "stderr": "",
        "statusCode": null,
        "body": null
      },
      "dbAssertions": null,
      "dependsOn": [],
      "runOrder": 1
    },
    {
      "id": "tc-greeting-002",
      "title": "Custom greeting from GREETING env",
      "description": "GREETING=Hi outputs Hi",
      "tracesTo": ["plan.md Success Criterion 3"],
      "category": "happy_path",
      "interface": "sidecar",
      "visibility": "public",
      "env": { "GREETING": "Hi" },
      "input": { "cmd": "pnpm run greeting", "args": [] },
      "expected": {
        "exitCode": 0,
        "stdout": "Hi\n",
        "stderr": "",
        "statusCode": null,
        "body": null
      },
      "dbAssertions": null,
      "dependsOn": [],
      "runOrder": 2
    },
    {
      "id": "tc-greeting-003",
      "title": "Empty GREETING uses default",
      "description": "GREETING= empty should fall back to Hello",
      "tracesTo": ["specification.md Apply Defaults"],
      "category": "boundary",
      "interface": "sidecar",
      "visibility": "hidden",
      "env": { "GREETING": "" },
      "input": { "cmd": "pnpm run greeting", "args": [] },
      "expected": {
        "exitCode": 0,
        "stdout": "Hello\n",
        "stderr": "",
        "statusCode": null,
        "body": null
      },
      "dbAssertions": null,
      "dependsOn": [],
      "runOrder": 3
    },
    {
      "id": "tc-greeting-004",
      "title": "Help flag displays usage and exits 0",
      "description": "pnpm run greeting --help",
      "tracesTo": ["plan.md Success Criterion 4"],
      "category": "happy_path",
      "interface": "sidecar",
      "visibility": "public",
      "env": {},
      "input": { "cmd": "pnpm run greeting", "args": ["--help"] },
      "expected": {
        "exitCode": 0,
        "stdout": "Usage:",
        "stderr": "",
        "statusCode": null,
        "body": null
      },
      "dbAssertions": null,
      "dependsOn": [],
      "runOrder": 4
    },
    {
      "id": "tc-greeting-005",
      "title": "Invalid option exits 1",
      "description": "Unknown flag causes exit code 1",
      "tracesTo": ["plan.md Success Criterion 5"],
      "category": "negative",
      "interface": "sidecar",
      "visibility": "hidden",
      "env": {},
      "input": { "cmd": "pnpm run greeting", "args": ["--invalid"] },
      "expected": {
        "exitCode": 1,
        "stdout": null,
        "stderr": null,
        "statusCode": null,
        "body": null
      },
      "dbAssertions": null,
      "dependsOn": [],
      "runOrder": 5
    }
  ]
}
```

---

## Fail2Pass Validation and Holdout Set

Before the Coder Agent starts, the black box testing agent runs the generated tests against the _current_ `main` branch:

- **At least one feature test must fail.** If all feature tests pass, the loop rejects the task (feature already exists or tests are invalid).
- **Partial overlap is expected.** The desired state (what the tests describe) may partially overlap with the current state. For example, negative-path tests (e.g. "invalid option exits 1") often pass on `main` before any implementation. That is fine — fail2pass only requires that some feature tests fail, proving the tests exercise something unimplemented.
- **Holdout Set:** Each test case in the Phase 1 catalog has `visibility: "public"` or `"visibility": "hidden"`. The Orchestrator uses this field to split:
  - **Public tests** — Given to the Coder Agent for debugging.
  - **Hidden tests** — Kept for Mutual Verification. When the agent claims success, the Orchestrator runs only the hidden set against a clean checkout with the patch applied.

---

## The Workflow / Pipeline Context

1. **Human PM:** Writes `proposal.md` via OpenSpec.
2. **Shotgun:** Outputs grounded `plan.md`, `specification.md`, etc. into the feature dir.
3. **Black box testing Phase 1:** Reads spec dir, emits Test Catalog (JSON).
4. **Human Review:** Reviews Test Catalog; approves or requests changes.
5. **Black box testing Phase 2:** Implements test files from catalog (Vitest/Jest/Playwright).
6. **Fail2Pass:** Run tests against `main`; at least one feature test must fail (partial overlap OK).
7. **Handoff:** Failing tests + `plan.md` go to Coder Agent.
8. **Convergence Loop:** Coder iterates until tests pass. On each tests failure, the **Vague Specs Checker** (default: ai) runs to distinguish spec ambiguity from genuine errors—if ambiguous, updates spec and regenerates tests; otherwise feeds back a sanitized hint. See [swf-spec-ambiguity.md](swf-spec-ambiguity.md).
9. **Mutual Verification:** Orchestrator runs holdout tests; if pass, apply patch and open PR.

### Commands (in order)

| Step | Command                                                    | Purpose                                                                                     |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --- |
| 0    | `saifctl init`                                              | One-time: OpenSpec + Shotgun config + codebase index                                        |
| 1    | `saifctl feat new`                                          | Create feature, optionally write `proposal.md`                                              |
| 2    | (Edit `proposal.md` / spec dir as needed)                  | Human refines proposal before design                                                        |
| 3    | [`saifctl feat design`](feat-design.md)                     | Generate specs and tests from a feature's proposal (full design workflow)                   |
| —    | [`saifctl feat design-specs`](feat-design-specs.md)         | Generate specs from a features's proposal only (first step of design).                      |
| —    | [`saifctl feat design-tests`](feat-design-tests.md)         | Generate tests from existing specs (second step of design).                                 |     |
| 5    | [`saifctl feat design-fail2pass`](feat-design-fail2pass.md) | Run tests against main; at least one feature test must fail (third step of design workflow) |
| 6    | `saifctl feat run`                                          | Start an agent to implement the specs. Runs until it passes your tests.                     |
| 7    | (PR merged to main)                                        | Human or automation                                                                         |
| —    | `saifctl cache list`                                        | List sandbox dirs for this project (`--all`: all projects)                                  |
| —    | `saifctl cache clear`                                       | Remove sandbox entries for this project (`--all`: everything)                               |

---

## Why Black-Box over Unit Tests

White-box unit tests are unsafe for autonomous agent loops:

- The agent can mock internals, rewrite assertions, or return hardcoded values.
- Black-box tests run from outside the staging container over HTTP. The agent cannot mock the test runner or the network. It must build real behavior to pass.
