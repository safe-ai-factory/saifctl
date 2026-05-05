/**
 * Builds the per-round task prompt prepended to the subtask `content` body.
 *
 * **Block 5 of TODO_phases_and_critics: link, don't inline.** The implementer
 * runs many rounds per phase (each gate-retry, each phase). Inlining a
 * 600-1200-LOC plan into every round wastes tokens and gives the agent no
 * incentive to selectively read what it actually needs. Instead we emit a
 * **strong directive** that names the agent-visible path and tells the agent
 * it MUST read the file before making changes.
 *
 * **Block 8** layers the plan/spec deviation directive on top: a soft
 * "if you deviated, update plan.md / spec.md to reflect reality" line.
 * Both implementer and critic prompts route through this builder, so the
 * directive lands on every round of every subtask. The matching post-round
 * warnings module surfaces any actual modifications.
 *
 * Symmetry with critic prompts (Block 4 / 4b): both implementer and critic
 * prompts reference plan / spec / findings via paths, never inline. The
 * agent has filesystem access; let it use that.
 *
 * **Engine modes.** The path the agent sees depends on the coding engine:
 *   - Docker / container: `codePath` is bind-mounted at `/workspace`; the
 *     directive must use the container path.
 *   - `--engine local` (host execution): the agent is `bash` spawned with
 *     `cwd: codePath`; the directive must use the *host* path. Emitting
 *     `/workspace/...` here would point at a non-existent path and trigger
 *     the very fabricate-on-failed-read failure mode the probe exists to
 *     prevent.
 *
 * If a future agent regresses to ignoring the directive, the documented
 * escape hatch is `feature.yml.implementer.inline-plan: true` (not yet
 * implemented). Don't ship that as the default.
 */

import { join } from 'node:path';

import type { Feature } from '../specs/discover.js';
import { pathExists } from '../utils/io.js';

/** In-container workspace mount path used when the coder runs under Docker. */
const CONTAINER_WORKSPACE_BASE = '/workspace';

/**
 * How the agent perceives the workspace root, which determines the path
 * format used in the "MUST read" directive.
 *
 * - `container`: agent runs in a Linux container; `codePath` is bind-mounted
 *   at {@link AgentWorkspaceContainer.root} (typically `/workspace`).
 * - `host`: agent runs on the host (`--engine local`) with `cwd: codePath`,
 *   so the directive uses host-side absolute paths verbatim.
 */
export type AgentWorkspace =
  | { readonly kind: 'container'; readonly root: string }
  | { readonly kind: 'host' };

/** Convenience: the canonical container workspace shape. */
export const AGENT_WORKSPACE_CONTAINER: AgentWorkspace = {
  kind: 'container',
  root: CONTAINER_WORKSPACE_BASE,
};

/** Convenience: the host-execution shape. */
export const AGENT_WORKSPACE_HOST: AgentWorkspace = { kind: 'host' };

export interface BuildTaskPromptOpts {
  /** Host path to the workspace (used for existence probes). */
  codePath: string;
  /** Per-subtask content body — the rendered task the agent should perform. */
  task: string;
  saifctlDir: string;
  feature?: Feature;
  errorFeedback?: string;
  /** How the agent perceives the workspace; controls directive path format. */
  workspace: AgentWorkspace;
}

