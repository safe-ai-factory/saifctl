/**
 * Local (in-process) Hatchet runner.
 *
 * Provides a drop-in replacement for `HatchetClient` that exercises the same
 * workflow/task code paths without connecting to a real Hatchet server.
 *
 * Only the subset of the HatchetClient API used by saifctl is implemented:
 *   - `hatchet.worker(name, { workflows })` — collects workflow declarations
 *   - `worker.start()` / `worker.stop()` — no-ops
 *   - `hatchet.run(workflowName, input)` — runs the DAG in-process
 *
 * Inside task `fn` callbacks, the injected `ctx` supports:
 *   - `ctx.abortController` — a fresh AbortController per execution
 *   - `ctx.parentOutput(taskRef)` — returns the output of an already-run task
 *   - `ctx.runChild(workflowName, input)` — recursively executes a child workflow
 *   - `ctx.errors()` — returns recorded task errors (used by `onFailure` handlers)
 *
 * Usage:
 *   Replace `HatchetClient.init()` with `createLocalHatchetRunner()` to run
 *   the full hatchet workflow code path locally, e.g.:
 *
 *     import { createLocalHatchetRunner } from './utils/hatchet.js';
 *     const hatchet = createLocalHatchetRunner();
 */

import { consola } from '../../logger.js';

// ---------------------------------------------------------------------------
// Minimal types mirroring the Hatchet SDK surface used in feat-run.workflow.ts
// ---------------------------------------------------------------------------

// Matches the SDK's InputType / UnknownInputType / StrictWorkflowOutputType
// constraints so that our WorkflowDeclaration generics are compatible.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export type TaskFn<I, O> = (input: I, ctx: LocalContext<I>) => Promise<O>;

export interface TaskDecl<I = unknown, O = unknown> {
  name: string;
  fn: TaskFn<I, O>;
  parents?: TaskDecl<I, unknown>[];
}

type OnFailureFn<I> = (input: I, ctx: LocalContext<I>) => Promise<void>;

interface WorkflowDef<I> {
  name: string;
  tasks: TaskDecl<I, unknown>[];
  onFailureFn?: OnFailureFn<I>;
}

// ---------------------------------------------------------------------------
// WorkflowDeclaration returned by hatchet.workflow().task(...)
// The second generic O mirrors the real SDK's StrictWorkflowOutputType so
// callers can write hatchet.workflow<Input, { step: StepOut }>(...) and have
// the types flow through identically.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class WorkflowDeclaration<I, O extends AnyRecord = AnyRecord> {
  readonly name: string;
  readonly tasks: TaskDecl<I, unknown>[] = [];
  onFailureFn?: OnFailureFn<I>;

  constructor(name: string) {
    this.name = name;
  }

  task<TOut>(opts: {
    name: string;
    fn: TaskFn<I, TOut>;
    parents?: TaskDecl<I, unknown>[];
    executionTimeout?: string;
    scheduleTimeout?: string;
  }): TaskDecl<I, TOut> {
    const decl: TaskDecl<I, TOut> = {
      name: opts.name,
      fn: opts.fn,
      parents: opts.parents,
    };
    this.tasks.push(decl as TaskDecl<I, unknown>);
    return decl;
  }

  onFailure(opts: { name: string; fn: OnFailureFn<I> }): void {
    this.onFailureFn = opts.fn;
  }

  toDef(): WorkflowDef<I> {
    return { name: this.name, tasks: this.tasks, onFailureFn: this.onFailureFn };
  }
}

// ---------------------------------------------------------------------------
// LocalContext — injected into every task fn instead of the real Hatchet ctx
// ---------------------------------------------------------------------------

interface LocalContextOpts {
  runner: LocalHatchetRunner;
  parents: Map<string, unknown>;
  errors: Record<string, string>;
}

export class LocalContext<I> {
  readonly abortController: AbortController;
  private readonly _parents: Map<string, unknown>;
  private readonly _errors: Record<string, string>;
  private readonly _runner: LocalHatchetRunner;

  constructor(opts: LocalContextOpts) {
    this.abortController = new AbortController();
    this._parents = opts.parents;
    this._errors = opts.errors;
    this._runner = opts.runner;
  }

  /**
   * Returns the output of the given parent task.
   * Mirrors Context.parentOutput() — accepts a task declaration object (uses .name)
   * or a plain string task name.
   */
  async parentOutput<O>(taskRef: TaskDecl<I, O> | string): Promise<O> {
    const key = typeof taskRef === 'string' ? taskRef : taskRef.name;
    if (!this._parents.has(key)) {
      throw new Error(
        `[local-hatchet] parentOutput: task "${key}" has not completed or does not exist`,
      );
    }
    return this._parents.get(key) as O;
  }

  /**
   * Runs a child workflow in-process and returns its aggregate step-keyed output.
   * Mirrors Context.runChild().
   */
  async runChild<Q extends Record<string, unknown>, P extends Record<string, unknown>>(
    workflowName: string,
    input: Q,
  ): Promise<P> {
    return this._runner.run<Q, P>(workflowName, input);
  }

  /**
   * Returns errors recorded for each task during this workflow run.
   * Used by onFailure handlers.
   */
  errors(): Record<string, string> {
    return { ...this._errors };
  }
}

// ---------------------------------------------------------------------------
// LocalWorker — no-op; workflow registration happens at construction time
// ---------------------------------------------------------------------------

class LocalWorker {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// LocalHatchetRunner — the top-level mock client
// ---------------------------------------------------------------------------

export class LocalHatchetRunner {
  private readonly _registry = new Map<string, WorkflowDef<unknown>>();

