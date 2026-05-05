/**
 * End-to-end check for the worked example feature under
 * `saifctl/features/_phases-example/`.
 *
 * Compiles the example with the real Block 3 compiler, then mustache-renders
 * each critic body with the real Block 4 renderer. Catches drift between the
 * documented closed-variable set + the example template content + the
 * compiler-emitted `criticPrompt.vars` shape — three things that have to stay
 * in sync as Block 4 evolves.
 *
 * The example dir's `_` prefix means feature discovery skips it
 * (see `src/specs/discover.ts`), so this isn't a real production feature —
 * just a copy-pasteable reference.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compilePhasesToSubtasks } from './compile.js';
import { createSandboxFileResolver, renderCriticPrompt } from './critic-prompt.js';

const PROJECT_DIR = resolve(__dirname, '../../..');
const FEATURE_DIR = resolve(PROJECT_DIR, 'saifctl/features/_phases-example');

describe('_phases-example worked example', () => {
  it('compiles to the documented subtask sequence (impl + discover/fix critic pairs, phase 02 paranoid×2)', async () => {
    const out = await compilePhasesToSubtasks({
      featureAbsolutePath: FEATURE_DIR,
      featureName: '_phases-example',
      saifctlDir: 'saifctl',
      projectDir: PROJECT_DIR,
      gateScript: '#!/bin/sh\nexit 0',
    });

    // Per §6 — each critic round = (discover, fix) pair of subtasks.
    // Note: `audit` runs on phase 01 only. Phase 02's `phase.yml` overrides
    // the inherited critic list and intentionally omits `audit`, demoing the
    // §5.3 "override replaces, does not merge" semantics.
    expect(out.map((s) => s.title)).toEqual([
      'phase:01-validate-input impl',
      'phase:01-validate-input critic:strict round:1/1 discover',
      'phase:01-validate-input critic:strict round:1/1 fix',
      'phase:01-validate-input critic:paranoid round:1/1 discover',
      'phase:01-validate-input critic:paranoid round:1/1 fix',
      'phase:01-validate-input critic:audit round:1/1 discover',
      'phase:01-validate-input critic:audit round:1/1 fix',
      'phase:02-emit-output impl',
      'phase:02-emit-output critic:strict round:1/1 discover',
      'phase:02-emit-output critic:strict round:1/1 fix',
      'phase:02-emit-output critic:paranoid round:1/2 discover',
      'phase:02-emit-output critic:paranoid round:1/2 fix',
      'phase:02-emit-output critic:paranoid round:2/2 discover',
      'phase:02-emit-output critic:paranoid round:2/2 fix',
    ]);
  });

  it('every critic body (discover + fix) renders against the documented closed var set', async () => {
    const out = await compilePhasesToSubtasks({
      featureAbsolutePath: FEATURE_DIR,
      featureName: '_phases-example',
      saifctlDir: 'saifctl',
      projectDir: PROJECT_DIR,
      gateScript: '#!/bin/sh\nexit 0',
    });

    const critics = out.filter((s) => s.criticPrompt);
    expect(critics.length).toBeGreaterThan(0);

    for (const c of critics) {
      const prompt = c.criticPrompt!;
      // A render with a stub baseRef should succeed cleanly. The renderer
      // throws on unknown vars, so this catches any template mistake — for
      // both user-authored discover templates and the BUILTIN_FIX_TEMPLATE.
      const rendered = renderCriticPrompt({
        template: c.content,
        vars: {
          feature: prompt.vars.feature,
          phase: { ...prompt.vars.phase, baseRef: 'STUB_BASEREF_abc1234' },
          critic: {
            id: prompt.criticId,
            round: prompt.round,
            totalRounds: prompt.totalRounds,
            step: prompt.step,
            findingsPath: prompt.findingsPath,
          },
        },
        // strict.md uses `{{> file _preamble.md}}` to demonstrate the partial.
        // Resolver is rooted at the actual project dir so the partial can find
        // the real preamble file on disk.
        readFile: createSandboxFileResolver(PROJECT_DIR),
      });
      // Spot-check that runtime values flowed through.
      expect(rendered).toContain(prompt.criticId);
      expect(rendered).toContain(prompt.vars.phase.id);
      // baseRef appears in the user discover template (which references
      // {{phase.baseRef}}); the built-in fix template doesn't reference it,
      // so we only assert on discover.
      if (prompt.step === 'discover') {
        expect(rendered).toContain('STUB_BASEREF_abc1234');
      }
      // No literal mustache tokens left over in either template.
      expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
    }
  });

  it('phase 02 paranoid critic vars carry the right round counter on each round', async () => {
    const out = await compilePhasesToSubtasks({
      featureAbsolutePath: FEATURE_DIR,
      featureName: '_phases-example',
      saifctlDir: 'saifctl',
      projectDir: PROJECT_DIR,
      gateScript: '#!/bin/sh\nexit 0',
    });

    const r1d = out.find(
      (s) => s.title === 'phase:02-emit-output critic:paranoid round:1/2 discover',
    );
    const r2d = out.find(
      (s) => s.title === 'phase:02-emit-output critic:paranoid round:2/2 discover',
    );
    expect(r1d?.criticPrompt?.round).toBe(1);
    expect(r1d?.criticPrompt?.totalRounds).toBe(2);
    expect(r2d?.criticPrompt?.round).toBe(2);
    expect(r2d?.criticPrompt?.totalRounds).toBe(2);

    // Both rounds' discover steps share the same body — only the round
    // counter (rendered via mustache) and findingsPath distinguish them.
    expect(r1d?.content).toBe(r2d?.content);
    expect(r1d?.criticPrompt?.findingsPath).not.toBe(r2d?.criticPrompt?.findingsPath);
  });
});
