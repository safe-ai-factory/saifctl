/**
 * Builds the per-round task prompt (plan.md enrichment + test failure feedback).
 */

import { join } from 'node:path';

import type { Feature } from '../specs/discover.js';
import { pathExists, readUtf8 } from '../utils/io.js';

export interface BuildTaskPromptOpts {
  codePath: string;
  task: string;
  saifctlDir: string;
  feature?: Feature;
  errorFeedback?: string;
}

export async function buildTaskPrompt(opts: BuildTaskPromptOpts): Promise<string> {
  const { codePath, task, saifctlDir, feature, errorFeedback } = opts;
  let planContent = '';

  const planCandidates: string[] = [];
  if (feature) planCandidates.push(join(codePath, feature.relativePath, 'plan.md'));
  planCandidates.push(join(codePath, 'plan.md'));

  for (const p of planCandidates) {
    if (await pathExists(p)) {
      planContent = await readUtf8(p);
      break;
    }
  }

  const parts: string[] = [task];
  if (planContent) parts.push('', '## Implementation Plan', '', planContent);
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
