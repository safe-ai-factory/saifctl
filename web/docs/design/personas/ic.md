# Persona: The Individual Contributor (IC) / Senior Engineer

## 1. Profile & Perspective

The IC is the day-to-day user of the codebase. They are the ones actually writing, reviewing, and debugging the code. They are highly skilled, value their time, and are extremely protective of their "flow state." They have likely tried AI coding tools before (like Copilot or Cursor) and appreciate them for boilerplate, but they are deeply skeptical of "autonomous agents" that promise to do their whole job, mostly because they've had to clean up the mess those agents leave behind.

**Core Philosophy:** "My job isn't typing; my job is solving complex architectural problems and ensuring the system doesn't break. I want tools that remove the typing so I can focus on the thinking, but I _must_ remain in control."

## 2. Core Wants & Desires

- **Flow State & Focus:** They want to hand off the tedious, well-defined tasks (CRUD endpoints, simple migrations, standard bug fixes) so they can focus on the interesting, high-leverage architectural work.
- **Trust & Reliability:** If they delegate a task to an AI, they need to know it will actually work, not just _look_ like it works. They don't want to spend 4 hours debugging AI-generated spaghetti code.
- **Seamless Integration:** The tool must fit into their existing workflows (IDE, git, PR reviews). It cannot require them to learn a massive new DSL or change how they fundamentally think about building software.
- **Visibility & Control:** When things go wrong (and they will), the IC needs to be able to jump in instantly, see exactly what the AI was doing, and correct the course without fighting the tool.

## 3. Deep-Seated Fears & Objections

- **The "Opaque Magic Box" Fear:** "The AI failed after 20 minutes of spinning, and I have no idea why. Now I have to start over from scratch."
- **The "Spaghetti Code" Fear:** "The AI wrote 500 lines of code that technically passes the tests, but it fails our strict linting rules, breaks typescript, and I have to spend an hour fixing syntax errors before I can even review the logic."
- **The "Chore" Objection:** "You want me to write a 3-page specification document and a full test suite just so your 'autonomous' agent can write 10 lines of SQL? I could have just written the SQL myself in 5 minutes using Cursor. This is slower."
- **The "Loss of Agency" Fear:** "If I don't write the code, I won't understand how the system works when it inevitably breaks in production."

## 4. How SAIFAC Addresses the Persona (The IC Value Proposition)

### Addressing Fears & Objections

| The Fear                                                | The SAIFAC Solution                                                                                                                                                                                                                                                                                                                                                                                                       |
| :------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Writing specs is a chore"**                          | **Modular, file-system specs.** You don't write a 10-page monolithic doc. You break features down logically (e.g., `rest/routes/account/post/`). SAIFAC treats specs like code - hierarchical, composable, and easy to refactor by simply deleting a directory. It forces you to do the hard cognitive work (edge cases, contracts) upfront, but makes managing that complexity trivial.                                  |
| **"I don't trust the AI's code"**                       | **You don't have to trust the coding agent. SAIFAC makes it nearly impossible to cheat.** Your tests are hidden from the coding agent — it can't fake a passing by changing the tests. When the tests fail, the agent fixes the code and tries again. You only see a PR when the code actually passes.                                                                                                                    |
| **"I hate doing tedious code reviews for AI"**          | **The Automated Gauntlet.** SAIFAC PRs never reach you until they survive a brutal, multi-stage gauntlet. First, the `--gate-script` forces the agent to pass your custom linters, typecheckers, and coverage checks. Second, an adversarial 'Semantic AI Reviewer' analyzes the diff to ensure it actually solves the spec without hacking the tests. You only review code that has already survived peer review and CI. |
| **"The AI got stuck and I'm blocked"**                  | **`saifac run debug` (The IDE Time Machine).** When the agent fails, SAIFAC doesn't just spit out a terminal error. You can instantly boot up the agent's exact state in a VSCode Remote Container. You step into its brain, fix the typo, and hit resume.                                                                                                                                                                  |
| **"I hate managing AI prompts"**                        | **`saifac run review` (Asynchronous Management).** Manage the AI exactly like you manage a junior developer. SAIFAC opens a PR. You review the code and leave standard GitHub comments ("Handle the null state here"). SAIFAC parses your comments and resumes the loop.                                                                                                                                                      |
| **"I'll lose my agency / understanding of the system"** | **The Hybrid Workflow.** SAIFAC is an asynchronous worker, not an IDE replacement. It tackles the bounded tickets while you use Cursor/Copilot for interactive, high-agency coding. You maintain total architectural oversight through the `specification.md` review and the final PR review, ensuring you understand exactly _what_ was built and _why_.                                                                 |

