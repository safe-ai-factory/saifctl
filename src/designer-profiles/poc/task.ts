// ---------------------------------------------------------------------------
// POC task builder
// ---------------------------------------------------------------------------

import { join } from 'node:path';

import { pathExists, readUtf8 } from '../../utils/io.js';

/** Options passed to {@link buildPocTask} to render the PoC designer prompt. */
export interface BuildPocTaskOpts {
  /** The real feature the POC is exploring (e.g. "my-feature"). */
  targetFeatureName: string;
  /** Absolute path to the real feature directory (saifctl/features/my-feature/). */
  targetFeatureAbsolutePath: string;
  /** Saifctl directory name (e.g. "saifctl"). */
  saifctlDir: string;
  /** The POC feature directory name (e.g. "my-feature-poc") — internal run id only. */
  pocFeatureName: string;
  /**
   * When set (e.g. CLI `--prompt`), used as the feature proposal body under
   * "## Feature Proposal" instead of reading `proposal.md`. Same idea as shotgun's
   * `prompt` overriding the proposal file.
   */
  prompt?: string;
}

/**
 * Builds the task prompt for a POC exploration run.
 *
 * The POC agent's job is NOT to deliver a working implementation.
 * Its job is to explore the hard parts of the feature, flesh out the design,
 * and write structured output files under saifctl/features/ so the designer can
 * extract a grounded spec.
 */
export async function buildPocTask(opts: BuildPocTaskOpts): Promise<string> {
  const { targetFeatureName, targetFeatureAbsolutePath, saifctlDir, pocFeatureName, prompt } = opts;

  const explicitPrompt = prompt?.trim();
  let proposalContent = '';
  if (explicitPrompt) {
    proposalContent = explicitPrompt;
  } else {
    const proposalPath = join(targetFeatureAbsolutePath, 'proposal.md');
    if (await pathExists(proposalPath)) {
      proposalContent = await readUtf8(proposalPath);
    } else {
      throw new Error(`No proposal.md found at ${proposalPath}`);
    }
  }

  const featDir = `/${saifctlDir}/features/${targetFeatureName}/`;

  const parts = [
    `You are running a PROOF-OF-CONCEPT (POC) exploration for the feature '${targetFeatureName}'.`,
    '',
    'Your goal is NOT to deliver a complete, working, production-quality implementation.',
    'Your goal is to explore the hard parts: discover edge cases, tricky interactions with',
    'the existing codebase, unclear API shapes, performance concerns, and design decisions.',
    '',
    `The factory registers this run as "${pocFeatureName}" for bookkeeping only. Do not use that`,
    `folder for your main outputs. Write everything for this feature under:`,
    `${featDir}`,
    '(under the repo root, e.g. /workspace in the container).',
    '',
    '## Your output contract',
    '',
    `You MUST write the following files to ${featDir} before you finish:`,
    '',
    `- specification.md  — A precise behavior contract for the feature, grounded in what`,
    `                      you discovered. This is the primary output.`,
    `- plan.md           — A step-by-step implementation roadmap based on what you learned.`,
    `- poc-findings.md   — (optional) A freeform notes file documenting the tricky parts,`,
    `                      edge cases, open questions, and design decisions you hit.`,
    '',
    'You MAY also add other files there (research.md, diagrams, scratch notes).',
    '',
    '## Other feature directories',
    '',
    `You MAY edit other directories under /${saifctlDir}/features/ when your exploration shows`,
    `those specs are wrong or incomplete because of this work — not only ${featDir}. Examples:`,
    'an endpoint is no longer needed or moved elsewhere; another feature must gain an API or',
    'contract to support yours; shared behavior is owned by a different feature dir. Update',
    'specification.md, plan.md, research.md, or short notes there so the design stays consistent.',
    'Keep edits focused; record cross-feature rationale in your poc-findings.md when non-obvious.',
    '',
    '## What to do',
    '',
    '1. Read the proposal below carefully.',
    '2. Explore the relevant parts of the codebase in /workspace.',
    '3. Attempt a quick-and-dirty partial implementation to discover design constraints.',
    '   You do NOT need to finish it. Breadth of exploration beats depth of completion.',
    '4. As you discover things, write them to poc-findings.md under your feature dir.',
    '5. When you have enough understanding, write specification.md and plan.md there.',
    '6. When done, stop. Do not try to make tests pass.',
  ];

  if (proposalContent) {
    parts.push('', '## Feature Proposal', '', proposalContent);
  }

  return parts.join('\n');
}
