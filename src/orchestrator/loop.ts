/**
 * Iterative agent loop and related utilities.
 * Used by modes 'start' and 'continue'.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCancel, text } from '@clack/prompts';

import { runBlackboxDesign } from '../blackbox/design.js';
import { generateSpecTestScaffold } from '../blackbox/impl.js';
import { TestCatalogSchema } from '../blackbox/schema.js';
import type { GitProvider } from '../git/types.js';
import { generatePRSummary } from '../mastra/agents/pr-summarizer.js';
import { runSpecArbiter } from '../mastra/agents/spec-arbiter.js';
import type { TestProfile } from '../test-profiles/types.js';
import type { CleanupRegistry } from '../utils/docker.js';
import { runAgent } from './agent-runner.js';
import {
  runAssessmentWithContainers,
  type StartTestRunnerContainerOpts,
  type VitestSuiteResult,
} from './docker/test-runner.js';
import type { OrchestratorOpts, OrchestratorResult } from './modes.js';
import {
  destroySandbox,
  extractPatch,
  type PatchExcludeRule,
  type SandboxPaths,
} from './sandbox.js';

// ---------------------------------------------------------------------------
// Shared: Iterative Loop (used by 'start' and 'continue')
// ---------------------------------------------------------------------------

export async function runIterativeLoop(
  sandbox: SandboxPaths,
  opts: OrchestratorOpts & { openspecDir: string; registry: CleanupRegistry },
): Promise<OrchestratorResult> {
  const {
    stackProfileId,
    changeName,
    projectDir,
    maxAttempts = 10,
    keepSandbox = false,
    model,
    provider,
    baseUrl,
    openspecDir,
    projectName,
    registry,
    testImage,
    resolveAmbiguity,
    noLeash,
    cedarPolicyPath,
    coderImage,
    push,
    pr,
    gitProvider,
    innerRounds,
    agentEnv,
    agentLogFormat,
    testScript,
    testProfile,
  } = opts;
  // Always exclude openspec/ and .git/hooks/ regardless of any additional caller-supplied rules.
  // openspec/: reward-hacking prevention (agent must not modify its own test specs).
  // .git/hooks/: prevents a malicious patch from installing hooks that execute on the host
  //   when the orchestrator runs `git commit` in applyPatchToHost.
  const openspecExclude: PatchExcludeRule = { type: 'glob', pattern: `${openspecDir}/**` };
  const gitHooksExclude: PatchExcludeRule = { type: 'glob', pattern: '.git/hooks/**' };
  const patchExclude: PatchExcludeRule[] = [
    openspecExclude,
    gitHooksExclude,
    ...(opts.patchExclude ?? []),
  ];

  const catalog = loadCatalog({ projectDir, changeName, openspecDir });
  const testRunnerOpts = getTestRunnerOpts({
    projectDir,
    changeName,
    openspecDir,
    sandboxBasePath: sandbox.sandboxBasePath,
    testScript,
  });

  // Read the task from plan.md if available
  const task = buildInitialTask({ projectDir, changeName, openspecDir });

  let errorFeedback = '';
  let attempts = 0;
  let sandboxDestroyed = false;

  try {
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`\n[orchestrator] ===== ATTEMPT ${attempts}/${maxAttempts} =====`);

      // 1. Run agent (fresh context every iteration — Ralph Wiggum)
      await runAgent({
        codePath: sandbox.codePath,
        sandboxBasePath: sandbox.sandboxBasePath,
        task,
        errorFeedback,
        model,
        provider,
        baseUrl,
        openspecDir,
        changeName,
        noLeash,
        cedarPolicyPath,
        coderImage,
        innerRounds,
        startupPath: sandbox.startupPath,
        agentStartPath: sandbox.agentStartPath,
        agentPath: sandbox.agentPath,
        agentEnv,
        agentLogFormat,
      });

      // 2. Extract the patch, stripping any excluded paths (reward-hacking prevention)
      const { patch: patchContent, patchPath }: { patch: string; patchPath: string } = extractPatch(
        sandbox.codePath,
        { exclude: patchExclude },
      );

      if (!patchContent.trim()) {
        console.warn(
          '[orchestrator] OpenHands produced no changes (empty patch). Skipping assessment.',
        );
        errorFeedback =
          'No changes were made. Please implement the feature as described in the plan.';
        continue;
      }

      console.log(`[orchestrator] Extracted patch (${patchContent.length} bytes)`);

      // Re-apply the patch for assessment (extractPatch resets to base state).
      // patchPath is outside codePath so git clean cannot have deleted it.
      execSync(`git apply "${patchPath}"`, { cwd: sandbox.codePath });

      // 3. Mutual Verification
      const runId = `${extractRunId(sandbox.sandboxBasePath)}-r${attempts}`;

      const result = await runAssessmentWithContainers({
        stackProfileId,
        codePath: sandbox.codePath,
        projectDir,
        changeName,
        projectName,
        catalog,
        testRunnerOpts,
        registry,
        testImage,
        runId,
        startupPath: sandbox.startupPath,
        stagePath: sandbox.stagePath,
        reportPath: join(sandbox.sandboxBasePath, 'results.xml'),
      });

      if (result.runnerError) {
        throw new Error(
          `Test runner error on attempt ${attempts}: ${result.runnerError}\n` +
            `Check that runner.spec.ts and tests.json are present and valid.\n` +
            `Stderr:\n${result.stderr}`,
        );
      }

      if (result.passed) {
        // 4. Success path
        console.log('\n[orchestrator] ✓ ALL TESTS PASSED — applying patch to host');
        await applyPatchToHost({
          codePath: sandbox.codePath,
          projectDir,
          changeName,
          runId,
          push,
          pr,
          gitProvider,
          openspecDir,
        });
        destroySandbox(sandbox.sandboxBasePath);
        sandboxDestroyed = true;

        return {
          success: true,
          attempts,
          message: `Feature implemented successfully in ${attempts} attempt(s).`,
        };
      }

      // 5. Failure path - Check for spec ambiguity.
      //    If spec is ambiguous, the agent CANNOT faithfully completed the task,
      //    to match the hidden tests. So we either:
      //    - Ask the human to confirm the clarification.
      //    - Ask smart AI to automatically assess.
      //    In both cases, we update the spec and regenerate tests.
      console.log(`\n[orchestrator] Attempt ${attempts} FAILED.`);

      // Run the Spec Arbiter when enabled (prompt or auto mode).
      // We intentionally do NOT feed raw test runner output back to the agent:
      // the test runner runs the full suite (including hidden tests), so leaking
      // its stdout would reveal holdout details and let the agent fake the impl.
      // The Arbiter sanitizes the failure reason before it reaches OpenHands.
      if (resolveAmbiguity !== 'off' && result.testSuites) {
        const arbiterResult = await runArbiterForFailure({
          projectName,
          projectDir,
          changeName,
          openspecDir,
          patchPath,
          testSuites: result.testSuites,
          resolveAmbiguity,
          testProfile,
        });

        if (arbiterResult.ambiguityResolved) {
          // Spec was updated and tests regenerated — reset attempt counter so
          // the agent gets a fresh start with the improved spec.
          console.log(
            '[orchestrator] Spec ambiguity resolved — resetting attempt counter and continuing.',
          );
          attempts = 0;
          errorFeedback = '';
        } else {
          // Genuine failure: use the Arbiter's sanitized hint if available,
          // otherwise fall back to the generic message.
          // NOTE: Never mention tests - the agent must not think it can fix the failure by changing tests
          //       that's why the error message is framed as something "external" that's out of reach for the agent.
          const base = 'An external service attempted to use this project and failed. ';
          errorFeedback = arbiterResult.sanitizedHint
            ? base + arbiterResult.sanitizedHint
            : base + 'Re-read the plan and specification, and fix the implementation.';
        }
      } else {
        // Arbiter disabled — use a message that doesn't hint at test internals.
        errorFeedback =
          'An external service attempted to use this project and failed. Re-read the plan and specification, and fix the implementation.';
        console.log('[orchestrator] Feedback withheld (holdout protection).');
      }

      // Reset sandbox to base state for next OpenHands run
      execSync('git reset --hard HEAD', { cwd: sandbox.codePath });
      execSync('git clean -fd', { cwd: sandbox.codePath });
    }

    // Max attempts reached
    console.error(`\n[orchestrator] Max attempts (${maxAttempts}) reached without success.`);

    if (keepSandbox) {
      console.log(`[orchestrator] Sandbox preserved at: ${sandbox.sandboxBasePath}`);
      console.log(
        `[orchestrator] Resume with: pnpm agents feat:continue --sandbox-path ${sandbox.sandboxBasePath}`,
      );
      sandboxDestroyed = true; // Don't destroy in finally
    }

    return {
      success: false,
      attempts,
      sandboxPath: keepSandbox ? sandbox.sandboxBasePath : undefined,
      message: `Failed after ${maxAttempts} attempts. Last error:\n${errorFeedback}`,
    };
  } finally {
    if (!sandboxDestroyed) {
      destroySandbox(sandbox.sandboxBasePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Spec Arbiter: judge ambiguity vs genuine failure on assessment failures
// ---------------------------------------------------------------------------

interface RunArbiterForFailureOpts {
  projectName: string;
  /** Absolute path to the project directory */
  projectDir: string;
  changeName: string;
  openspecDir: string;
  testProfile: TestProfile;
  /** Content of the extracted patch for this attempt */
  patchPath: string;
  testSuites: VitestSuiteResult[];
  resolveAmbiguity: 'prompt' | 'auto';
}

