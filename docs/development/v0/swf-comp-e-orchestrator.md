# Software Factory Component E: The Orchestrator

## What is the Orchestrator?

Our custom glue that combines all the other pieces.

The **Orchestrator** is the central nervous system (the "glue") of the AI-Driven Software Factory. It is a custom script or workflow engine that coordinates the entire pipeline from end to end.

Unlike the agents (which perform tasks) or the sandbox (which contains them), the Orchestrator dictates the state machine: it decides _when_ to start an agent, _how_ to pass data between them, and _who_ evaluates the final result. In our architecture, the Orchestrator must be built as a custom implementation (e.g., using TypeScript and Mastra) rather than relying on out-of-the-box benchmarking tools like SWE-bench, because it must remain strictly language-agnostic.

## How it Works: The State Machine

The Orchestrator manages the Factory Floor through a continuous, rigid state machine that enforces the "Trust, but Verify" paradigm.

Its core mechanism is the **Execution Loop**:

1. **Trigger Agent:** It starts the Coder Agent (via OpenHands headless) inside an isolated sandbox (pure file copy).
2. **Await Patch:** It waits for the agent to signal completion, then extracts the `.diff` patch via Git.
3. **Mutual Verification:** It spins up the Staging container (app + optional HTTP Sidecar), spins up the Test Runner container, and runs Black-Box tests over HTTP. The Test Runner evaluates the patch; no `docker exec` or unit-test runner sharing memory with the agent.
4. **Evaluate Exit Code:** It reads the `0` or `1` exit code.
   - If `1` (Fail), it captures `stderr`, spins up a new Staging container, and tells the agent to try again.
   - If `0` (Pass), it commits the patch to the host repository.

## WHY We Are Using a Custom Orchestrator

While open-source evaluation harnesses exist (like SWE-bench), we must build our own Orchestrator for three critical reasons:

1. **Language Agnosticism:** Default SWE-bench is hardcoded to Python environments (`pytest`, `tox`). Our Orchestrator must be able to test a TypeScript monorepo, a Go CLI, or a Rust backend simply by evaluating standard POSIX exit codes (`0`/`1`) from arbitrary Bash commands.
2. **Mutual Verification Enforcement:** The Orchestrator must independently verify the agent's work. SOTA frameworks (like `dsifry/metaswarm` or `SWE-Playground`) dictate that the orchestrator _never_ trusts subagent self-reports. The agent cannot grade its own test.
3. **Pipeline Integration:** The Orchestrator must interface with OpenSpec (for lifecycle management), Shotgun (for planning), and the Black Box Testing Agent (for test generation) before the coding even begins.

---

## Step-by-Step Implementation Plan (The "Custom Re-implementation")

If you are concerned that re-implementing the orchestrator will be complicated, the good news is that we are not rewriting SWE-bench's 10,000 lines of Python. We are stripping away the benchmarking overhead (datasets, HuggingFace integration, JSONL tracking) and building only the **Mutual Verification Loop** using standard Node.js libraries like `dockerode` and `simple-git`.

Here is the exhaustive detail of exactly what this TypeScript Orchestrator script must do and how it is implemented.

### Phase 1: Generation & Review (Human-in-the-Loop)

This phase runs directly on the developer's machine and is NOT automated. It exists to translate human intent into strict constraints.

1. **Trigger OpenSpec:** The PM/Engineer uses `/opsx:propose` to create `proposal.md` and writes the initial feature requirements.
2. **Invoke Shotgun:** The developer runs `shotgun specify --input proposal.md` to generate a codebase-aware `plan.md` and `spec.md`.
3. **Invoke Black Box Testing Agent:** The developer runs the Black Box Testing Mastra Worker, which reads `plan.md` and generates strict TDD constraints.
   - _Crucial step:_ The black box testing agent saves the **Public Tests** and **Holdout Tests** directly into the project's real `saifctl/features/<feature-name>/tests/` folder.
