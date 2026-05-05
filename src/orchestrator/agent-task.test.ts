/**
 * Tests for {@link buildTaskPrompt} (Block 5 — link, don't inline).
 *
 * The implementer prompt is the per-round task body that's prepended to each
 * subtask's `content` before the agent runs. Block 5 changed it from inlining
 * the full plan.md to emitting a strong directive that names the workspace
 * path of the plan and instructs the agent to read it. These tests lock the
 * new contract:
 *
 * - container mode: directive references the container-side path under `/workspace`,
 * - host mode (`--engine local`): directive references the host path the
 *   agent will reach with `cwd: codePath`,
 * - directive uses "MUST read" wording (load-bearing per Block 5 risk note),
 * - plan content is NOT inlined,
 * - falls back gracefully when no plan file exists.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Feature } from '../specs/discover.js';
import { AGENT_WORKSPACE_CONTAINER, AGENT_WORKSPACE_HOST, buildTaskPrompt } from './agent-task.js';

let codePath: string;

beforeEach(async () => {
  codePath = await mkdtemp(join(tmpdir(), 'agent-task-'));
});

afterEach(async () => {
  await rm(codePath, { recursive: true, force: true });
});

function makeFeature(relativePath: string, name = 'my-feat'): Feature {
  return {
    name,
    relativePath,
    absolutePath: join(codePath, relativePath),
  };
}

describe("buildTaskPrompt — Block 5 (link, don't inline)", () => {
  it('emits a strong "MUST read" directive pointing at the container-side plan path when plan exists', async () => {
    const feat = makeFeature('saifctl/features/my-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    await writeFile(
      join(feat.absolutePath, 'plan.md'),
      '# inline plan body\nlots of stuff',
      'utf8',
    );

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement phase X.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('Implement phase X.');
    expect(out).toContain('/workspace/saifctl/features/my-feat/plan.md');
    expect(out).toMatch(/MUST read/);
  });

  it('does NOT inline plan.md content (Block 5 — token waste + agent should fetch what it needs)', async () => {
    const feat = makeFeature('saifctl/features/my-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    const planBody = '# Plan\n\nThis is sensitive plan content that must NOT appear inlined.';
    await writeFile(join(feat.absolutePath, 'plan.md'), planBody, 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).not.toContain('sensitive plan content');
    // Old "## Implementation Plan" section heading must not return.
    expect(out).not.toContain('## Implementation Plan');
    expect(out).not.toContain('## Plan');
  });

  it('falls back to workspace-root /workspace/plan.md when no feature is set', async () => {
    await writeFile(join(codePath, 'plan.md'), 'root plan body', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('/workspace/plan.md');
    expect(out).not.toContain('root plan body');
  });

  it('falls back to workspace-root /workspace/plan.md when feature exists but feature/plan.md does not', async () => {
    const feat = makeFeature('saifctl/features/no-plan-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    // No feature-rooted plan.md, but a workspace-root one.
    await writeFile(join(codePath, 'plan.md'), 'legacy root plan', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('/workspace/plan.md');
    // Feature-rooted candidate must NOT appear (file doesn't exist).
    expect(out).not.toContain('/workspace/saifctl/features/no-plan-feat/plan.md');
  });

  it('emits no "MUST read" directive when neither plan candidate exists (no fabricated path)', async () => {
    const feat = makeFeature('saifctl/features/empty-feat');
    await mkdir(feat.absolutePath, { recursive: true });

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    // The task body is preserved.
    expect(out).toContain('Do work.');
    // No "MUST read" directive — fabricating a plan path the agent would fail
    // to read is worse than no directive.
    expect(out).not.toMatch(/MUST read/);
    // The "MUST read"-style plan path must not appear; the spec-fallback
    // deviation line below references the feature dir, not a plan file.
    expect(out).not.toMatch(/Read the implementation plan/);
  });

  it('Block 8: spec-fallback deviation directive fires when feature exists but plan does not', async () => {
    // Spec-only features (no plan.md) can still drift from spec — the soft
    // directive must fire, anchored on the feature dir instead of a plan path.
    const feat = makeFeature('saifctl/features/spec-only');
    await mkdir(feat.absolutePath, { recursive: true });

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toMatch(/deviates from the original spec/);
    expect(out).toContain('saifctl/features/spec-only');
    expect(out).toMatch(/spec\.md/);
    // Same gate-soft contract as the plan-present variant.
    expect(out).toMatch(/does not fail the gate/);
  });

  it('Block 8: emits no deviation directive at all when neither plan nor feature is set', async () => {
    // Truly anchorless run (POC mode, no feature, no plan). Nothing concrete
    // for the agent to update — the directive is dropped entirely.
    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).not.toMatch(/deviates from the original/);
  });

  it('Block 8: appends the plan/spec deviation soft directive when plan exists', async () => {
    const feat = makeFeature('saifctl/features/my-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    await writeFile(join(feat.absolutePath, 'plan.md'), '# plan', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    // Soft-directive wording from §9 (verbatim "deviates from the original
    // plan or spec"). Test asserts the load-bearing phrase, not the full
    // sentence, so future copy edits don't break the test.
    expect(out).toMatch(/deviates from the original plan or spec/);
    expect(out).toContain('/workspace/saifctl/features/my-feat/plan.md');
    expect(out).toMatch(/spec\.md/);
    // The directive is soft — must be explicit that saifctl does NOT fail
    // the gate over plan/spec edits (otherwise agents may avoid updating
    // the plan even when they should).
    expect(out).toMatch(/does not fail the gate/);
  });

  it('Block 8: deviation directive uses host paths in --engine local mode', async () => {
    const feat = makeFeature('saifctl/features/my-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    await writeFile(join(feat.absolutePath, 'plan.md'), '# plan', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_HOST,
    });

    // No `/workspace/...` leak — host mode means the agent's cwd is codePath
    // and the directive must point at the host path.
    expect(out).toMatch(/deviates from the original plan or spec/);
    expect(out).toContain(join(feat.absolutePath, 'plan.md'));
    expect(out).not.toContain('/workspace/saifctl/features/my-feat/plan.md');
  });

  it('appends an error-feedback block when errorFeedback is provided', async () => {
    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      errorFeedback: 'TypeError: x is undefined\n  at line 12',
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('## Previous Attempt Failed');
    expect(out).toContain('TypeError: x is undefined');
    // The "do not modify saifctl" reminder lives in the failure block.
    expect(out).toContain('/saifctl/');
  });

  it('omits the error-feedback block when errorFeedback is empty / whitespace', async () => {
    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      errorFeedback: '   \n',
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).not.toContain('## Previous Attempt Failed');
  });

  it('normalises Windows-style backslashes in feature.relativePath to POSIX in the container directive', async () => {
    // `Feature.relativePath` is built via `path.relative()` in discover.ts,
    // which returns native separators — so on a Windows host the value is
    // `\\`-separated. The container is always Linux; emitting
    // `/workspace/saifctl\\features\\foo/plan.md` would be unreadable and
    // would invite the agent to fabricate plan content on the failed read
    // (the exact failure mode the probe exists to prevent). Lock the
    // normalisation contract here so it can't silently regress on a non-
    // Windows CI run.
    //
    // Note: on POSIX hosts `path.join` treats `\\` as a literal character,
    // not a separator — so we materialise the plan file at exactly the host
    // path `locatePlan()` will probe (`<codePath>/<relativePath>/plan.md`),
    // which on POSIX means a directory whose name literally contains
    // backslashes. Ugly, but it's the only way to exercise the
    // backslash-bearing `Feature.relativePath` branch portably.
    const winRelative = 'saifctl\\features\\win-feat';
    const hostFeatureDir = join(codePath, winRelative);
    const feat: Feature = {
      name: 'win-feat',
      relativePath: winRelative,
      absolutePath: hostFeatureDir,
    };
    await mkdir(hostFeatureDir, { recursive: true });
    await writeFile(join(hostFeatureDir, 'plan.md'), 'plan body', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('/workspace/saifctl/features/win-feat/plan.md');
    // No backslashes leaked into the container path.
    expect(out).not.toContain('saifctl\\features');
    expect(out).not.toContain('\\win-feat');
  });

  it('emits BOTH the plan directive and the error-feedback block when both apply', async () => {
    const feat = makeFeature('saifctl/features/with-plan');
    await mkdir(feat.absolutePath, { recursive: true });
    await writeFile(join(feat.absolutePath, 'plan.md'), 'PLAN', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      feature: feat,
      errorFeedback: 'gate failed: foo',
      workspace: AGENT_WORKSPACE_CONTAINER,
    });

    expect(out).toContain('/workspace/saifctl/features/with-plan/plan.md');
    expect(out).toContain('gate failed: foo');
    // Order: task → plan directive → failure block.
    const planIdx = out.indexOf('/workspace/saifctl/features/with-plan/plan.md');
    const failIdx = out.indexOf('Previous Attempt Failed');
    expect(planIdx).toBeGreaterThan(0);
    expect(failIdx).toBeGreaterThan(planIdx);
  });

  // ---------------------------------------------------------------------
  // Host mode (`--engine local`): the agent runs on the host with cwd=codePath,
  // not inside a container. The directive must reference the host path —
  // emitting `/workspace/...` would point at a non-existent path and trigger
  // exactly the fabricate-on-failed-read failure mode the probe exists to
  // prevent. Pre-fix this was hardcoded `/workspace/...` in both modes.
  // ---------------------------------------------------------------------
  it('host mode: directive references the host plan path (no /workspace/ leak)', async () => {
    const feat = makeFeature('saifctl/features/host-feat');
    await mkdir(feat.absolutePath, { recursive: true });
    await writeFile(join(feat.absolutePath, 'plan.md'), 'host plan body', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Implement.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_HOST,
    });

    const expectedHostPath = join(codePath, 'saifctl/features/host-feat/plan.md');
    expect(out).toContain(expectedHostPath);
    expect(out).toMatch(/MUST read/);
    // Critical regression guard: do NOT emit `/workspace/` in host mode.
    expect(out).not.toContain('/workspace/');
    // Plan content still must not be inlined (link-only contract).
    expect(out).not.toContain('host plan body');
  });

  it('host mode: workspace-root fallback uses host codePath/plan.md', async () => {
    await writeFile(join(codePath, 'plan.md'), 'root host plan', 'utf8');

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      workspace: AGENT_WORKSPACE_HOST,
    });

    const expectedHostPath = join(codePath, 'plan.md');
    expect(out).toContain(expectedHostPath);
    expect(out).not.toContain('/workspace/');
    expect(out).not.toContain('root host plan');
  });

  it('host mode: emits no directive when no plan candidate exists (parity with container mode)', async () => {
    const feat = makeFeature('saifctl/features/empty-host');
    await mkdir(feat.absolutePath, { recursive: true });

    const out = await buildTaskPrompt({
      codePath,
      task: 'Do work.',
      saifctlDir: 'saifctl',
      feature: feat,
      workspace: AGENT_WORKSPACE_HOST,
    });

    expect(out).toContain('Do work.');
    expect(out).not.toMatch(/MUST read/);
    expect(out).not.toContain('plan.md');
  });
});