  /**
   * Creates a new workflow declaration builder.
   *
   * The returned object exposes `.task()` and `.onFailure()` mirroring the SDK.
   *
   * Mirrors type params of `HatchetClient.workflow<I, O>(options)` so the two are
   * interchangeable when used through the `HatchetLike` interface.
   */
  workflow<I, O extends AnyRecord = AnyRecord>(opts: { name: string }): WorkflowDeclaration<I, O> {
    return new WorkflowDeclaration<I, O>(opts.name);
  }

  /**
   * Registers workflow declarations and returns a no-op worker.
   * Mirrors `hatchet.worker(name, { workflows })`.
   */
  async worker(
    _name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: { workflows: WorkflowDeclaration<any, AnyRecord>[] },
  ): Promise<LocalWorker> {
    for (const wf of opts.workflows) {
      const def = wf.toDef();
      this._registry.set(def.name, def);
    }
    return new LocalWorker();
  }

  /**
   * Executes a named workflow in-process by topologically sorting its tasks and
   * running each `fn` sequentially.  Returns an object keyed by task name.
   *
   * Mirrors `hatchet.run(workflowName, input)`.
   */
  async run<I extends Record<string, unknown>, O extends Record<string, unknown>>(
    workflowName: string,
    input: I,
  ): Promise<O> {
    const def = this._registry.get(workflowName);
    if (!def) {
      throw new Error(
        `[local-hatchet] No workflow named "${workflowName}" is registered. ` +
          `Make sure to call worker() before run().`,
      );
    }

    const sortedTasks = topoSort(def.tasks);
    const outputs = new Map<string, unknown>();
    const taskErrors: Record<string, string> = {};

    let firstError: unknown = null;

    for (const task of sortedTasks) {
      const ctx = new LocalContext({ runner: this, parents: new Map(outputs), errors: taskErrors });
      try {
        const result = await task.fn(input as never, ctx as never);
        outputs.set(task.name, result);
      } catch (err) {
        taskErrors[task.name] = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = err;
        // Stop executing further tasks once one fails (mirrors Hatchet DAG behaviour).
        break;
      }
    }

    if (firstError !== null) {
      // Run the onFailure handler if defined, then re-throw.
      if (def.onFailureFn) {
        const failCtx = new LocalContext({
          runner: this,
          parents: new Map(outputs),
          errors: taskErrors,
        });
        try {
          await def.onFailureFn(input as never, failCtx as never);
        } catch (failErr) {
          // onFailure errors are suppressed to preserve the original error.
          consola.warn('[local-hatchet] onFailure handler threw:', failErr);
        }
      }
      throw firstError;
    }

    return Object.fromEntries(outputs) as O;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Topological sort of task declarations using Kahn's algorithm.
 * Respects `parents` to ensure each task runs after all its dependencies.
 */
function topoSort(tasks: TaskDecl<unknown, unknown>[]): TaskDecl<unknown, unknown>[] {
  const nameToTask = new Map<string, TaskDecl<unknown, unknown>>();
  for (const t of tasks) nameToTask.set(t.name, t);

  // Build in-degree and adjacency maps
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // parent → children that depend on it

  for (const t of tasks) {
    if (!inDegree.has(t.name)) inDegree.set(t.name, 0);
    if (!dependents.has(t.name)) dependents.set(t.name, []);
    for (const parent of t.parents ?? []) {
      inDegree.set(t.name, (inDegree.get(t.name) ?? 0) + 1);
      if (!dependents.has(parent.name)) dependents.set(parent.name, []);
      dependents.get(parent.name)!.push(t.name);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const sorted: TaskDecl<unknown, unknown>[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const task = nameToTask.get(name);
    if (!task) continue;
    sorted.push(task);
    for (const child of dependents.get(name) ?? []) {
      const newDeg = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  if (sorted.length !== tasks.length) {
    throw new Error('[local-hatchet] Cycle detected in workflow task DAG.');
  }

  return sorted;
}

/**
 * Creates a local in-process Hatchet runner that can be used as a drop-in
 * replacement for `HatchetClient` in contexts where no real Hatchet server
 * is available.
 */
export function createLocalHatchetRunner(): LocalHatchetRunner {
  return new LocalHatchetRunner();
}

// ---------------------------------------------------------------------------
// HatchetLike — structural interface satisfied by both HatchetClient and
// LocalHatchetRunner, avoiding union-type call-site errors.
// ---------------------------------------------------------------------------

/**
 * The subset of the Hatchet SDK surface that saifctl uses.
 * Defined as a structural interface so HatchetClient and LocalHatchetRunner
 * are both assignable without forming an incompatible union.
 *
 * Return types are intentionally loose (`unknown` / `any`) so that the real
 * SDK's WorkflowDeclaration and our local WorkflowDeclaration are both
 * accepted — callers always go through the concrete return value from
 * `hatchet.workflow(...)` which they captured themselves.
 */
/**
 * The subset of the Hatchet SDK surface that saifctl uses.
 * Defined as a structural interface so HatchetClient can be cast to it in
 * `client.ts`, giving callers (feat-run.workflow.ts) full typed access to
 * `WorkflowDeclaration<I, O>` without a broken union type.
 */
export interface HatchetLike {
  workflow<I, O extends AnyRecord = AnyRecord>(opts: { name: string }): WorkflowDeclaration<I, O>;
  worker(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts: { workflows: WorkflowDeclaration<any, AnyRecord>[] },
  ): Promise<{ start(): Promise<void>; stop(): Promise<void> }>;
  run<I extends AnyRecord, O extends AnyRecord>(workflowName: string, input: I): Promise<O>;
}
