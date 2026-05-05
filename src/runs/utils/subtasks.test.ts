/**
 * Round-trip tests for {@link runSubtasksFromInputs} / {@link runSubtasksToInputs}.
 *
 * These functions are the manifest ↔ runtime bridge: any field declared on
 * `RunSubtaskInput` must survive the conversion in both directions, otherwise
 * a `run pause` / `run resume` cycle silently drops it. `testScope` (Block 2
 * of TODO_phases_and_critics) is the most recent addition; locking the
 * round-trip here prevents future refactors from regressing it.
 */

import { describe, expect, it } from 'vitest';

import type { RunSubtaskInput } from '../types.js';
import { runSubtasksFromInputs, runSubtasksToInputs } from './subtasks.js';

describe('runSubtasksFromInputs / runSubtasksToInputs', () => {
  it('round-trips testScope through manifest → runtime → manifest', () => {
    const input: RunSubtaskInput = {
      title: 'phase-02-trigger critic A',
      content: 'audit phase 02',
      testScope: {
        include: ['/abs/feat/phases/01-core/tests', '/abs/feat/phases/02-trigger/tests'],
        cumulative: true,
      },
    };

    const runtime = runSubtasksFromInputs([input]);
    expect(runtime[0]?.testScope).toEqual(input.testScope);

    const backToInput = runSubtasksToInputs(runtime);
    expect(backToInput[0]?.testScope).toEqual(input.testScope);
  });

  it('round-trips testScope.cumulative=false (isolated scope)', () => {
    const input: RunSubtaskInput = {
      content: 'spike',
      testScope: { include: ['/abs/feat/phases/00-spike/tests'], cumulative: false },
    };

    const runtime = runSubtasksFromInputs([input]);
    const back = runSubtasksToInputs(runtime);
    expect(back[0]?.testScope?.cumulative).toBe(false);
    expect(back[0]?.testScope?.include).toEqual(input.testScope?.include);
  });

  it('round-trips a mix of scoped and unscoped subtasks (preserves absence)', () => {
    const inputs: RunSubtaskInput[] = [
      { content: 'a', testScope: { include: ['/x/01'] } },
      { content: 'b' }, // no testScope
      { content: 'c', testScope: { include: ['/x/02'] } },
    ];

    const runtime = runSubtasksFromInputs(inputs);
    const back = runSubtasksToInputs(runtime);

    expect(back[0]?.testScope).toEqual({ include: ['/x/01'] });
    expect(back[1]?.testScope).toBeUndefined();
    expect(back[2]?.testScope).toEqual({ include: ['/x/02'] });
  });

  it('round-trips all per-subtask config fields (gateScript, agentEnv, etc.)', () => {
    const input: RunSubtaskInput = {
      title: 'phase-01-core impl',
      content: 'implement core',
      gateScript: '#!/bin/sh\nexit 0',
      agentScript: '#!/bin/sh\necho coder',
      gateRetries: 3,
      reviewerEnabled: true,
      agentEnv: { FOO: 'bar', BAZ: 'qux' },
      testScope: { include: ['/x/01'], cumulative: true },
    };

    const runtime = runSubtasksFromInputs([input]);
    const back = runSubtasksToInputs(runtime);
    expect(back[0]).toEqual(input);
  });

  it('round-trips Block 4 phaseId + criticPrompt metadata', () => {
    const input: RunSubtaskInput = {
      title: 'phase:02-trigger critic:paranoid round:1/2 discover',
      content: 'raw critic body — {{phase.id}} {{phase.baseRef}}',
      phaseId: '02-trigger',
      criticPrompt: {
        criticId: 'paranoid',
        round: 1,
        totalRounds: 2,
        step: 'discover',
        findingsPath: '/workspace/.saifctl/critic-findings/02-trigger--paranoid--r1.md',
        vars: {
          feature: {
            name: 'auth',
            dir: 'saifctl/features/auth',
            plan: '/workspace/saifctl/features/auth/plan.md',
          },
          phase: {
            id: '02-trigger',
            dir: '/workspace/saifctl/features/auth/phases/02-trigger',
            spec: '/workspace/saifctl/features/auth/phases/02-trigger/spec.md',
            tests: '/workspace/saifctl/features/auth/phases/02-trigger/tests',
          },
        },
      },
    };

    const runtime = runSubtasksFromInputs([input]);
    expect(runtime[0]?.phaseId).toBe('02-trigger');
    expect(runtime[0]?.criticPrompt?.criticId).toBe('paranoid');

    const back = runSubtasksToInputs(runtime);
    expect(back[0]).toEqual(input);
  });

  it('round-trips Block 4 phaseId on impl subtasks (no criticPrompt)', () => {
    const input: RunSubtaskInput = {
      title: 'phase:01-core impl',
      content: 'implement core',
      phaseId: '01-core',
    };
    const runtime = runSubtasksFromInputs([input]);
    expect(runtime[0]?.phaseId).toBe('01-core');
    expect(runtime[0]?.criticPrompt).toBeUndefined();
    const back = runSubtasksToInputs(runtime);
    expect(back[0]).toEqual(input);
  });
});