### Fulfilling Wants & Desires

| The Desire               | How SAIFAC Delivers                                                                                                                                                                                                                                                                                                                                   |
| :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flow State & Focus**   | SAIFAC acts as an asynchronous background worker. You hand off the ticket, and SAIFAC handles the tedious loop of writing, testing, failing, and fixing. You stay in your editor doing high-leverage work while SAIFAC grinds through the backlog.                                                                                                        |
| **Trust & Reliability**  | By physically separating the "Test Writer" (the Spec Agent) from the "Code Writer" (the Coder Agent), and evaluating the code via an execution sandbox (holdout tests), SAIFAC guarantees that a completed run actually works. **Crucially, the IC retains full visibility to review, edit, or extend the test suite before the factory run begins.** |
| **Seamless Integration** | You don't leave your ecosystem. You initiate work via CLI (`saifac run`), you review specs in Markdown, you debug in VSCode (`saifac run debug`), and you provide feedback via GitHub PR comments (`saifac run review`). The learning curve is practically zero.                                                                                          |
| **Visibility & Control** | Every step of the pipeline generates human-readable artifacts (`proposal.md`, `specification.md`, `tests.json`, the final PR). SAIFAC is not a black box; it's a glass pipeline. You can inspect, edit, or override any artifact at any time before the next step begins.                                                                             |

## 5. Ideal Workflow & Interactions

The IC's interaction with SAIFAC should feel like delegating to a highly competent, albeit literal-minded, junior developer.

1.  **Initiation (Proposal):**
    - The IC creates a thorough `proposal.md` — thinking through edge cases, how parts interact, and the hard cognitive tasks — or assigns a Jira ticket to the SAIFAC system.
    - _Interaction:_ CLI (`saifac plan`) or Web UI.
2.  **The Review (Alignment):**
    - SAIFAC generates the enriched `specification.md` and the `tests.json` plan.
    - The IC scrutinizes the spec to ensure the AI understood the intent — reviewing a plain-English spec takes minutes; debugging a 500-line spaghetti PR takes hours.
    - _Interaction:_ Reading markdown files, potentially making minor tweaks. The IC can also review, edit, or extend the hidden tests before the run begins.
3.  **The Factory Run (Delegation):**
    - The IC hits approve (`saifac run`). SAIFAC takes over, spinning up the sandbox, writing tests, and iterating on the implementation.
    - The IC goes back to doing higher-leverage work (or gets a coffee).
4.  **Intervention (If Needed):**
    - If SAIFAC hits a loop limit or gets stuck, the agent halts, but **preserves its exact state**. The IC isn't forced into an immediate context switch. When they are ready, they use `saifac run debug` to open a VSCode Remote Container, inspect the exact diff, provide a hint or fix a blocker, and hit resume.
5.  **The Final Approval (Merge):**
    - SAIFAC opens a PR. The IC reviews the final code. If changes are needed, they use `saifac run review` by leaving standard PR comments.
    - Once satisfied, they merge.

## 6. Implications for the README & Landing Page

When speaking to the IC on the landing page or in the README, the messaging must be **pragmatic, transparent, and focused on proof**.

- **Don't sell the dream, sell the telemetry:** Engineers reject marketing. We must give them the tools to prove it to themselves.
- **Weaponize `saifac prove`:** The hero hook shouldn't be "build faster." It should be a challenge: _"Don't trust us. Run `saifac prove --ticket=1234` on your ugliest closed ticket from last sprint and see what it would have done while you were getting coffee."_
- **Highlight the "Glass Pipeline" Artifact Trail:** The PR description is the product. Emphasize that SAIFAC generates a `saifac-run-log.md` showing every failed attempt, holdout test error, and agent self-correction. Show them the AI's "sweat" to build trust in the verification sandbox.
- **Emphasize bounded tasks (Trojan Horse strategy):** Lead with _specific types of work_ (well-defined tickets, migrations, standard features). Don't promise architecture invention—let users discover that ceiling themselves. Why?
  - **TDD/architecture paradox:** Specific tests imply the architecture; broad E2E tests give the agent too much freedom, so it may invent something that technically passes but clashes with team norms (wrong DB, wrong patterns).
  - **Stealing the fun:** ICs define themselves by solving architectural problems. Position SAIFAC as the builder of the pipes, not the designer of the boxes—or you threaten their identity.
  - **Unwritten rules:** Codebases have ghost constraints ("we don't use ORM cascades"; "we structure React this way for legacy webpack"). Specs can't capture them; frontier models don't know them.
  - **Under-promise, over-deliver:** If we promise architecture invention and one thing is off, the IC writes the tool off. If we promise solid bounded-task execution and they quietly try a big refactor that works, they feel like they found a superpower.