interface ArbiterForFailureResult {
  /** True when the spec was genuinely ambiguous AND the ambiguity was resolved */
  ambiguityResolved: boolean;
  /** Sanitized behavioral hint for the agent (empty if ambiguityResolved=true) */
  sanitizedHint: string;
}

/**
 * Resolve how to continue after a failing test suite. Test failures may
 * be actually caused by ambiguous specs.
 *
 * In `auto` mode: if the spec is ambiguous, appends the proposed clarification
 * to specification.md and regenerates runner.spec.ts without human input.
 *
 * In `prompt` mode: shows the proposed clarification to the human and asks for
 * confirmation before updating the spec. If the human declines, treats the
 * failure as genuine.
 *
 * Returns `ambiguityResolved: true` when the spec was updated so the caller can
 * reset the attempt counter.
 */
export async function runArbiterForFailure(
  opts: RunArbiterForFailureOpts,
): Promise<ArbiterForFailureResult> {
  const {
    projectDir,
    changeName,
    openspecDir,
    patchPath,
    testSuites,
    resolveAmbiguity,
    testProfile,
    projectName,
  } = opts;

  const specPath = join(projectDir, openspecDir, 'changes', changeName, 'specification.md');
  const specContent = existsSync(specPath)
    ? readFileSync(specPath, 'utf8')
    : '(specification.md not found)';

  // Read the patch content (patchPath points to sandbox/patch.diff)
  const patchContent = existsSync(patchPath)
    ? readFileSync(patchPath, 'utf8')
    : '(patch not found)';

  console.log('[spec-arbiter] Running ambiguity check...');

  // Stream arbiter thinking in real-time (similar to [think]/[agent] style from OpenHands)
  let thinkBuf = '';
  const onArbiterThought = (delta: string) => {
    thinkBuf += delta;
    const lines = thinkBuf.split('\n');
    thinkBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) process.stdout.write(`[arbiter:think] ${trimmed.slice(0, 200)}\n`);
    }
  };
  const onArbiterEvent = (chunk: { type: string; payload: unknown }) => {
    if (chunk.type === 'tool-call') {
      const p = chunk.payload as { toolName?: string };
      process.stdout.write(`[arbiter] tool: ${p.toolName ?? '?'}\n`);
    }
  };

  const verdict = await runSpecArbiter({
    specContent,
    failingSuites: testSuites,
    patchContent,
    onThought: onArbiterThought,
    onEvent: onArbiterEvent,
  });
  // Flush any remaining partial thought line
  if (thinkBuf.trim()) process.stdout.write(`[arbiter:think] ${thinkBuf.trim().slice(0, 200)}\n`);

  console.log(`[spec-arbiter] isAmbiguous=${verdict.isAmbiguous}`);
  console.log(`[spec-arbiter] Reason: ${verdict.reason}`);

  if (!verdict.isAmbiguous) {
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  // --- Ambiguous spec detected ---
  console.log(`[spec-arbiter] Proposed spec addition:\n  "${verdict.proposedSpecAddition}"`);

  if (resolveAmbiguity === 'prompt') {
    console.log(`\n[spec-arbiter] Ambiguity detected. Reason: ${verdict.reason}`);
    console.log(`[spec-arbiter] Arbiter suggests: "${verdict.proposedSpecAddition}"`);

    const answer = await text({
      message: 'What is the correct behavior? (describe it; we will add it to specification.md)',
      placeholder: verdict.proposedSpecAddition,
    });

    if (isCancel(answer) || !answer?.trim()) {
      console.log('[spec-arbiter] Human skipped — treating failure as genuine.');
      return {
        ambiguityResolved: false,
        sanitizedHint: verdict.sanitizedHintForAgent,
      };
    }

    // Override the proposed spec addition with what the human actually said
    verdict.proposedSpecAddition = answer.trim();
  }

  // Append clarification to specification.md
  if (existsSync(specPath)) {
    const addition = `\n\n<!-- Spec Arbiter clarification (auto-added) -->\n${verdict.proposedSpecAddition}\n`;
    appendFileSync(specPath, addition, 'utf8');
    console.log(`[spec-arbiter] Appended clarification to ${specPath}`);
  } else {
    console.warn('[spec-arbiter] specification.md not found — cannot update spec.');
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  // Regenerate tests from the updated spec (design pipeline writes tests.json,
  // then scaffold generates the spec files via the coder agent).
  console.log('[spec-arbiter] Regenerating blackbox design with updated spec...');
  try {
    await runBlackboxDesign({ changeName, projectDir, openspecDir, testProfile, projectName });
    await generateSpecTestScaffold({ changeName, projectDir, openspecDir, testProfile });
    console.log('[spec-arbiter] Tests regenerated successfully.');
  } catch (err) {
    console.warn(`[spec-arbiter] Test regeneration failed (non-fatal): ${String(err)}`);
    return {
      ambiguityResolved: false,
      sanitizedHint: verdict.sanitizedHintForAgent,
    };
  }

  return { ambiguityResolved: true, sanitizedHint: '' };
}

// ---------------------------------------------------------------------------
// Success path: apply patch via git worktree → commit → archive → push → PR
// ---------------------------------------------------------------------------

interface ApplyPatchOpts {
  /** Absolute path to the sandbox code directory (sandboxBasePath/code) */
  codePath: string;
  /** Absolute path to the project directory */
  projectDir: string;
  changeName: string;
  /**
   * Unique run id used to construct the branch name (factory/<changeName>-<runId>),
   * ensuring parallel runs for different attempts never collide.
   */
  runId: string;
  /** Remote push target (URL, owner/repo slug, or named remote). Optional. */
  push: string | null;
  /** When true, open a Pull Request after pushing. Requires push + provider token env var. */
  pr: boolean;
  /** Git hosting provider. Default: GitHubProvider. */
  gitProvider: GitProvider;
  /**
   * Path to the openspec directory root (e.g. "openspec"), relative to project directory.
   * Used by the PR summarizer agent to read specification and proposal docs.
   */
  openspecDir: string;
}

/**
 * Applies the winning patch to the host repository using a git worktree so that
 * the main working tree's checked-out branch is never modified — safe for parallel runs.
 *
 * Flow:
 *   1. Create a temporary worktree at <sandboxBasePath>/worktree on branch factory/<changeName>-<runId>
 *   2. Apply patch.diff and commit inside the worktree
 *   3. Run `pnpm openspec archive` inside the worktree and commit any resulting changes
 *   4. Optionally push the branch to the remote target
 *   5. Optionally open a Pull Request via the configured git provider
 *   6. Remove the worktree (branch remains in the main repo's git history)
 *
 * The worktree lives inside sandboxBasePath so it is cleaned up by destroySandbox after
 * this function returns. The worktree must be deregistered (step 6) before the directory
 * is deleted, otherwise git's internal worktree registry gets stale entries.
 */
export async function applyPatchToHost(opts: ApplyPatchOpts): Promise<void> {
  const { codePath, projectDir, changeName, runId, push, pr, gitProvider, openspecDir } = opts;

  // patch.diff is written to sandboxBasePath (parent of codePath) by extractPatch,
  // deliberately outside the git working tree so `git clean -fd` cannot delete it.
  const sandboxBasePath = join(codePath, '..');
  const patchFile = join(sandboxBasePath, 'patch.diff');

  if (!existsSync(patchFile)) {
    console.warn('[orchestrator] No patch.diff found in sandbox; skipping host apply');
    return;
  }

  // Reject patches that touch .git/hooks/ — a hook injected here would run on the
  // host machine the next time any git operation triggers it.
  const patchContent = readFileSync(patchFile, 'utf8');
  if (/^diff --git.*\.git\/hooks\//m.test(patchContent)) {
    throw new Error(
      '[orchestrator] Patch rejected: contains changes to .git/hooks/. ' +
        'This is a security violation — the agent attempted to install a git hook on the host.',
    );
  }

  const branchName = `factory/${changeName}-${runId}`;
  const wtPath = join(sandboxBasePath, 'worktree');

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'factory',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'factory@localhost',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'factory',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'factory@localhost',
  };

  // Capture the current branch for the PR base *before* touching anything
  let baseBranch = 'main';
  try {
    const current = execSync('git branch --show-current', { cwd: projectDir }).toString().trim();
    baseBranch = current || 'main';
  } catch {
    // fall back to 'main'
  }

  console.log(`[orchestrator] Creating worktree at ${wtPath} on branch ${branchName}...`);

  // 1. Create worktree + branch — main worktree HEAD is never touched
  execSync(`git worktree add "${wtPath}" -b "${branchName}"`, { cwd: projectDir, env: gitEnv });

  try {
    // 2. Apply patch inside the worktree
    execSync(`git apply "${patchFile}"`, { cwd: wtPath, env: gitEnv });
    execSync('git add .', { cwd: wtPath, env: gitEnv });
    execSync(`git commit -m "feat(${changeName}): auto-generated implementation"`, {
      cwd: wtPath,
      env: gitEnv,
    });
    console.log(`[orchestrator] Committed patch on branch ${branchName}`);

    // 3. Archive the OpenSpec change inside the worktree
    try {
      // Sandbox vs worktree asymmetry: The agent's sandbox (code/) is created via rsync from
      // the main working tree and includes untracked and uncommitted files. The worktree,
      // however, is created with `git worktree add` and only contains the committed state
      // at HEAD.
      // Untracked paths like openspec/changes/<name>/ therefore exist in the sandbox
      // (and the main working tree) but not in the worktree. Since `openspec archive`
      // requires that directory to move it to archive/ and update specs, we copy
      // it from projectDir into the worktree before running the command. See swf-git.md
      // §8 "Sandbox vs. worktree source asymmetry" for details.
      const srcChangeDir = join(projectDir, openspecDir, 'changes', changeName);
      const destChangeDir = join(wtPath, openspecDir, 'changes', changeName);
      if (existsSync(srcChangeDir) && !existsSync(destChangeDir)) {
        execSync(`cp -r "${srcChangeDir}" "${destChangeDir}"`, { cwd: projectDir });
      }

      execSync(`npx openspec archive --yes ${changeName}`, { cwd: wtPath, env: gitEnv });
      const archiveChanges = execSync('git status --porcelain', { cwd: wtPath }).toString().trim();
      if (archiveChanges) {
        execSync('git add .', { cwd: wtPath, env: gitEnv });
        execSync(`git commit -m "chore(${changeName}): archive completed spec"`, {
          cwd: wtPath,
          env: gitEnv,
        });
      }
      console.log('[orchestrator] OpenSpec archive complete');
    } catch (err) {
      console.warn(`[orchestrator] OpenSpec archive failed (non-fatal): ${String(err)}`);
    }

    // 4. Push
    if (push) {
      const pushUrl = gitProvider.resolvePushUrl(push, projectDir);
      console.log(`[orchestrator] Pushing ${branchName} to remote...`);
      execSync(`git push "${pushUrl}" "${branchName}"`, { cwd: wtPath, env: gitEnv });
      console.log(`[orchestrator] Branch ${branchName} pushed.`);

      // 5. Create PR
      if (pr) {
        const repoSlug = gitProvider.extractRepoSlug(push, projectDir);

        // 5a. Generate AI title + body; fall back to generic strings on any error.
        let prTitle = `feat(${changeName}): auto-generated implementation`;
        let prBody = `Automated implementation produced by the Software Factory for change \`${changeName}\`.\n\nRun ID: \`${runId}\``;
        try {
          console.log(`[orchestrator] Generating AI PR summary for ${changeName}...`);
          const summary = await generatePRSummary({
            changeName,
            openspecDir,
            projectDir,
            patchFile,
          });
          prTitle = summary.title;
          prBody = summary.body + `\n\n---\n_Run ID: \`${runId}\`_`;
          console.log(`[orchestrator] AI PR title: ${prTitle}`);
        } catch (err) {
          console.warn(
            `[orchestrator] PR summarizer failed (using generic title/body): ${String(err)}`,
          );
        }

        console.log(`[orchestrator] Creating Pull Request on ${repoSlug}...`);
        const prUrl = await gitProvider.createPullRequest({
          repoSlug,
          head: branchName,
          base: baseBranch,
          title: prTitle,
          body: prBody,
        });
        console.log(`[orchestrator] Pull Request created: ${prUrl}`);
      }
    } else {
      console.log(
        `[orchestrator] Branch "${branchName}" is ready locally. ` +
          `Use --push <target> to push it upstream.`,
      );
    }
  } finally {
    // 6. Deregister the worktree from git's registry before destroySandbox deletes the dir
    try {
      execSync(`git worktree remove --force "${wtPath}"`, { cwd: projectDir });
    } catch (err) {
      // If the directory is already gone somehow, prune stale entries
      try {
        execSync('git worktree prune', { cwd: projectDir });
      } catch {
        // best-effort
      }
      console.warn(`[orchestrator] git worktree remove warning: ${String(err)}`);
    }
  }
}