4. **Human Review:** The developer reviews `plan.md` and the generated tests. If they correctly reflect the desired feature, the developer commits these constraints and triggers the automated factory execution.

### Phase 2: The Factory Floor (Automated Execution)

Once the constraints are approved, the autonomous loop begins. To prevent polluting the active workspace, the Orchestrator isolates this work.

5. **Isolate via Pure File Copy:** The Orchestrator creates true isolation by copying the current repository to a disposable folder (e.g., `/tmp/saifctl/sandboxes/feature-x`). It uses tools like `rsync` with `--filter=':- .gitignore'` to ensure it doesn't copy `node_modules` or build artifacts. After rsync, it recursively removes _all_ `hidden/` directories under `saifctl/features/` from the code copy so the agent cannot see holdout tests from any feature (current or others). This guarantees that even if the agent maliciously deletes `.git` or corrupts files, the host repository is 100% safe, and the agent has no access to hidden tests.
6. **Fail2Pass Check (Sanity Check):**
   - Within the isolated sandbox, the Orchestrator runs the Black-Box test harness (e.g., Playwright or HTTP request to the Sidecar) against the holdout tests. For a web app or CLI wrapped in a Sidecar, this requires spinning up the app and invoking the test runner.
   - It parses the Vitest JSON report to check that _at least one_ feature test (excluding infrastructure health checks) failed. If all feature tests pass, the loop aborts — the feature already exists or the tests are invalid.
   - Partial overlap is OK: some tests (e.g. negative-path) may pass on `main` before implementation. Fail2pass only requires that some tests fail.
