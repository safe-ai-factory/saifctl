/**
 * Agent runner for the Software Factory Orchestrator.
 *
 * Invokes a user-supplied agent script headlessly inside the sandbox's
 * code directory. Each call starts a fresh process with a clean context
 * window — preventing "context rot" over many iterations.
 *
 * The agent script is responsible for running the coding agent and editing
 * files in the workspace. It receives the task via $FACTORY_TASK_PATH
 * (a markdown file written by coder-start.sh before each invocation).
 *
 * Security (Leash mode — default):
 *   The agent is run inside a monitored Docker container via `npx leash`.
 *   Leash enforces a Cedar policy that restricts filesystem writes to
 *   /workspace (the mounted sandbox copy) and limits network access to
 *   known package registries and LLM APIs. The agent cannot reach the host
 *   repository or modify openspec/ test files. Any openspec/ changes that
 *   slip through are stripped by the patch filter in sandbox.ts.
 *
 * Security (--no-leash mode):
 *   The agent runs directly on the host with the sandbox directory as its
 *   working directory. Isolation is purely filesystem-based (rsync copy in
 *   /tmp/factory-sandbox/). No Cedar policy enforcement. Use only for
 *   development/debugging.
 *
 * After the agent finishes, the caller should invoke extractPatch() from
 * sandbox.ts to capture the diff and reset for the next attempt.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getRepoRoot } from '../constants.js';

/** In-container workspace path that Leash bind-mounts the sandbox into. */
const CONTAINER_WORKSPACE = '/workspace';

export interface RunAgentOpts {
  /** Absolute path to the sandbox code directory (host path). */
  codePath: string;
  /**
   * Absolute path to the sandbox base directory (host path).
   * Used to locate gate.sh, startup.sh, and agent.sh which are mounted
   * read-only under /factory/.
   */
  sandboxBasePath: string;
  /** The human-readable task description (from plan.md, plus error context). */
  task: string;
  /**
   * Error feedback from the previous Test Runner run.
   * Injected into the task prompt so the agent knows what failed.
   */
  errorFeedback?: string;
  /** LLM model to use (e.g. 'anthropic/claude-sonnet-4-5'). Defaults to env var. */
  model?: string;
  /**
   * LLM provider ID (e.g. 'anthropic', 'openai', 'openrouter').
   * Forwarded as LLM_PROVIDER to agent scripts. Agents that need a provider to
   * configure base URL or routing (e.g. opencode) read this variable. When omitted,
   * agents may infer the provider from LLM_MODEL when possible.
   * Defaults to LLM_PROVIDER env var.
   */
  provider?: string;
  /** LLM base URL override (e.g. 'https://openrouter.ai/api/v1'). Defaults to LLM_BASE_URL env var. */
  baseUrl?: string;
  /**
   * Openspec directory name (relative to codePath), e.g. 'openspec'.
   * Used to locate plan.md candidates. Resolved by caller (e.g. parseOpenspecDir).
   */
  openspecDir: string;
  /** The change name — used to locate the plan.md for this specific change. */
  changeName?: string;
  /**
   * When true, skip Leash and run the agent directly on the host.
   * Isolation is filesystem-only (rsync sandbox). No Cedar enforcement.
   */
  noLeash: boolean;
  /**
   * Absolute path to a Cedar policy file for Leash.
   *
   * Defaults to leash-policy.cedar in src/orchestrator/. Ignored when noLeash=true.
   */
  cedarPolicyPath: string;
  /**
   * Docker image for the coder container.
   * Ignored when noLeash=true.
   */
  coderImage: string;
  /**
   * Maximum number of inner loop rounds (agent → gate → feedback) before giving up.
   * Forwarded as FACTORY_INNER_ROUNDS to coder-start.sh.
   * Applies in both leash and no-leash modes. Resolved by caller (default: 5).
   */
  innerRounds: number;
  /**
   * Absolute path to the installation script on the host (sandboxBasePath/startup.sh).
   * Set via --profile or --startup-script. Mounted read-only at /factory/startup.sh
   * inside the coder container. The factory loop runs it once before the agent starts.
   */
  startupPath: string;
  /**
   * Absolute path to the agent setup script on the host (sandboxBasePath/agent-start.sh).
   * Mounted read-only at /factory/agent-start.sh inside the coder container.
   * coder-start.sh runs it once after the startup script and before the agent loop.
   * Used to install the coding agent at runtime (e.g. pipx install aider-chat).
   */
  agentStartPath: string;
  /**
   * Absolute path to the agent script on the host (sandboxBasePath/agent.sh).
   * Mounted read-only at /factory/agent.sh inside the coder container.
   * coder-start.sh invokes this script once per inner round.
   * The script must read the task from $FACTORY_TASK_PATH.
   */
  agentPath: string;
  /**
   * Additional environment variables to forward into the container (Leash mode)
   * or inject into the host process env (no-leash mode).
   *
   * Useful for agent-specific configuration (e.g. AIDER_MODEL, CLAUDE_API_KEY).
   * If a key conflicts with a reserved factory variable (FACTORY_*, WORKSPACE_BASE,
   * LLM_API_KEY, LLM_MODEL, LLM_PROVIDER, LLM_BASE_URL), a warning is emitted and the user-supplied value is
   * ignored to prevent breaking the factory loop.
   */
  agentEnv: Record<string, string>;
  /**
   * Controls how agent stdout is parsed and printed.
   *
   * - `'openhands'` (default) — parse OpenHands --json event stream; pretty-print
   *   action events, thought blocks, and errors.
   * - `'raw'` — stream lines as-is with an `[agent]` prefix; suitable for any
   *   agent CLI that does not emit OpenHands-style JSON events.
   */
  agentLogFormat: 'openhands' | 'raw';
}