interface BuildInitialTaskOpts {
  projectDir: string;
  changeName: string;
  openspecDir: string;
}

function buildInitialTask(opts: BuildInitialTaskOpts): string {
  const { projectDir, changeName, openspecDir } = opts;
  const planPath = join(projectDir, openspecDir, 'changes', changeName, 'plan.md');
  const specPath = join(projectDir, openspecDir, 'changes', changeName, 'specification.md');

  const parts = [
    `Implement the feature '${changeName}' as described in the plan below.`,
    `Write code in the /workspace directory. Do NOT modify files in the /${openspecDir}/ directory.`,
    'When complete, ensure the code compiles and passes linting.',
  ];

  if (existsSync(planPath)) {
    parts.push('', '## Plan', '', readFileSync(planPath, 'utf8'));
  }

  if (existsSync(specPath)) {
    parts.push('', '## Specification', '', readFileSync(specPath, 'utf8'));
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Utilities (used by loop and by modes)
// ---------------------------------------------------------------------------

interface LoadCatalogOpts {
  projectDir: string;
  changeName: string;
  openspecDir: string;
}

export function loadCatalog(opts: LoadCatalogOpts) {
  const { projectDir, changeName, openspecDir } = opts;
  const testsJsonPath = join(projectDir, openspecDir, 'changes', changeName, 'tests', 'tests.json');
  if (!existsSync(testsJsonPath)) {
    throw new Error(
      `tests.json not found at ${testsJsonPath}. Run 'pnpm agents feat:design ${changeName}' first.`,
    );
  }
  const raw = JSON.parse(readFileSync(testsJsonPath, 'utf8')) as unknown;
  const result = TestCatalogSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `tests.json schema validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}

interface GetTestRunnerOptsArgs {
  projectDir: string;
  changeName: string;
  openspecDir: string;
  /** Sandbox root — the test runner writes results.xml here (via /test-runner-output bind-mount). */
  sandboxBasePath: string;
  /**
   * Content of the test script (default or custom). Always written to
   * `{sandboxBasePath}/test.sh` and bind-mounted at /usr/local/bin/test.sh
   * inside the Test Runner container (read-only).
   */
  testScript: string;
}

/**
 * Returns test runner container opts for the change.
 *
 * Returns `testsDir` (the tests/ directory for the change), `reportDir` (sandbox root,
 * so that `runAssessment` can find results.xml at `{sandboxRoot}/results.xml`), and
 * `testScriptPath` (always set — written from DEFAULT_TEST_SCRIPT or a custom override).
 *
 * Spec files are expected to already exist — generated by `agents feat:design`.
 */
export function getTestRunnerOpts({
  projectDir,
  changeName,
  openspecDir,
  sandboxBasePath,
  testScript,
}: GetTestRunnerOptsArgs): Pick<
  StartTestRunnerContainerOpts,
  'testsDir' | 'reportDir' | 'testScriptPath'
> {
  const testsDir = join(projectDir, openspecDir, 'changes', changeName, 'tests');

  const testScriptPath = join(sandboxBasePath, 'test.sh');
  writeFileSync(testScriptPath, testScript, { encoding: 'utf8', mode: 0o755 });
  console.log(`[orchestrator] test.sh written to ${testScriptPath}`);

  return { testsDir, reportDir: sandboxBasePath, testScriptPath };
}

/** Extracts the runId suffix from a sandbox base path */
export function extractRunId(sandboxBasePath: string): string {
  const parts = sandboxBasePath.split('-');
  return parts[parts.length - 1] ?? 'run';
}