- **Position `debug` as an escape hatch:** Frame `saifac run debug` not as a chore, but as the ultimate async unblocker. "When other agents fail, they leave a broken terminal. SAIFAC saves the exact state so you can fix it in 60 seconds when you're ready."

---

## Reality check (feedback)

I love this concept. SAIFAC (Safe AI Factory) is positioning itself perfectly against the chaotic, "shoot from the hip" autonomous agents on the market. The "zero-trust, spec-driven" angle is incredibly strong.

However, as a seasoned marketer looking at this through the lens of a highly skeptical, pragmatic Senior IC, this persona document has some critical blind spots. We are drinking our own Kool-Aid a bit too much.

If we take this to market as-is, the IC is going to see right through the hype. Here is the devil's advocate teardown of the IC Persona document:

### 1. The "Spec without the slog" Fallacy

**The Claim:** "You provide a brain-dump (a rough proposal or Jira ticket). SAIFAC's Spec Agent does the heavy lifting to enrich it into a rigorous, engineering-ready specification based on your existing codebase context."

**The Teardown:**
Senior ICs know that the _hardest_ part of software engineering isn't writing the code; it's defining the edge cases, the API contracts, the failure modes, and the integration points.

- **The Garbage In / Garbage Out Problem:** If an IC provides a "rough proposal," the AI has to invent the missing constraints. How does the AI know the system's unwritten rules about state management or database query optimization?
- **The "Reviewing Specs is Harder than Writing Code" Problem:** Have you ever tried to read a 4-page, AI-generated technical spec to find the _one_ hallucinated assumption? It is excruciating. An IC would often rather just write the code themselves than audit an AI's attempt to guess their architectural intent.
- **The Reality Check:** We claim they do a "quick read-through... (a 2-minute task)." That is pure fiction for any non-trivial feature. If the spec is wrong, the tests are wrong, and the code is wrong. The IC _must_ scrutinize that spec heavily.

### 2. The "Provably Tested" Over-Promise

**The Claim:** "Because holdout tests evaluate code against hidden tests in a sandboxed environment... it is systematically proven to satisfy the requirements."

**The Teardown:**
This is marketing hyperbole that will immediately trigger an engineer's BS detector.

- **Tests Only Prove What They Test:** If the Spec Agent didn't anticipate a race condition, the tests won't check for it, and the code will pass the "strict TDD" pipeline while still breaking production. Passing tests does not equal "mathematically proven correctness" in complex systems. It just proves the code satisfies the _AI's interpretation_ of the spec.
- **The "Hidden Test" Catch-22:** We boast about hidden tests preventing the AI from cheating. But who verifies the _quality_ of the hidden tests? If the IC doesn't see them, how do they know the tests aren't overly brittle, testing implementation details rather than behavior, or missing crucial negative test cases? If they _do_ review them, that's another massive chore added to their plate.

### 3. The "IDE Time Machine" Friction

**The Claim:** "`saifac run debug`... You can instantly boot up the agent's exact state in a VSCode Remote Container. You step into its brain, fix the typo, and hit resume."

**The Teardown:**
This sounds amazing in theory, but consider the friction in practice:

- **The Context Switch is Brutal:** The IC is deep in the zone on Feature A. SAIFAC pings them that it failed on Feature B. Now the IC has to drop everything, spin up a remote container, figure out what the AI was trying to do, figure out _why_ it failed, fix the AI's mess, and then try to get back into their original flow state.
- **The "I Should Have Just Done It Myself" Moment:** If the IC has to jump into a debug container to fix a typo or a misunderstood dependency, they are going to immediately think, "I spent more time reviewing the spec and debugging the AI than it would have taken to just write this CRUD endpoint myself."