export interface RunAgentResult {
  success: boolean;
  exitCode: number;
  /** Combined stdout + stderr from the agent process. */
  output: string;
}

/**
 * Reserved env var prefixes and keys that must not be overridden by agentEnv.
 * These control the factory loop's own behaviour.
 */
const RESERVED_ENV_KEYS = new Set([
  'FACTORY_INITIAL_TASK',
  'FACTORY_INNER_ROUNDS',
  'FACTORY_GATE_SCRIPT',
  'FACTORY_STARTUP_SCRIPT',
  'FACTORY_AGENT_START_SCRIPT',
  'FACTORY_AGENT_SCRIPT',
  'FACTORY_TASK_PATH',
  'WORKSPACE_BASE',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
]);

const SENSITIVE_ENV_KEYS = new Set([
  'LLM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'DASHSCOPE_API_KEY',
]);

/**
 * Filters agentEnv, emitting warnings for any keys that would shadow reserved
 * factory variables. Returns a clean copy safe to forward.
 *
 * Blocks two categories:
 *   1. Any key with a `FACTORY_` prefix — covers all current and future
 *      internal factory loop variables.
 *   2. Exact-match keys in RESERVED_ENV_KEYS — covers non-prefixed vars like
 *      WORKSPACE_BASE, LLM_API_KEY, LLM_MODEL, LLM_PROVIDER, and LLM_BASE_URL.
 */
export function filterAgentEnv(agentEnv: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(agentEnv)) {
    if (key.startsWith('FACTORY_') || RESERVED_ENV_KEYS.has(key)) {
      console.warn(
        `[agent-runner] WARNING: --env ${key} is a reserved factory variable and will be ignored.`,
      );
      continue;
    }
    result[key] = val;
  }
  return result;
}

/**
 * Runs the agent script headlessly for a single iteration.
 *
 * Implements the Ralph Wiggum pattern:
 *   - Starts a fresh agent process with no prior context
 *   - Passes the full task (plan + error feedback if any) via FACTORY_INITIAL_TASK
 *   - coder-start.sh writes the task to FACTORY_TASK_PATH before invoking the agent script
 *   - Process terminates when the agent finishes or times out
 *
 * In Leash mode (default) the command is:
 *   npx leash -I --image <coderImage> --policy <cedar>
 *             -v <codePath>:/workspace
 *             -e LLM_MODEL=... -e LLM_API_KEY=... [-e LLM_PROVIDER=...] [-e LLM_BASE_URL=...] [other -e ...]
 *             /factory/coder-start.sh
 *
 * In --no-leash mode the command is:
 *   bash src/orchestrator/scripts/coder-start.sh
 *   (with WORKSPACE_BASE=codePath in env, cwd=codePath)
 *
 * The caller extracts the patch afterwards via sandbox.extractPatch().
 */
