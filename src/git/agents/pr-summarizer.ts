import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

import { getChangeDirAbsolute } from '../../constants.js';
import { type ModelOverrides, resolveAgentModel } from '../../llm-config.js';

/** Maximum diff size (bytes) to pass verbatim; larger diffs are summarised to file headers only. */
const MAX_DIFF_BYTES = 100_000;

export const PRSummarySchema = z.object({
  title: z
    .string()
    .describe(
      'Conventional Commits PR title, e.g. "feat(greet-cmd): add greet CLI command". ' +
        'Must start with a type prefix (feat/fix/chore/refactor/docs/test) and be ≤ 72 chars.',
    ),
  body: z
    .string()
    .describe(
      'GitHub-flavoured Markdown PR body with sections: ## Summary, ## Changes, ## Testing',
    ),
});

export type PRSummary = z.infer<typeof PRSummarySchema>;

const PR_SUMMARIZER_INSTRUCTIONS = `You are a technical writer for a software engineering team.

Given an OpenSpec feature specification and a git diff, write a concise, informative GitHub Pull Request title and body.

Title rules:
- Follow Conventional Commits format: type(scope): short description
- Type must be one of: feat, fix, chore, refactor, docs, test
- Scope is the changeName (e.g. greet-cmd)
- Keep the title ≤ 72 characters
- Use imperative mood ("add", "fix", "remove" — not "added", "fixes")

Body rules:
- Use GitHub-flavoured Markdown
- Include exactly these three sections in this order:
  ## Summary
  2-3 sentences describing what changed and why, in plain English.

  ## Changes
  A bullet list of key file/module changes derived from the diff.
  Group related files. Be specific but concise.

  ## Testing
  A bullet list of how to verify the change.
  Derive from the specification's acceptance criteria when available.

Do NOT invent changes that are not in the diff. Do NOT add any section other than the three listed above.`;

function createPRSummarizerAgent(overrides: ModelOverrides = {}) {
  return new Agent({
    name: 'PRSummarizer',
    id: 'pr-summarizer',
    instructions: PR_SUMMARIZER_INSTRUCTIONS,
    model: resolveAgentModel('pr-summarizer', overrides),
  });
}

function buildPRSummaryPrompt(opts: {
  changeName: string;
  specContent: string;
  proposalContent: string;
  tasksContent: string;
  diffContent: string;
}): string {
  const { changeName, specContent, proposalContent, tasksContent, diffContent } = opts;

  const sections: string[] = [`## Change: \`${changeName}\``];

  if (proposalContent) {
    sections.push(`### Proposal\n\n${proposalContent}`);
  }
  if (specContent) {
    sections.push(`### Specification\n\n${specContent}`);
  }
  if (tasksContent) {
    sections.push(`### Tasks\n\n${tasksContent}`);
  }

  sections.push(`### Git Diff\n\n\`\`\`diff\n${diffContent}\n\`\`\``);
  sections.push(`Write the PR title and body based on the above.`);

  return sections.join('\n\n');
}

function readFileSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Trims a diff to stay within MAX_DIFF_BYTES.
 *
 * If the diff is small enough, return it verbatim. Otherwise return only the
 * `diff --git` header lines (file names + stat lines) so the LLM still
 * understands what changed, with a note that the full diff was truncated.
 */
function trimDiff(diff: string): string {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes <= MAX_DIFF_BYTES) return diff;

  const headerLines = diff
    .split('\n')
    .filter((l) => l.startsWith('diff --git') || l.startsWith('+++') || l.startsWith('---'))
    .join('\n');

  return (
    `[Diff truncated — ${Math.round(bytes / 1024)}KB exceeds limit. File summary only:]\n\n` +
    headerLines
  );
}

export interface GeneratePRSummaryOpts {
  /** The OpenSpec change name, e.g. "greet-cmd". */
  changeName: string;
  /**
   * Absolute path to the openspec directory root (e.g. "openspec").
   * The agent reads <openspecDir>/changes/<changeName>/specification.md etc.
   */
  openspecDir: string;
  /** Absolute path to the project directory (used to resolve openspecDir when relative). */
  projectDir: string;
  /** Absolute path to the patch.diff file written by extractPatch. */
  patchFile: string;
  /** CLI-level model overrides (--model / --agent-model). */
  overrides?: ModelOverrides;
}

/**
 * Calls the PRSummarizer agent to produce a PR title and body from spec docs + the git diff.
 *
 * Falls back gracefully: if any spec file is missing it is omitted from the prompt;
 * if the diff file is missing or the agent fails, the caller should use generic strings.
 */
export async function generatePRSummary(opts: GeneratePRSummaryOpts): Promise<PRSummary> {
  const { changeName, openspecDir, projectDir, patchFile, overrides = {} } = opts;
  const prSummarizerAgent = createPRSummarizerAgent(overrides);

  const changeDir = getChangeDirAbsolute({ cwd: projectDir, openspecDir, changeName });

  const specContent = readFileSafe(join(changeDir, 'specification.md'));
  const proposalContent = readFileSafe(join(changeDir, 'proposal.md'));
  const tasksContent = readFileSafe(join(changeDir, 'tasks.md'));

  let diffContent = readFileSafe(patchFile);
  if (!diffContent) {
    // patchFile might not exist (e.g. pure archive commit); fall back to empty
    diffContent = '(no diff available)';
  } else {
    diffContent = trimDiff(diffContent);
  }

  const prompt = buildPRSummaryPrompt({
    changeName,
    specContent,
    proposalContent,
    tasksContent,
    diffContent,
  });

  const output = await prSummarizerAgent.generate([{ role: 'user', content: prompt }], {
    structuredOutput: { schema: PRSummarySchema },
  });

  const result = output.object as PRSummary;
  if (!result?.title || !result?.body) {
    throw new Error('[pr-summarizer] Agent returned empty title or body');
  }

  return result;
}