### 4. The "Asynchronous PR Review" Delusion

**The Claim:** "`saifac run review`... Manage the AI exactly like you manage a junior developer... leave standard GitHub comments... SAIFAC parses your comments and resumes the loop."

**The Teardown:**
Managing junior developers is _exhausting_.

- **The Communication Gap:** When an IC tells a junior dev, "Handle the null state here," the junior dev asks clarifying questions if they don't understand the surrounding architecture. If the AI misunderstands the comment, does it just confidently rewrite half the file incorrectly and open another PR?
- **The Latency Problem:** Asynchronous PR reviews with humans already take days. If the IC leaves a comment, does SAIFAC spin up a container, iterate for 20 minutes, and re-ping them? This creates a fragmented, stop-and-start feedback loop that many ICs hate. Sometimes, they just want to jump on a quick huddle to explain a concept—which they can't do with SAIFAC.

### 5. The "Seamless Integration" Paradox

**The Claim:** "The learning curve is practically zero. You don't leave your ecosystem."

**The Teardown:**
We are introducing a massive new paradigm: Spec-Driven Development via AI, containerized sandboxes, `tests.json` manifests, and a proprietary CLI tool (`saifac`).

- It is _not_ zero learning curve. The IC has to learn how to write "brain-dumps" that the Spec Agent actually understands. They have to learn how to trust an opaque testing system. They have to learn the commands and limits of the CLI.
- We are changing how they fundamentally think about building software (moving from imperative coding to declarative spec-writing). We should own that, not pretend it's seamless.

### How to Fix the Messaging (The Pivot)

To win over this persona, we need to dial back the "magic" and lean heavily into the **pragmatism and control**:

1.  **Drop "Mathematically Proven":** Replace it with **"Provably Tested."** Emphasize that SAIFAC prevents _regressions_ and _lazy AI code_ by enforcing a strict test boundary.
2.  **Acknowledge the Spec Burden:** Be honest. Tell them: "Yes, reviewing the spec takes effort. But reviewing a plain-English spec takes 5 minutes; debugging a 500-line spaghetti PR takes 5 hours. Shift the effort left."
3.  **Position `debug` as the Ultimate Escape Hatch, Not a Feature:** "When other agents fail, they leave you a broken terminal. SAIFAC gives you the exact state so you can unblock it in 60 seconds and get back to your real work."
4.  **Emphasize "Bounded Tasks":** Make it crystal clear that SAIFAC is for _specific types of work_ (well-defined tickets, migrations, standard features), not for inventing new architectures. Setting the right expectations prevents the "it couldn't build my entire app so it sucks" disappointment.

We have a killer product. We just need to make sure we don't sound like every other over-promising AI wrapper on the market. Let's speak to them like engineers, not like investors.

---

## Trust-building features

> Are there ways how we could potentially undeniably prove the usefulness of this tool to the IC? e.g. think benchmarks (but those are N/A for this scenario), or integrating with their org's github to compute their velocity before / after, or analytics of how they used the tool (e.g. how much time spent in specs; how much time spent in `debug`), etc?

This is exactly the right question to ask. If we are selling to highly skeptical Senior Engineers, we can't just _tell_ them it works; we have to give them the instruments to _prove_ it to themselves.

The trick here is that **IC metrics are fundamentally different from EM (Engineering Manager) metrics.** EMs want to see "Velocity" and "Story Points." If we show an IC a dashboard of their "Velocity," they will reject the tool as corporate surveillance.

To undeniably prove usefulness to the IC, the proof must be centered around **Relief, Leverage, and Flow**. Here are the most compelling, undeniable ways we can prove SAIFAC's value to the IC:

### 1. The "Shadow Run" (Personalized Historical Benchmarking)

You mentioned benchmarks are N/A, but _generalized_ benchmarks (like SWE-bench) are N/A. **Personalized benchmarks are the ultimate proof.**