export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const {
    codePath,
    sandboxBasePath,
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
    startupPath,
    agentStartPath,
    agentPath,
    agentEnv,
    agentLogFormat,
  } = opts;

  const safeAgentEnv = filterAgentEnv(agentEnv);

  const taskPrompt = buildTaskPrompt({ codePath, task, openspecDir, changeName, errorFeedback });

  const llmModel = model ?? process.env.LLM_MODEL ?? 'openrouter/anthropic/claude-sonnet-4.6';
  const llmProvider = provider ?? process.env.LLM_PROVIDER;
  const llmBaseUrl = baseUrl ?? process.env.LLM_BASE_URL;
  const llmApiKey =
    process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;

  if (!llmApiKey) {
    throw new Error('No LLM API key found. Set LLM_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
  }

  let cmd: string;
  let args: string[];
  let argsForPrint: string[];
  let spawnCwd: string;
  let spawnEnv: Record<string, string>;

  if (noLeash) {
    // ── No-Leash: run coder-start.sh directly on host via bash ────────────────
    const coderStartPath = join(getRepoRoot(), 'src', 'orchestrator', 'scripts', 'coder-start.sh');
    cmd = 'bash';
    args = [coderStartPath];
    argsForPrint = [coderStartPath];
    spawnCwd = codePath;
    spawnEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
      ),
      ...safeAgentEnv,
      LLM_MODEL: llmModel,
      LLM_API_KEY: llmApiKey,
      ...(llmProvider ? { LLM_PROVIDER: llmProvider } : {}),
      ...(llmBaseUrl ? { LLM_BASE_URL: llmBaseUrl } : {}),
      WORKSPACE_BASE: codePath,
      FACTORY_INITIAL_TASK: taskPrompt,
      FACTORY_INNER_ROUNDS: String(innerRounds),
      FACTORY_STARTUP_SCRIPT: startupPath,
      FACTORY_AGENT_START_SCRIPT: agentStartPath,
      FACTORY_GATE_SCRIPT: `${sandboxBasePath}/gate.sh`,
      FACTORY_AGENT_SCRIPT: agentPath,
      // In no-leash mode /workspace doesn't exist on the host; write the task
      // file inside codePath (the spawn cwd) so coder-start.sh can create it.
      FACTORY_TASK_PATH: join(codePath, '.factory_task.md'),
    };
    console.log('[agent-runner] Mode: no-leash (host execution, filesystem sandbox only)');
    console.log(`[agent-runner] Coder start script: ${coderStartPath}`);
    console.log(`[agent-runner] Agent start script: ${agentStartPath}`);
    console.log(`[agent-runner] Agent script: ${agentPath}`);
    console.log(`[agent-runner] Startup script: ${startupPath}`);
    console.log(`[agent-runner] Gate script: ${sandboxBasePath}/gate.sh`);
    console.log(`[agent-runner] Inner rounds: ${innerRounds}`);
  } else {
    // ── Leash mode: run the agent inside a monitored container ───────────────

    const envForward: Record<string, string> = {
      LLM_MODEL: llmModel,
      LLM_API_KEY: llmApiKey,
      ...(llmProvider ? { LLM_PROVIDER: llmProvider } : {}),
      ...(llmBaseUrl ? { LLM_BASE_URL: llmBaseUrl } : {}),
      OPENHANDS_WORK_DIR: '/tmp/openhands-state',
      // Skip Leash's MITM proxy + iptables + LSM enforcement.
      // Both vars must be set together (see leashd/runtime.go skipEnforcement()
      // https://github.com/strongdm/leash/blob/0f4aa83e4278cab456352d3bd984fb104b30ed29/internal/leashd/runtime.go#L438).
      LEASH_E2E: '1',
      LEASH_BOOTSTRAP_SKIP_ENFORCE: '1',
      ...safeAgentEnv,
    };

    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'DASHSCOPE_API_KEY',
    ]) {
      const val = process.env[key];
      if (val) envForward[key] = val;
    }

    const leashArgs: string[] = [
      'leash',
      '--no-interactive',
      '--verbose',
      '--image',
      coderImage,
      '--volume',
      `${codePath}:${CONTAINER_WORKSPACE}`,
      '--volume',
      `${sandboxBasePath}/gate.sh:/factory/gate.sh:ro`,
      '--volume',
      `${startupPath}:/factory/startup.sh:ro`,
      '--volume',
      `${agentStartPath}:/factory/agent-start.sh:ro`,
      '--volume',
      `${agentPath}:/factory/agent.sh:ro`,
    ];

    if (existsSync(cedarPolicyPath)) {
      leashArgs.push('--policy', cedarPolicyPath);
      console.log(`[agent-runner] Cedar policy: ${cedarPolicyPath}`);
    } else {
      throw new Error(`Cedar policy file not found at ${cedarPolicyPath}`);
    }

    for (const [key, val] of Object.entries(envForward)) {
      leashArgs.push('--env', `${key}=${val}`);
    }

    leashArgs.push(
      '--env',
      `WORKSPACE_BASE=${CONTAINER_WORKSPACE}`,
      '--env',
      `FACTORY_INITIAL_TASK=${taskPrompt}`,
      '--env',
      `FACTORY_INNER_ROUNDS=${innerRounds}`,
      '--env',
      `FACTORY_STARTUP_SCRIPT=/factory/startup.sh`,
      '--env',
      `FACTORY_AGENT_START_SCRIPT=/factory/agent-start.sh`,
      '--env',
      `FACTORY_AGENT_SCRIPT=/factory/agent.sh`,
      '/factory/coder-start.sh',
    );

    argsForPrint = leashArgs.map((a) => {
      if (!a.includes('=')) return a;
      const eq = a.indexOf('=');
      const k = a.slice(0, eq);
      if (SENSITIVE_ENV_KEYS.has(k)) return `${k}=****`;
      if (k === 'FACTORY_INITIAL_TASK') return `${k}=<task (${a.length - eq - 1} chars)>`;
      return a;
    });

    cmd = 'npx';
    args = leashArgs;
    spawnCwd = getRepoRoot();
    spawnEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
      ),
    };

    console.log(`[agent-runner] Mode: leash (container: ${coderImage})`);
    console.log(`[agent-runner] Sandbox mount: ${codePath} → ${CONTAINER_WORKSPACE}`);
    console.log(
      `[agent-runner] Agent start script: ${agentStartPath} → /factory/agent-start.sh (ro)`,
    );
    console.log(`[agent-runner] Agent script: ${agentPath} → /factory/agent.sh (ro)`);
    console.log(`[agent-runner] Startup script: ${startupPath} → /factory/startup.sh (ro)`);
    console.log(`[agent-runner] Gate script: ${sandboxBasePath}/gate.sh → /factory/gate.sh (ro)`);
    console.log(`[agent-runner] Inner rounds: ${innerRounds}`);
  }

  console.log(`[agent-runner] Starting agent (model: ${llmModel})`);
  const promptPreview = taskPrompt.slice(0, 100);
  console.log(`[agent-runner] Task prompt (first 100 chars): ${JSON.stringify(promptPreview)}`);

  // 20 minute timeout per attempt; adjust as needed
  const timeoutMs = 20 * 60 * 1000;

  console.log(`[agent-runner] Command: ${cmd} ${argsForPrint.map((s) => s.slice(0, 100))}`);

  const { exitCode, output } = await new Promise<{ exitCode: number; output: string }>(
    (resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      let collected = '';
      let stdoutBuf = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        collected += text;

        if (agentLogFormat === 'raw') {
          for (const line of text.split('\n')) {
            if (line.trim()) process.stdout.write(`[agent] ${line}\n`);
          }
        } else {
          // OpenHands JSON event stream parsing
          stdoutBuf += text;
          const segments = stdoutBuf.split('--JSON Event--');
          stdoutBuf = segments.pop() ?? '';
          for (const segment of segments) {
            printOpenHandsSegment(segment);
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(text);
        collected += text;
      });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Agent timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (agentLogFormat !== 'raw' && stdoutBuf.trim()) printOpenHandsSegment(stdoutBuf);
        resolve({ exitCode: code ?? 1, output: collected });
      });
    },
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent-runner] Process error: ${msg}`);
    return { exitCode: 1, output: msg };
  });

  console.log(`[agent-runner] Finished with exit code ${exitCode}`);

  return {
    success: exitCode === 0,
    exitCode,
    output,
  };
}

/**
 * Prints a segment from OpenHands stdout in a compact, human-readable form.
 *
 * When --json is active, OpenHands emits "--JSON Event--" as a separator
 * followed by a pretty-printed multi-line JSON blob. We split on that separator
 * so each segment is either plain text or a complete JSON event object.
 * Non-JSON segments (warnings, "Agent is working", etc.) are printed as-is.
 *
 * Only used when agentLogFormat === 'openhands'.
 */
function printOpenHandsSegment(segment: string): void {
  const trimmed = segment.trim();
  if (!trimmed) return;

  if (trimmed.startsWith('{')) {
    try {
      const evt = JSON.parse(trimmed) as Record<string, unknown>;
      const kind = typeof evt.kind === 'string' ? evt.kind : '';

      if (kind === 'ActionEvent') {
        const thoughts = Array.isArray(evt.thought)
          ? (evt.thought as Record<string, unknown>[])
          : [];
        for (const t of thoughts) {
          const text = typeof t.text === 'string' ? t.text.trim() : '';
          if (text) process.stdout.write(`[think] ${text.replaceAll('\n', ' ').slice(0, 200)}\n`);
        }

        const action = evt.action as Record<string, unknown> | undefined;
        const summary = typeof evt.summary === 'string' ? evt.summary : '';
        const actionKind = typeof action?.kind === 'string' ? action.kind : '';

        let label: string;
        if (actionKind === 'TerminalAction') {
          const cmd = typeof action?.command === 'string' ? action.command.trim() : '';
          label = summary ? `${summary}: ${cmd.slice(0, 120)}` : `$ ${cmd.slice(0, 140)}`;
        } else if (actionKind === 'TaskTrackerAction') {
          const tasks = Array.isArray(action?.task_list)
            ? (action.task_list as Record<string, unknown>[])
            : [];
          const inProgress = tasks.filter((t) => t.status === 'in_progress').map((t) => t.title);
          const done = tasks.filter((t) => t.status === 'done').map((t) => t.title);
          const parts = [
            done.length ? `✓ ${done.join(', ')}` : '',
            inProgress.length ? `→ ${inProgress.join(', ')}` : '',
          ].filter(Boolean);
          label = parts.length ? parts.join(' | ') : summary || actionKind;
        } else if (actionKind === 'ThinkAction') {
          return;
        } else {
          const path = typeof action?.path === 'string' ? ` ${action.path}` : '';
          label = summary || `${actionKind}${path}`;
        }
        process.stdout.write(`[agent] ${label}\n`);
      } else if (kind === 'ObservationEvent') {
        const obs = evt.observation as Record<string, unknown> | undefined;
        const isError = obs?.is_error === true;
        if (isError) {
          const content = obs?.content;
          const first = Array.isArray(content)
            ? (content[0] as Record<string, unknown>)
            : undefined;
          const text = typeof first?.text === 'string' ? first.text : '';
          process.stdout.write(`[agent] ✗ error: ${String(text).slice(0, 200)}\n`);
        }
      } else if (kind === 'MessageEvent') {
        // Skip — these are large user/assistant messages
      } else if (trimmed) {
        process.stdout.write(`${trimmed}\n`);
      }
      return;
    } catch {
      // Not valid JSON — fall through to plain print
    }
  }

  for (const line of trimmed.split('\n')) {
    if (line.trim()) process.stdout.write(`${line}\n`);
  }
}

/**
 * Reads plan.md from the change directory (if available) and builds the
 * full task prompt injected into the agent.
 *
 * Note: paths here are always host paths (codePath on the host). The content
 * is embedded in the prompt string, so it is available to the agent regardless
 * of whether it runs on host or inside the coder container.
 */
interface BuildTaskPromptOpts {
  codePath: string;
  task: string;
  openspecDir: string;
  changeName: string | undefined;
  errorFeedback?: string;
}

function buildTaskPrompt(opts: BuildTaskPromptOpts): string {
  const { codePath, task, openspecDir, changeName, errorFeedback } = opts;
  let planContent = '';
  const planCandidates: string[] = [];

  if (changeName) {
    planCandidates.push(join(codePath, openspecDir, 'changes', changeName, 'plan.md'));
  }
  planCandidates.push(join(codePath, 'plan.md'));

  for (const p of planCandidates) {
    if (existsSync(p)) {
      planContent = readFileSync(p, 'utf8');
      break;
    }
  }

  const parts: string[] = [task];

  if (planContent) {
    parts.push('', '## Implementation Plan', '', planContent);
  }

  if (errorFeedback && errorFeedback.trim()) {
    parts.push(
      '',
      '## Previous Attempt Failed — Fix These Errors',
      '',
      '```',
      errorFeedback.trim(),
      '```',
      '',
      `Analyze the errors above and fix the code. Do NOT modify files in the /${openspecDir}/ directory.`,
    );
  }

  return parts.join('\n');
}