7. **Start OpenHands (Headless) in Leash Sandbox:**
   - When Leash is enabled (default), the Orchestrator runs the Leash CLI (`@strongdm/leash`) with `--no-interactive --image saifctl-coder-node-pnpm-python:latest --volume <sandbox>:/workspace --policy policies/default.cedar ... /saifctl/coder-start.sh`. Leash wraps OpenHands in our custom coder image (built from the sandbox profile's `Dockerfile.coder`) and enforces Cedar policies. The image is pulled from GHCR when not present locally.
   - Use `--engine local` (LocalEngine) or `environments.coding.engine: 'local'` to run OpenHands directly on the host during coding.
   - OpenHands runs autonomously. The Orchestrator waits for the process to exit.
8. **Extract Artifact:**
   - Once OpenHands completes, the Orchestrator uses `git diff HEAD` inside the sandbox to capture all changes since the base commit.
   - **Patch filtering (reward-hacking prevention):** Before the diff is written to `patch.diff` or applied to the host, any file sections that touch the `saifctl/` directory (or the path configured via `--saifctl-dir`) are stripped. The agent cannot cheat by modifying test specs or constraints — those changes are dropped and logged as a warning.
   - The filtered patch is saved as `patch.diff`; the sandbox is then reset to base state for the next attempt.

### Phase 3: Mutual Verification (The Test Runner & The Air Gap)

This is where we enforce the "Perfect Black Box" to prevent reward hacking. We must grade the patch without the agent's code ever sharing memory with the test runner.

9. **Start Staging Container:**
   - Using the `dockerode` npm package, the Orchestrator spins up a clean Staging container (e.g., `node:20`).
   - It mounts the isolated sandbox, applies the patch, installs dependencies, and starts the application (e.g., `npm run start` or waits for CLI execution).
   - _Crucially, the holdout tests are NOT mounted into this container._
10. **Start Test Runner Container:**

- The Orchestrator spins up the Test Runner container.
- It mounts the public and hidden test files to this container (read-only); the test runner runs the full suite every time.
- It executes the Black-Box test runner (e.g., Playwright for web, HTTP requests to the Sidecar for CLI). The Test Runner communicates with the Staging container strictly over the Docker network (HTTP). No `docker exec`.

11. **Grade and Route:**

- The Orchestrator waits for the Test Runner to finish and checks its **Exit Code**.
- **If Exit Code 1:** The Orchestrator captures the `stderr` logs, destroys both containers, goes back to Step 7, and passes the error log to the Coder Agent: _"The holdout test failed with this error. Try again."_
- **If Exit Code 0:** The code is proven to work. The Orchestrator proceeds to Phase 4.

### Phase 4: Teardown

12. **Archive & Merge:**
    - The Orchestrator applies `patch.diff` to the actual host repository.
    - It triggers `/opsx:archive` via an **async** subprocess helper (e.g. `child_process.exec` from `node:child_process/promises`, or `spawn` with Promises) so OpenSpec updates the master documentation — avoid blocking `execSync` in real implementations.
    - It uses the GitHub API (via `octokit`) to open a Pull Request.
    - It removes the entire disposable sandbox (`rm -rf /tmp/saifctl/sandboxes/{feat}-{runId}/`). Holdout tests lived in that directory alongside `code/`.

---

### Why this is easier than it sounds

By breaking it down, the Orchestrator is essentially a clean TypeScript file orchestrating standard CLI tools (`shotgun`, `openhands`, `docker`, `git`). We avoid the massive complexity of SWE-bench by focusing _only_ on our specific repository rather than trying to build a generic evaluator that must handle 500 different Python projects from 2012.

### Architectural Sketch (TypeScript)

Here is a more robust pseudocode sketch of the core loop. It addresses the practical realities of file management and human-in-the-loop validation:

1. **Separation of Concerns:** The process is split into two distinct functions. Generation (`generateSpecsAndTests`) runs first so a human can review the `plan.md` and tests. Execution (`runFactoryFloor`) runs the isolated loop.
2. **Pure File Copy Isolation:** The Execution loop copies the repository to a temporary `/tmp/` folder using `rsync` **honoring** `.gitignore` (so it skips `node_modules`, build artifacts, etc.). This guarantees the agent cannot accidentally delete or corrupt the host's real `.git` history or files.
3. **The Sandbox Illusion:** Inside the disposable copy, we remove all `hidden/` dirs under `saifctl/features/` from the code copy before the agent runs. The agent's workspace contains only public tests; holdout tests are physically absent.
   ```
   /tmp/
     |- saifctl/
         |- {featName}-{runId}/
             |- code/                      (Mounted to Agent)
                 |- .git
                 |- saifctl/features/
                 │   └── (hidden/ dirs removed from every feature)
                 |- src/
                 |- ...
   ```
   When Leash is enabled, we mount the `code/` directory into the Leash coder container; with local coding (LocalEngine), the agent runs on the host with `code/` as its cwd. In both cases, the agent never sees hidden tests, eliminating test-hacking.

```typescript
import { exec } from 'node:child_process/promises';
import Docker from 'dockerode';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const docker = new Docker();
/** Shell for one-liners in this pseudocode (Unix-oriented). Prefer `spawn` + argv in production. */
const sh = '/bin/bash';

/**
 * STEP 1: GENERATION (Human-in-the-Loop)
 * Runs locally on the user's active branch.
 * Output must be reviewed by a human PM/Engineer to ensure it aligns with intent.
 */
async function generateSpecsAndTests(featureName: string, proposalPath: string) {
  console.log('Generating architecture plan...');
  await exec(`shotgun specify --input ${proposalPath}`, { shell: sh });

  const plan = await readFile('plan.md', 'utf-8');

  console.log('Generating strict TDD constraints...');
  const tests = await runBlackBoxTestingAgent(plan);

  const publicTestPath = `saifctl/features/${featureName}/tests/public.spec.ts`;
  const holdoutTestPath = `saifctl/features/${featureName}/tests/holdout.spec.ts`;

  await writeFile(publicTestPath, tests.publicTests);
  await writeFile(holdoutTestPath, tests.holdoutTests);

  console.log(
    `Generation complete. Please review plan.md, ${publicTestPath}, and ${holdoutTestPath}.`,
  );
  console.log(`When approved, run: factory-execute ${featureName}`);
}

/**
 * STEP 2: EXECUTION (The Autonomous Factory)
 * Runs in a completely isolated disposable copy and Docker sandbox.
 */
async function runFactoryFloor(featureName: string) {
  const hostRepoPath = __dirname;
  const runId = Math.random().toString(36).substring(7);
  const sandboxBasePath = `/tmp/saifctl/sandboxes/${featureName}-${runId}`;
  const codePath = `${sandboxBasePath}/code`;

  // NOTE 1: OpenSpec supports nested paths (e.g. /specs/accounts/feat.md).
  // In a real implementation, this path should be dynamically resolved
  // rather than assuming the test is always at the root of a tests dir
  const relativeHoldoutPath = `saifctl/features/${featureName}/tests/holdout.spec.ts`;
  const holdoutTestName = `${featureName}.holdout.spec.ts`;

  // NOTE 2: A production script must wrap this entire execution block in a
  // try/finally block to guarantee the disposable sandbox is deleted
  // (`await rm(sandboxBasePath, { recursive: true, force: true })`) even if a command throws.

  // 1. Setup via Pure File Copy
  // We create a structure where the agent only mounts the inner "code" directory
  // so the holdout test is physically outside its container.
  console.log(`Creating isolated sandbox at ${sandboxBasePath}...`);
  await mkdir(codePath, { recursive: true });

  // Copy the repo into the inner "code" directory
  await exec(`rsync -a --filter=':- .gitignore' ${hostRepoPath}/ ${codePath}/`, { shell: sh });

  // Move the holdout test OUT of the code directory so the agent cannot see it
  await exec(`mv ${codePath}/${relativeHoldoutPath} ${sandboxBasePath}/${holdoutTestName}`, {
    shell: sh,
  });

  await exec('git init', { cwd: codePath }); // fresh local git repo for diffing
  await exec('git add . && git commit -m "Base state"', { cwd: codePath, shell: sh });

  // 2. Sanity Check (Fail2Pass)
  // In a real implementation, this would use the same three-container Black-Box flow:
  // spin up app (or Sidecar), run Test Runner with holdout, expect exit code 1.
  // Here we show a simplified check; adjust for your test harness (Playwright, Newman, etc.).
  try {
    // We temporarily copy the holdout back in to test it, then remove it
    await exec(`cp ${sandboxBasePath}/${holdoutTestName} ${codePath}/${relativeHoldoutPath}`, {
      shell: sh,
    });
    await exec(`npm install && npm run test -- ./${relativeHoldoutPath}`, { cwd: codePath, shell: sh });
    console.error('Holdout test passed on main branch. Aborting.');
    return;
  } catch (e) {
    console.log('Fail2Pass confirmed. Tests correctly fail.');
  } finally {
    await rm(path.join(codePath, relativeHoldoutPath), { force: true });
  }

  let success = false;
  let attempts = 0;
  let errorFeedback = '';
  // Illustrative: saifctl uses `environments.coding.engine: 'local'` or `--engine local` (LocalEngine).
  const runAgentOnHost = process.argv.includes('--coding-on-host');

  // 3. The Convergence Loop
  while (!success && attempts < 10) {
    attempts++;

    // Start OpenHands in the secure Leash Sandbox (or directly on host for local coding / LocalEngine)
    // When Leash is enabled, we run: node "$LEASH_BIN" --no-interactive ... /saifctl/coder-start.sh
    //   where $LEASH_BIN is require.resolve('@strongdm/leash/bin/leash.js') from the harness package.
    console.log(`Unleashing Coder Agent (Attempt ${attempts})...`);
    const openhandsCmd = runAgentOnHost
      ? `openhands --headless --workspace-dir "${codePath}" -t "Implement plan.md. Fix errors: ${errorFeedback}"`
      : `node "$LEASH_BIN" --no-interactive --image saifctl-coder-node-pnpm-python:latest --volume "${codePath}:/workspace" --policy policies/default.cedar /saifctl/coder-start.sh`;
    await exec(openhandsCmd, { cwd: codePath, shell: sh, maxBuffer: 1024 * 1024 * 64 });

    // Extract Artifact (Patch)
    await exec('git add .', { cwd: codePath });
    await exec('git diff HEAD > patch.diff', { cwd: codePath, shell: sh });
    await exec('git reset --hard HEAD', { cwd: codePath }); // Reset sandbox state for next attempt

    // 4. Mutual Verification (The Test Runner & The Air Gap)
    console.log('Running Mutual Verification...');

    // Staging container: The Agent's Application (Black Box)
    // We apply the patch and start the application. Holdouts are NOT mounted.
    const appContainer = await docker.createContainer({
      Image: 'node:20',
      name: `app-${runId}`,
      Binds: [`${codePath}:/workspace:ro`],
      Cmd: [
        '/bin/bash',
        '-c',
        `
        cp -r /workspace /app && cd /app
        git apply patch.diff
        npm install
        npm run start # Start the web server or daemon
      `,
      ],
    });
    await appContainer.start();
    // (In a real script, we wait for a healthcheck ping here to ensure server is up)

    // Test Runner container: mounts public + hidden test files and executes full suite
    // against Staging container over the network.
    // NOTE: To prevent root escalation, we do NOT mount the docker socket here.
    // Instead, if testing a CLI, the Staging container runs a lightweight HTTP Wrapper (Sidecar)
    // that executes the CLI locally and returns stdout over HTTP.
    const testRunnerContainer = await docker.createContainer({
      Image: 'playwright:focal', // Or whichever runner is required (e.g. 'node:20' for Newman/API tests)
      Binds: [
        `${sandboxBasePath}/${holdoutTestName}:/workspace/saifctl/features/${featureName}/tests/holdout.spec.ts:ro`,
      ],
      HostConfig: { Links: [`app-${runId}:app`] }, // Network link to Staging container
      Env: [
        `SAIFCTL_TARGET_URL=http://staging:3000`, // Point tests at Staging container's web server or HTTP Sidecar Wrapper
      ],
      Cmd: [
        '/bin/bash',
        '-c',
        `
        # Execute tests over HTTP, whether testing a Web App or a CLI wrapped in a Sidecar
        npm run test:e2e -- /workspace/saifctl/features/${featureName}/tests/holdout.spec.ts
      `,
      ],
    });

    await testRunnerContainer.start();
    const { StatusCode } = await testRunnerContainer.wait();

    if (StatusCode === 0) {
      console.log('Test Passed! Convergence achieved.');
      success = true;
    } else {
      // Capture stderr from the Test Runner to feed back to the agent
      const logs = await testRunnerContainer.logs({ stderr: true });
      errorFeedback = logs.toString();
      console.log('Test Failed. Retrying...');
    }

    // Clean up both containers
    await appContainer.stop();
    await appContainer.remove();
    await testRunnerContainer.remove();
  }

  // 5. Teardown
  if (success) {
    // Apply patch to the REAL host repository
    await exec(`git apply ${codePath}/patch.diff`, { cwd: hostRepoPath, shell: sh });
    await exec('git add . && git commit -m "Auto-generated feature"', { cwd: hostRepoPath, shell: sh });
    await exec('/opsx:archive', { cwd: hostRepoPath, shell: sh }); // Update Master Specs
    await exec('git push origin HEAD', { cwd: hostRepoPath, shell: sh });
    createPullRequest();
  }

  // Throw the disposable sandbox in the trash
  await rm(sandboxBasePath, { recursive: true, force: true });
}
```

By building this Orchestrator, we ensure the entire Software Factory operates continuously, securely, and completely language-agnostic, relying entirely on un-hackable mathematical exit codes.