- **The Mechanic:** When an IC installs SAIFAC, we give them a CLI command: `saifac prove --ticket=PROJ-1234`. The IC feeds SAIFAC a Jira ticket or GitHub issue they _already solved_ last month.
- **The Proof:** SAIFAC runs its Spec -> Test -> Code loop in the background and generates a PR. The IC can then side-by-side compare their human PR from a month ago with the SAIFAC PR.
- **Why it works:** It removes the "this only works on toy apps" objection. If SAIFAC can accurately solve a complex bug in _their actual monolithic codebase_, the IC will be instantly converted.

### 2. The "Grind vs. Glory" Dashboard (CLI Analytics)

We track how the IC uses the tool, but we frame the analytics entirely around **Time Reclaimed**. At the end of the week, the `saifac` CLI or VS Code extension shows a localized, private summary:

- **Time Spent in Spec/Review:** 14 minutes.
- **Time Spent in `saifac run debug`:** 4 minutes.
- **Agent Compute Time (Time you were unblocked):** 4 hours, 12 minutes.
- **The "Grind" Metric:** "SAIFAC wrote 412 lines of boilerplate and 84 assertions across 12 test files this week. You wrote 0."
- **Why it works:** It visually proves the asymmetric leverage. "I spent 18 minutes managing this thing, and it did 4 hours of tedious typing for me." It proves SAIFAC is a massive ROI on their time.

### 3. GitHub PR "Ping-Pong" Analytics (Quality Proof)

Senior ICs hate the "PR Ping-Pong" loop—where a PR goes back and forth 6 times for missing tests, lint errors, and edge cases. We can hook into the GitHub API to compute the "Cleanliness" of SAIFAC PRs vs. Human PRs.

- **The Metric:** Average Review Cycles per PR.
- **The Proof:** We show the IC that a typical human PR in their repo takes 3.2 review cycles to merge. SAIFAC PRs, because they are gated by the deterministic holdout tests and hidden tests, take 1.1 review cycles.
- **Why it works:** It proves the "Zero-Trust Verification" isn't a gimmick. It actually results in systematically cleaner code that gets approved faster, reducing the IC's cognitive load.

### 4. The "Glass Pipeline" Artifact Trail (Transparency as Proof)

The most undeniable proof that SAIFAC isn't a "dumb LLM wrapper" is showing the IC exactly _how_ it struggled and succeeded.

- **The Mechanic:** Attach a `saifac-run-log.md` to every PR it opens. But don't just show the successes—**highlight the failures**.
- **The Proof:** "Attempt 1: Failed. Holdout tests caught an unhandled null exception on line 42. Agent rewrote function. Attempt 2: Failed. Test 4 timed out. Agent optimized database query. Attempt 3: Passed."
- **Why it works:** Senior engineers don't trust things that work magically on the first try. Seeing the agent fail, analyze the sandbox error, and _fix its own code_ builds massive trust. It proves the sandbox verification actually caught bugs before the IC had to review them.

### 5. The "Typo-to-Test" Ratio

Senior engineers know that the mark of a professional is exhaustive testing. We can analyze the diffs generated by SAIFAC to prove its rigor.

- **The Metric:** Ratio of Implementation Code to Test Code.
- **The Proof:** "For this 50-line feature, SAIFAC generated 150 lines of edge-case tests."
- **Why it works:** ICs often skip writing exhaustive negative test cases because they are under a deadline. Showing them that SAIFAC acts as an absolutely relentless, untiring QA engineer proves its worth immediately.

### How to weaponize this for Marketing:

If we build even one of these features, our landing page copy shifts from a _promise_ to a _challenge_:

> **"Don't trust us. Run `saifac prove` on your ugliest closed ticket from last sprint and see what it would have done while you were getting coffee."**

This is how we market to developers. We don't sell them the dream; we give them the telemetry to prove it to themselves. Which of these telemetry ideas feels most technically feasible for the MVP?

## Implementing trust-building features

the `saifac prove` and the artifact trail and the most powerful of the above, because they are purely deterministic and require zero "marketing spin" to be effective. They speak entirely in the language of engineering.

If we lean into `saifac prove` and the "Glass Pipeline Artifact Trail," it changes how we position the product. We go from selling a tool to selling an undeniable engineering fact.

Here is how we should weaponize these two specific features across the product, the persona, and the marketing:

---

### 1. Weaponizing `saifac prove` (The "Shadow Run")