export async function buildTaskPrompt(opts: BuildTaskPromptOpts): Promise<string> {
  const { codePath, task, saifctlDir, feature, errorFeedback, workspace } = opts;

  const parts: string[] = [task];

  // Find the plan file on disk so we don't emit a directive for a missing
  // file (the agent would then fail to read it and might fabricate content
  // instead). Probe the feature-rooted path first, then the legacy
  // workspace-root fallback. The probe uses host paths; the directive uses
  // whichever path the agent actually sees (container vs host mode).
  const planProbe = await locatePlan({ codePath, feature, workspace });
  if (planProbe) {
    parts.push(
      '',
      `Read the implementation plan at \`${planProbe.agentPath}\` before starting any work. ` +
        'The file is in your workspace; you MUST read it before you make any changes.',
    );
  }

  // Block 8 (§9 plan/spec deviation handling): soft directive on every
  // implementer/critic round. Saifctl does NOT enforce that plan.md was
  // updated — most rounds won't deviate — but when the agent does diverge,
  // the canonical record needs to track reality. The post-round-warnings
  // module surfaces any actual modifications to plan/spec/tests in the
  // run log so a reviewer skimming an overnight run can spot deviations
  // without re-reading the full diff.
  //
  // Wording is conditional on what's actually anchored in the workspace:
  //   - Plan present → reference it explicitly (verbatim §9 wording, plus a
  //     pointer to spec.md for phased features).
  //   - Plan absent but feature present → spec-only fallback (Block 5
  //     `specification.md` and any phase `spec.md`).
  //   - Neither → omit; nothing concrete for the agent to update.
  // This is wider than the strict §9 reading (which only fires when a plan
  // exists), but a spec-only feature can still drift from intent and the
  // surfacer happily logs spec-only modifications.
  if (planProbe) {
    parts.push(
      '',
      `If your implementation deviates from the original plan or spec, update \`${planProbe.agentPath}\` and the relevant \`spec.md\` to reflect what you actually built. Saifctl surfaces these modifications in the run log but does not fail the gate over them.`,
    );
  } else if (feature) {
    parts.push(
      '',
      `If your implementation deviates from the original spec, update the relevant \`spec.md\` (or \`specification.md\`) under \`${feature.relativePath.replaceAll('\\', '/')}\` to reflect what you actually built. Saifctl surfaces these modifications in the run log but does not fail the gate over them.`,
    );
  }

  if (errorFeedback?.trim()) {
    parts.push(
      '',
      '## Previous Attempt Failed — Fix These Errors',
      '',
      '```',
      errorFeedback.trim(),
      '```',
      '',
      `Analyze the errors above and fix the code. Do NOT modify files in the /${saifctlDir}/ directory.`,
    );
  }

  return parts.join('\n');
}

/**
 * Probe candidate plan locations and return the path the agent should read.
 *
 * Probe order (host paths):
 *   1. `<feature>/plan.md` (when a feature is set) — canonical Block 3+ shape.
 *   2. `<workspace-root>/plan.md` — legacy non-feature runs (POC / `--subtasks`).
 *
 * The returned `agentPath` is rebased for the agent's view:
 *   - container mode → `${workspace.root}/<posix-rel>/plan.md` (POSIX, since
 *     the container is always Linux even when the host is Windows).
 *   - host mode → the host path itself (the agent's cwd is `codePath`).
 */
async function locatePlan(opts: {
  codePath: string;
  feature?: Feature;
  workspace: AgentWorkspace;
}): Promise<{ agentPath: string } | null> {
  const { codePath, feature, workspace } = opts;

  if (feature) {
    const hostPath = join(codePath, feature.relativePath, 'plan.md');
    if (await pathExists(hostPath)) {
      return {
        agentPath: agentPathFor({
          hostPath,
          featureRelativePath: feature.relativePath,
          fileName: 'plan.md',
          workspace,
        }),
      };
    }
  }

  const rootHostPath = join(codePath, 'plan.md');
  if (await pathExists(rootHostPath)) {
    return {
      agentPath: agentPathFor({
        hostPath: rootHostPath,
        featureRelativePath: '',
        fileName: 'plan.md',
        workspace,
      }),
    };
  }

  return null;
}

/**
 * Translate a host file path into the path the agent will see, given the
 * workspace mode. In host mode the agent reads the host path directly; in
 * container mode we rebase under the container workspace root using POSIX
 * separators (the container is Linux regardless of host OS).
 *
 * `featureRelativePath` may be empty (workspace-root fallback) and may
 * contain native separators on Windows; we normalise to `/` for the
 * container path.
 */
function agentPathFor(opts: {
  hostPath: string;
  featureRelativePath: string;
  fileName: string;
  workspace: AgentWorkspace;
}): string {
  const { hostPath, featureRelativePath, fileName, workspace } = opts;
  if (workspace.kind === 'host') return hostPath;
  const root = stripTrailingSlash(workspace.root);
  if (!featureRelativePath) return `${root}/${fileName}`;
  const posixRel = featureRelativePath.replaceAll('\\', '/');
  return `${root}/${posixRel}/${fileName}`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
