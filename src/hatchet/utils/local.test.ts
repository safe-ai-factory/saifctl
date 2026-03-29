import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalHatchetRunner, LocalHatchetRunner } from './local.js';

describe('createLocalHatchetRunner / LocalHatchetRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when run() is called before worker() registers the workflow', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<{ x: number }, { a: number }>({ name: 'solo' });
    wf.task({ name: 'a', fn: async (input) => input.x });

    await expect(hatchet.run('solo', { x: 1 })).rejects.toThrow(
      /No workflow named "solo" is registered/,
    );
  });

  it('runs tasks in topological order and returns outputs keyed by task name', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<{ seed: string }, { first: string; second: string }>({
      name: 'linear',
    });
    const order: string[] = [];

    const first = wf.task({
      name: 'first',
      fn: async (input) => {
        order.push('first');
        return input.seed.toUpperCase();
      },
    });

    wf.task({
      name: 'second',
      parents: [first],
      fn: async (input, ctx) => {
        order.push('second');
        const prev = await ctx.parentOutput(first);
        return `${prev}-${input.seed}`;
      },
    });

    await hatchet.worker('w', { workflows: [wf] });

    const out = await hatchet.run('linear', { seed: 'hi' });
    expect(order).toEqual(['first', 'second']);
    expect(out).toEqual({ first: 'HI', second: 'HI-hi' });
  });

  it('parentOutput accepts a string task name', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<{ n: number }, { a: number; b: number }>({ name: 'by-name' });
    const a = wf.task({
      name: 'a',
      fn: async (input) => input.n * 2,
    });
    wf.task({
      name: 'b',
      parents: [a],
      fn: async (_input, ctx) => (await ctx.parentOutput<number>('a')) + 1,
    });

    await hatchet.worker('w', { workflows: [wf] });
    const out = await hatchet.run('by-name', { n: 3 });
    expect(out).toEqual({ a: 6, b: 7 });
  });

  it('runs a diamond DAG (fan-out / fan-in)', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<
      Record<string, never>,
      { root: number; l: number; r: number; join: string }
    >({ name: 'diamond' });

    const root = wf.task({ name: 'root', fn: async () => 1 });
    const left = wf.task({
      name: 'l',
      parents: [root],
      fn: async (_i, ctx) => (await ctx.parentOutput(root)) + 10,
    });
    const right = wf.task({
      name: 'r',
      parents: [root],
      fn: async (_i, ctx) => (await ctx.parentOutput(root)) + 100,
    });
    wf.task({
      name: 'join',
      parents: [left, right],
      fn: async (_i, ctx) => {
        const l = await ctx.parentOutput(left);
        const r = await ctx.parentOutput(right);
        return `${l},${r}`;
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    const out = await hatchet.run('diamond', {});
    expect(out).toEqual({ root: 1, l: 11, r: 101, join: '11,101' });
  });

  it('runChild executes a registered child workflow and returns its step map', async () => {
    const hatchet = createLocalHatchetRunner();

    const child = hatchet.workflow<{ v: string }, { childStep: string }>({ name: 'child-wf' });
    child.task({
      name: 'childStep',
      fn: async (input) => `child:${input.v}`,
    });

    const parent = hatchet.workflow<{ v: string }, { gate: string }>({ name: 'parent-wf' });
    parent.task({
      name: 'gate',
      fn: async (input, ctx) => {
        const childOut = await ctx.runChild<{ v: string }, { childStep: string }>('child-wf', {
          v: input.v,
        });
        return childOut.childStep;
      },
    });

    await hatchet.worker('w', { workflows: [parent, child] });
    const out = await hatchet.run('parent-wf', { v: 'x' });
    expect(out).toEqual({ gate: 'child:x' });
  });

  it('gives each task a fresh AbortController', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { a: AbortController; b: AbortController }>({
      name: 'abort',
    });
    const a = wf.task({
      name: 'a',
      fn: async (_i, ctx) => ctx.abortController,
    });
    wf.task({
      name: 'b',
      parents: [a],
      fn: async (_i, ctx) => ctx.abortController,
    });

    await hatchet.worker('w', { workflows: [wf] });
    const out = await hatchet.run('abort', {});
    expect(out.a).toBeInstanceOf(AbortController);
    expect(out.b).toBeInstanceOf(AbortController);
    expect(out.a).not.toBe(out.b);
  });

  it('stops the DAG after the first failing task and rethrows', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { a: number; b: number }>({ name: 'fail' });
    const seen: string[] = [];

    wf.task({
      name: 'a',
      fn: async () => {
        seen.push('a');
        throw new Error('boom');
      },
    });
    wf.task({
      name: 'b',
      fn: async () => {
        seen.push('b');
        return 2;
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('fail', {})).rejects.toThrow('boom');
    expect(seen).toEqual(['a']);
  });

  it('invokes onFailure with ctx.errors() then rethrows the original error', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { bad: never }>({ name: 'with-hook' });

    wf.task({
      name: 'bad',
      fn: async () => {
        throw new Error('task failed');
      },
    });

    let errorsFromHook: Record<string, string> | null = null;
    wf.onFailure({
      name: 'cleanup',
      fn: async (_input, ctx) => {
        errorsFromHook = ctx.errors();
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('with-hook', {})).rejects.toThrow('task failed');
    expect(errorsFromHook).toEqual({ bad: 'task failed' });
  });

  it('onFailure handler errors are logged and do not replace the original error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { bad: never }>({ name: 'hook-throws' });
    wf.task({
      name: 'bad',
      fn: async () => {
        throw new Error('original');
      },
    });
    wf.onFailure({
      name: 'cleanup',
      fn: async () => {
        throw new Error('onFailure oops');
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('hook-throws', {})).rejects.toThrow('original');
    expect(warn).toHaveBeenCalledWith(
      '[local-hatchet] onFailure handler threw:',
      expect.any(Error),
    );
  });

  it('worker.start and worker.stop resolve (no-op)', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { x: number }>({ name: 'noop-worker' });
    wf.task({ name: 'x', fn: async () => 1 });

    const worker = await hatchet.worker('w', { workflows: [wf] });
    await expect(worker.start()).resolves.toBeUndefined();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('parentOutput throws when the parent task did not complete', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { late: never }>({ name: 'missing-parent' });

    wf.task({
      name: 'late',
      fn: async (_i, ctx) => {
        await ctx.parentOutput('nonexistent');
        return null;
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('missing-parent', {})).rejects.toThrow(
      /parentOutput: task "nonexistent"/,
    );
  });

  it('onFailure can parentOutput completed tasks; optional parent uses try/catch (feat-run pattern)', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { provision: string; convergence: never }>({
      name: 'feat-run-like-fail',
    });

    const provision = wf.task({
      name: 'provision-sandbox',
      fn: async () => 'sandbox-ready',
    });

    wf.task({
      name: 'convergence-loop',
      parents: [provision],
      fn: async () => {
        throw new Error('loop blew up');
      },
    });

    let provisionFromHook: string | null = null;
    let convergenceMissing = false;
    wf.onFailure({
      name: 'on-failure',
      fn: async (_input, ctx) => {
        provisionFromHook = await ctx.parentOutput(provision);
        try {
          await ctx.parentOutput('convergence-loop');
        } catch {
          convergenceMissing = true;
        }
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('feat-run-like-fail', {})).rejects.toThrow('loop blew up');
    expect(provisionFromHook).toBe('sandbox-ready');
    expect(convergenceMissing).toBe(true);
  });

  it('ctx.errors() returns a defensive copy (mutations do not affect subsequent calls)', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { bad: never }>({ name: 'errors-copy' });

    wf.task({
      name: 'bad',
      fn: async () => {
        throw new Error('first message');
      },
    });

    let secondSnapshot: Record<string, string> | null = null;
    wf.onFailure({
      name: 'on-failure',
      fn: async (_input, ctx) => {
        const first = ctx.errors();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (first as any).bad = 'tampered';
        secondSnapshot = ctx.errors();
      },
    });

    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('errors-copy', {})).rejects.toThrow('first message');
    expect(secondSnapshot).toEqual({ bad: 'first message' });
  });

  it('runChild propagates child workflow errors to the parent task', async () => {
    const hatchet = createLocalHatchetRunner();

    const child = hatchet.workflow<Record<string, never>, { step: never }>({
      name: 'child-throws',
    });
    child.task({
      name: 'step',
      fn: async () => {
        throw new Error('child boom');
      },
    });

    const parent = hatchet.workflow<Record<string, never>, { gate: never }>({
      name: 'parent-catches-child',
    });
    parent.task({
      name: 'gate',
      fn: async (_input, ctx) => {
        await ctx.runChild('child-throws', {});
      },
    });

    await hatchet.worker('w', { workflows: [parent, child] });
    await expect(hatchet.run('parent-catches-child', {})).rejects.toThrow('child boom');
  });

  it('same task can call runChild multiple times (convergence-loop style)', async () => {
    const hatchet = createLocalHatchetRunner();

    const child = hatchet.workflow<{ i: number }, { leaf: number }>({ name: 'iter-child' });
    child.task({
      name: 'leaf',
      fn: async (input) => input.i * 10,
    });

    const parent = hatchet.workflow<Record<string, never>, { loop: string }>({
      name: 'multi-child',
    });
    parent.task({
      name: 'loop',
      fn: async (_input, ctx) => {
        const parts: number[] = [];
        for (let i = 1; i <= 3; i++) {
          const out = await ctx.runChild<{ i: number }, { leaf: number }>('iter-child', { i });
          parts.push(out.leaf);
        }
        return parts.join(',');
      },
    });

    await hatchet.worker('w', { workflows: [parent, child] });
    const out = await hatchet.run('multi-child', {});
    expect(out).toEqual({ loop: '10,20,30' });
  });

  it('run() on a workflow with no tasks returns an empty object', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, Record<string, never>>({ name: 'empty-wf' });
    await hatchet.worker('w', { workflows: [wf] });
    await expect(hatchet.run('empty-wf', {})).resolves.toEqual({});
  });

  it('each task AbortController.signal is not aborted initially', async () => {
    const hatchet = createLocalHatchetRunner();
    const wf = hatchet.workflow<Record<string, never>, { a: boolean; b: boolean }>({
      name: 'abort-signal',
    });
    const a = wf.task({
      name: 'a',
      fn: async (_i, ctx) => ctx.abortController.signal.aborted,
    });
    wf.task({
      name: 'b',
      parents: [a],
      fn: async (_i, ctx) => ctx.abortController.signal.aborted,
    });

    await hatchet.worker('w', { workflows: [wf] });
    const out = await hatchet.run('abort-signal', {});
    expect(out).toEqual({ a: false, b: false });
  });
});

describe('LocalHatchetRunner workflow re-registration', () => {
  it('later worker() call can add another workflow to the same runner', async () => {
    const hatchet = new LocalHatchetRunner();
    const wf1 = hatchet.workflow<{ n: number }, { only: number }>({ name: 'one' });
    wf1.task({ name: 'only', fn: async (input) => input.n });
    await hatchet.worker('w1', { workflows: [wf1] });

    const wf2 = hatchet.workflow<{ n: number }, { only: number }>({ name: 'two' });
    wf2.task({ name: 'only', fn: async (input) => input.n * 10 });
    await hatchet.worker('w2', { workflows: [wf2] });

    expect(await hatchet.run('one', { n: 2 })).toEqual({ only: 2 });
    expect(await hatchet.run('two', { n: 2 })).toEqual({ only: 20 });
  });

  it('worker() with the same workflow name overwrites the previous definition', async () => {
    const hatchet = new LocalHatchetRunner();
    const v1 = hatchet.workflow<{ n: number }, { only: number }>({ name: 'same-name' });
    v1.task({ name: 'only', fn: async () => 1 });
    await hatchet.worker('w1', { workflows: [v1] });

    const v2 = hatchet.workflow<{ n: number }, { only: number }>({ name: 'same-name' });
    v2.task({ name: 'only', fn: async (input) => input.n * 100 });
    await hatchet.worker('w2', { workflows: [v2] });

    expect(await hatchet.run('same-name', { n: 3 })).toEqual({ only: 300 });
  });
});