**Why it's so powerful for the IC:** It eliminates the "toy app" defense. Every engineer thinks, _“Sure, this AI can build a snake game from scratch, but it would implode if it touched our monolithic, legacy codebase with custom auth middleware.”_

If SAIFAC can pull a closed Jira ticket, navigate their actual repo, write tests that match the original developer’s intent, and generate a comparable PR, the argument is over.

**How to integrate this into the IC Persona / Marketing:**

- **The "Aha!" Onboarding Moment:** The very first step in the getting-started guide shouldn't be "Create a new project." It should be:

  ```bash
  $ npm install -g safe-ai-factory
  $ cd my-massive-legacy-repo
  $ saifac prove --issue 1234
  ```

  We want their first interaction to be an apples-to-apples comparison on their home turf.

- **The Landing Page Hero Hook:**
  Instead of: _“Build software faster.”_
  Use: _“Test SAIFAC against your own codebase. Give it an issue you already know the answer to and see for yourself.”_

- **The Counter to "It Hallucinates Context":** When an IC says, "AI doesn't understand our weird internal libraries," the answer is just, "Run `saifac prove`. It uses your codebase as its RAG context. See for yourself if it figures out your weird libraries."

### 2. Weaponizing the "Glass Pipeline" Artifact Trail

**Why it's so powerful for the IC:** Transparency is the antidote to AI fatigue. Engineers don't hate AI making mistakes; they hate AI making mistakes in a _black box_ that takes 30 minutes to unravel. By exposing the "sweat" (the failed attempts, the holdout test error outputs, the agent's self-corrections), we prove that the verification sandbox actually works.

**How to integrate this into the IC Persona / Marketing:**

- **The PR Description is the Product:** When SAIFAC opens a PR, the description shouldn't just summarize the code changes. It should act as an audit log of the agent's struggle.

  _Example SAIFAC PR Body:_

  > **Feature:** Implement user rate limiting.
  > **Spec Check:** Passed 4/4 functional requirements.
  >
  > **The Factory Run Log:**
  >
  > - **Attempt 1:** 🔴 Failed. Coder Agent implemented Redis cache, but holdout tests caught a race condition in `test_concurrent_requests` (holdout test).
  > - **Attempt 2:** 🔴 Failed. Coder Agent added locking, but introduced a memory leak. Holdout tests failed on `memory_profiler_threshold`.
  > - **Attempt 3:** 🟢 Passed. Code simplified. All 14 tests passing.
  >
  > _View the full `saifac-run-log.md` to see the exact stack traces the agent encountered._

- **Reframing "Slow" as "Rigorous":** SAIFAC is not going to be instantaneous. Running tests, failing, and looping takes time. The Artifact Trail turns this perceived weakness into a strength.
  - _The narrative:_ "Yes, SAIFAC took 45 minutes to write this PR. But look at the log: it failed 4 times and caught 2 edge cases you probably would have missed. It spent 45 minutes grinding so you didn't have to."

- **The "Debug" Entry Point:** If an IC clicks `saifac run debug`, the Artifact Trail tells them exactly where to look. "The agent is stuck on Attempt 5. The holdout tests keep throwing this specific PostgreSQL timeout error." The IC knows exactly what to fix.

### Summary: The Ultimate IC Pitch

If we have these two things, we don't need a "hype machine" marketer. We just need to give them the command line tools and get out of their way.

The pitch becomes:
**"We built a deterministic AI pipeline that writes code until the tests pass. Don't believe us? Run `saifac prove` on your last closed ticket, read the struggle log, and compare its PR to yours."**

---

## TODOs

- Imlpement `saifac run debug`
- Imlpement `saifac run review`
- The "Glass Pipeline" artifact trail: `saifac-run-log.md`
- Implement `saifac prove` - Personalized Historical Benchmarking

- [optional] Implement `saifac run huddle` - Opens a chat window with the IC _before_ the run starts to discuss the spec, capture unwritten context, and answer the AI's clarifying questions. Saved as a markdown file in the feature directory and made available to the coding agent to prevent "garbage in / garbage out".
- [optional] The "Grind vs. Glory" Dashboard (CLI Analytics)

- Before these features implemented, use AI to generate videos for the landing page and README? (gifs of navigating the CLI and VSCode extension)
- To support `saifac run review`, we might need to set up an "orchestrator" server that hooks into GitHub and listens for PR comments.
