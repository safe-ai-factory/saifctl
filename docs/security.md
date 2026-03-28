# Security & Isolation

When you run agents in an autonomous loop, they will eventually try to cheat to get a green light. If an AI can hack your system, it will.

`safe-ai-factory` (SaifCTL) is built around a **zero-trust** architecture. The coding agent's container is considered unsafe. Any code it generates is considered unsafe.

SaifCTL enforces multiple layers of security to ensure the agent physically cannot cheat, reward-hack, or break out of its sandbox.

## The Ironclad Guarantee

- **The AI builds _exactly_ what you asked for.** It is locked in a loop and physically cannot stop until your new TDD tests pass.
- **The AI can't break previously-built features.** All features built with SaifCTL are protected by tests. AI can't break or change them. Regressions are mechanically impossible.
- **The AI breaks _nothing_ on your machine.** It runs in a zero-trust, sandboxed Docker environment. Your existing codebase is untouchable until you approve the final, pristine PR.

## Five Degrees of Security

Autonomous agents looping 50 times on your codebase are dangerous by default. Five independent boundaries ensure a runaway agent is contained:

1. **Docker isolation - the agent never touches your host:**
   - The coder agent runs inside a Docker sandbox.
   - Your codebase is copied. Your secrets and `.git` folder are completely hidden.

2. **Control network and filesystem access:**
   - Every access request is intercepted using [Leash](https://github.com/strongdm/leash).
   - We define strict [Cedar](https://www.cedarpolicy.com/) policies to restrict access (e.g., blocking outbound network calls to prevent data exfiltration).

3. **Memory and process isolation — the coder container is untrusted:**
   - We don't run any code directly in the Agent's container.
   - The Agent's work is extracted as a `git diff` — a plain text file.
   - Unsafe changes (e.g. modifications to tests) are stripped from the git diff before processing.

4. **Black-box testing over HTTP:**
   - Verification runs in a completely separate, fresh test container.
   - There is no shared memory and no Docker socket access between the coder and the test runner.
   - Tests happen over HTTP requests. The agent cannot tamper with the test runner's OS.

5. **Fresh container per iteration (The Ralph Wiggum Loop):**
   - Containers (and auxiliary services like databases/caches) are destroyed after every single cycle.
   - The agent's memory is wiped clean. The only shared state between iterations is the **git diff** from previous iteration.
   - This prevents "context rot" and ensures the agent cannot stash malicious backdoors in the environment.

## No Reward Hacking: The Hidden Tests Tenet

To ensure the AI cannot short-circuit or fake an implementation, it must never see the full test suite. We enforce this by keeping a subset of tests strictly **hidden** from the AI.

**The Golden Rule:** The AI must NEVER see hidden tests.

If the agent can see the tests, it will write code that perfectly hardcodes the expected responses, bypassing the actual implementation. SaifCTL prevents this entirely:

1. **Physical Separation:** Hidden tests are NEVER copied into the coding agent's container. Only public tests are available.
2. **No Git History:** The agent does not have git access to the original repo, nor access to git history. It cannot `git checkout` to look for answers.
3. **Public Repo Protection:** If you are working in a public repository, hidden tests are encrypted before being committed, ensuring they stay hidden from plain view on GitHub. They are decrypted securely inside the isolated test runner.
4. **Filesystem Leash:** Even if the agent tried to guess the path to the test folders, Leash policies forbid it from modifying or reading restricted files.
5. **Prompt Injection Defense:** Agent receives feedback about what failed. We avoid exposing the test details by letting another AI summarise the failure(s). The summarizer receives only safe metadata. The agent controls none of this input, so it cannot prompt-inject the summarizer.

## Auditability

Every action the agent takes is logged. Leash logs every file read, file write, and network access attempt.

You can audit the agent's behavior locally via the Leash dashboard at `http://localhost:18080`.
