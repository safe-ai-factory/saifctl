/**
 * Tests for the critic-prompt mustache renderer (Block 4 of TODO_phases_and_critics).
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BUILTIN_FIX_TEMPLATE,
  createSandboxFileResolver,
  CRITIC_PROMPT_VARS,
  CriticPromptRenderError,
  type CriticPromptVars,
  renderCriticPrompt,
} from './critic-prompt.js';

const baseVars: CriticPromptVars = {
  feature: {
    name: 'auth',
    dir: 'saifctl/features/auth',
    plan: '/workspace/saifctl/features/auth/plan.md',
  },
  phase: {
    id: '01-core',
    dir: '/workspace/saifctl/features/auth/phases/01-core',
    spec: '/workspace/saifctl/features/auth/phases/01-core/spec.md',
    baseRef: 'abc1234',
    tests: '/workspace/saifctl/features/auth/phases/01-core/tests',
  },
  critic: {
    id: 'paranoid',
    round: 1,
    totalRounds: 2,
    step: 'discover',
    findingsPath: '/workspace/.saifctl/critic-findings/01-core--paranoid--r1.md',
  },
};

describe('renderCriticPrompt — variable substitution', () => {
  it('renders all closed vars verbatim', () => {
    const tpl = [
      'feature.name={{feature.name}}',
      'feature.dir={{feature.dir}}',
      'feature.plan={{feature.plan}}',
      'phase.id={{phase.id}}',
      'phase.dir={{phase.dir}}',
      'phase.spec={{phase.spec}}',
      'phase.baseRef={{phase.baseRef}}',
      'phase.tests={{phase.tests}}',
      'critic.id={{critic.id}}',
      'critic.round={{critic.round}}',
      'critic.totalRounds={{critic.totalRounds}}',
    ].join('\n');
    const out = renderCriticPrompt({ template: tpl, vars: baseVars });
    expect(out).toBe(
      [
        'feature.name=auth',
        'feature.dir=saifctl/features/auth',
        'feature.plan=/workspace/saifctl/features/auth/plan.md',
        'phase.id=01-core',
        'phase.dir=/workspace/saifctl/features/auth/phases/01-core',
        'phase.spec=/workspace/saifctl/features/auth/phases/01-core/spec.md',
        'phase.baseRef=abc1234',
        'phase.tests=/workspace/saifctl/features/auth/phases/01-core/tests',
        'critic.id=paranoid',
        'critic.round=1',
        'critic.totalRounds=2',
      ].join('\n'),
    );
  });

  it('does NOT html-escape values (output is for an LLM, not a browser)', () => {
    const out = renderCriticPrompt({
      template: 'name={{feature.name}}',
      vars: { ...baseVars, feature: { ...baseVars.feature, name: '<auth & login>' } },
    });
    expect(out).toBe('name=<auth & login>');
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&lt;');
  });

  it('exposes CRITIC_PROMPT_VARS as the canonical closed list', () => {
    // Rough shape check — keeps this test as a regression marker if vars get
    // added/removed silently.
    expect(CRITIC_PROMPT_VARS).toContain('feature.name');
    expect(CRITIC_PROMPT_VARS).toContain('phase.baseRef');
    expect(CRITIC_PROMPT_VARS).toContain('critic.totalRounds');
    // Discover/fix split adds critic.step and critic.findingsPath (§6).
    expect(CRITIC_PROMPT_VARS).toContain('critic.step');
    expect(CRITIC_PROMPT_VARS).toContain('critic.findingsPath');
    expect(CRITIC_PROMPT_VARS.length).toBe(13);
  });
});

describe('renderCriticPrompt — closed-var enforcement', () => {
  it('throws on unknown variables (typo guard)', () => {
    expect(() => renderCriticPrompt({ template: 'oops {{phase.basRef}}', vars: baseVars })).toThrow(
      CriticPromptRenderError,
    );
    expect(() =>
      renderCriticPrompt({ template: '{{feature.notARealKey}}', vars: baseVars }),
    ).toThrow(/Unknown variable/);
  });

  it('throws on section / inverted-section / closing syntax', () => {
    expect(() =>
      renderCriticPrompt({ template: '{{#feature}}x{{/feature}}', vars: baseVars }),
    ).toThrow(/closed variable set/);
    expect(() =>
      renderCriticPrompt({ template: '{{^feature}}x{{/feature}}', vars: baseVars }),
    ).toThrow(/closed variable set/);
  });

  it('throws on invalid variable expressions', () => {
    expect(() => renderCriticPrompt({ template: '{{ feature . name }}', vars: baseVars })).toThrow(
      /Invalid variable expression/,
    );
    expect(() => renderCriticPrompt({ template: '{{}}', vars: baseVars })).toThrow(/Empty/);
  });

  it('rejects triple-stash {{{x}}} outright (typo guard, not silently HTML-unescaped)', () => {
    // Without rejection, mustache.js would treat `{{{phase.basRef}}}` as the
    // unescaped form, which is identical to our identity-escape `{{phase.basRef}}`
    // — but the inner-token validator can't see the surrounding `{` to flag it
    // as a typo. Reject the syntax instead.
    expect(() => renderCriticPrompt({ template: '{{{phase.id}}}', vars: baseVars })).toThrow(
      /Triple-stash/,
    );
    expect(() =>
      renderCriticPrompt({ template: 'before {{{phase.basRef}}} after', vars: baseVars }),
    ).toThrow(/Triple-stash/);
  });

  it('error message names the offending token', () => {
    try {
      renderCriticPrompt({ template: 'x {{phase.zzz}} y', vars: baseVars });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CriticPromptRenderError);
      const msg = (err as Error).message;
      expect(msg).toContain('phase.zzz');
      // Lists the closed set so users can fix typos.
      expect(msg).toContain('phase.baseRef');
    }
  });
});

describe("renderCriticPrompt — '{{> file <path>}}' partial", () => {
  it('inlines file contents inside a fenced block', () => {
    const out = renderCriticPrompt({
      template: 'before\n{{> file preamble.md}}\nafter',
      vars: baseVars,
      readFile: (p) => (p === 'preamble.md' ? 'PRE\nAMBLE' : null),
    });
    // mustache.js normalizes standalone-tag whitespace per spec — a partial on
    // its own line is treated as standalone and its surrounding newline is
    // collapsed. Users who want explicit spacing can add a blank line.
    expect(out).toContain('```\nPRE\nAMBLE\n```');
    expect(out.startsWith('before\n')).toBe(true);
    expect(out.endsWith('after')).toBe(true);
  });

  it('renders cleanly when the partial is the only thing on its line (intended usage)', () => {
    const out = renderCriticPrompt({
      template: '{{> file p.md}}',
      vars: baseVars,
      readFile: () => 'BODY',
    });
    expect(out).toBe('```\nBODY\n```');
  });

  it('strips trailing newlines from file content (single fence, no extra blank line)', () => {
    const out = renderCriticPrompt({
      template: '{{> file p.md}}',
      vars: baseVars,
      readFile: () => 'body\n\n\n',
    });
    expect(out).toBe('```\nbody\n```');
  });

  it("rejects '..' segments in partial paths (sandbox-escape guard)", () => {
    expect(() =>
      renderCriticPrompt({
        template: '{{> file ../../etc/passwd}}',
        vars: baseVars,
        readFile: () => 'should not be read',
      }),
    ).toThrow(/workspace-relative/);
  });

  it('rejects absolute partial paths', () => {
    expect(() =>
      renderCriticPrompt({
        template: '{{> file /etc/passwd}}',
        vars: baseVars,
        readFile: () => 'should not be read',
      }),
    ).toThrow(/workspace-relative/);
  });

  it('rejects non-file partial names (only `file <path>` is supported)', () => {
    expect(() =>
      renderCriticPrompt({ template: '{{> someOtherPartial}}', vars: baseVars }),
    ).toThrow(/Only '{{> file/);
  });

  it("throws when readFile is needed but wasn't supplied", () => {
    expect(() => renderCriticPrompt({ template: '{{> file p.md}}', vars: baseVars })).toThrow(
      /no file resolver was supplied/,
    );
  });

  it('throws when readFile returns null (file missing surfaces in run log)', () => {
    expect(() =>
      renderCriticPrompt({
        template: '{{> file p.md}}',
        vars: baseVars,
        readFile: () => null,
      }),
    ).toThrow(/could not be resolved/);
  });

  it('partial content is treated as LITERAL TEXT — does not recurse on {{> file ...}} inside', () => {
    // Prior behaviour (mustache.js default partials mechanism) re-parsed
    // partial content as a template, so a file that documented its own
    // include syntax (e.g. `<!-- include via {{> file foo.md}} -->`) caused
    // infinite recursion. Pre-substitution with sentinels avoids this — the
    // content shows up verbatim, including any literal `{{...}}` it carries.
    const out = renderCriticPrompt({
      template: 'before\n{{> file self.md}}\nafter',
      vars: baseVars,
      readFile: () => '<!-- include via {{> file self.md}} -->\nbody with {{phase.id}} reference',
    });
    expect(out).toContain('include via {{> file self.md}}');
    // {{phase.id}} in partial content is also literal — partial content is
    // not re-rendered against the view.
    expect(out).toContain('body with {{phase.id}} reference');
    expect(out).not.toContain('01-core'); // <- phase.id was NOT substituted inside partial
  });

  it('does not invoke readFile when no partials are used', () => {
    let calls = 0;
    const out = renderCriticPrompt({
      template: 'plain {{feature.name}}',
      vars: baseVars,
      readFile: () => {
        calls++;
        return 'whatever';
      },
    });
    expect(out).toBe('plain auth');
    expect(calls).toBe(0);
  });
});

describe('createSandboxFileResolver — symlink-escape guard', () => {
  let sandboxRoot: string;
  let outsideDir: string;
  let secretFile: string;

  beforeAll(() => {
    // Two sibling temp dirs: one is the "sandbox" mount, the other holds a
    // "host secret" the agent should never be able to read via a symlink.
    const base = mkdtempSync(join(tmpdir(), 'critic-prompt-sandbox-'));
    sandboxRoot = join(base, 'sandbox');
    outsideDir = join(base, 'outside');
    mkdirSync(sandboxRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    secretFile = join(outsideDir, 'host-secret.txt');
    writeFileSync(secretFile, 'HOST_SECRET_DO_NOT_LEAK', 'utf8');

    // Legitimate file inside the sandbox.
    writeFileSync(join(sandboxRoot, 'plan.md'), 'PLAN BODY', 'utf8');

    // Agent-controlled symlink that escapes the sandbox.
    symlinkSync(secretFile, join(sandboxRoot, 'evil.md'));

    // Symlink whose target is also inside the sandbox — should still work.
    symlinkSync(join(sandboxRoot, 'plan.md'), join(sandboxRoot, 'plan-alias.md'));

    // Nested dir + symlink at intermediate component pointing outside.
    mkdirSync(join(sandboxRoot, 'subdir'), { recursive: true });
    symlinkSync(outsideDir, join(sandboxRoot, 'subdir', 'escape-link'));
  });

  afterAll(() => {
    // Test runner cleans tmpdir on its own; nothing to do.
  });

  it('reads files inside the sandbox normally', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);
    expect(resolver('plan.md')).toBe('PLAN BODY');
  });

  it('follows in-sandbox symlinks (legitimate aliasing)', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);
    expect(resolver('plan-alias.md')).toBe('PLAN BODY');
  });

  it('THROWS on symlink-escape — never silently reads host file content', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);
    expect(() => resolver('evil.md')).toThrow(CriticPromptRenderError);
    expect(() => resolver('evil.md')).toThrow(/Symlink escape blocked/);
    // The host secret never makes it into the partial output.
    try {
      resolver('evil.md');
    } catch (err) {
      expect((err as Error).message).not.toContain('HOST_SECRET_DO_NOT_LEAK');
    }
  });

  it('THROWS on intermediate-component symlink escape', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);
    expect(() => resolver('subdir/escape-link/host-secret.txt')).toThrow(/Symlink escape blocked/);
  });

  it('returns null for missing files (renderer surfaces it as not-resolved)', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);
    expect(resolver('does-not-exist.md')).toBeNull();
  });

  it('end-to-end via renderCriticPrompt: legitimate read works, symlink escape throws', () => {
    const resolver = createSandboxFileResolver(sandboxRoot);

    const ok = renderCriticPrompt({
      template: '{{> file plan.md}}',
      vars: baseVars,
      readFile: resolver,
    });
    expect(ok).toBe('```\nPLAN BODY\n```');

    expect(() =>
      renderCriticPrompt({
        template: '{{> file evil.md}}',
        vars: baseVars,
        readFile: resolver,
      }),
    ).toThrow(/Symlink escape blocked/);
  });
});

describe('BUILTIN_FIX_TEMPLATE — saifctl-owned fix-step prompt', () => {
  // The lifecycle invariant under test: orchestrator owns findings-file
  // deletion (Block 4b post-review fix). The template MUST NOT instruct the
  // agent to delete the file, because earlier drafts had a silent-data-loss
  // bug — delete-then-verify wiped findings before retry could see them.
  // See critic-findings.ts and the BUILTIN_FIX_TEMPLATE docstring.
  const fixVars: CriticPromptVars = {
    ...baseVars,
    critic: { ...baseVars.critic, step: 'fix' },
  };

  it('renders against the closed var set with no unknown variables', () => {
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    expect(out).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it('does NOT instruct the agent to delete the findings file (saifctl owns lifecycle)', () => {
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    // The old buggy template had imperative "Delete `<findingsPath>`" as a
    // step. Reject that exact instruction shape, and make sure the template
    // explicitly negates it (so "Delete" appearing in the file is paired
    // with "Do not delete" prose, not an instruction).
    expect(out).not.toMatch(
      /^\s*[-*0-9.]*\s*\*?\*?Delete\s+`?\/workspace\/\.saifctl\/critic-findings/im,
    );
    expect(out).not.toMatch(/\brm\s+`?\/workspace\/\.saifctl\/critic-findings/);
    // The template must explicitly tell the agent NOT to delete.
    expect(out.toLowerCase()).toMatch(/do not delete the findings file/);
  });

  it('explicitly tells the agent saifctl handles findings cleanup', () => {
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    expect(out.toLowerCase()).toMatch(/saifctl.*(?:handles|owns|clean).*findings/i);
  });

  it('does NOT contradict itself about plan/spec edits under feature.dir', () => {
    // Earlier drafts said "NOT under {{feature.dir}}" then immediately said
    // "update {{feature.plan}} and spec.md" — both of which ARE under
    // feature.dir. The current template carves them out explicitly.
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    // The carve-out: only plan + spec are modifiable inside the saifctl dir.
    expect(out).toMatch(/may modify ONLY/);
    expect(out).toContain(fixVars.feature.plan);
    expect(out).toContain(fixVars.phase.spec);
  });

  it('does NOT make false claims about saifctl rejecting test edits (Block 7 not shipped)', () => {
    // The original template said "saifctl will reject writes to immutable
    // test paths and force a retry" — a false claim today (Block 7 mutability
    // enforcement isn't implemented). Make sure that wording stays out.
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    expect(out).not.toMatch(/saifctl will reject/i);
    expect(out).not.toMatch(/force a retry/i);
    expect(out).not.toMatch(/immutable test paths/i);
  });

  it("renders 'no findings' exit instruction (skip when discover found nothing)", () => {
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    expect(out).toMatch(/no findings/);
    expect(out).toMatch(/exit immediately/i);
  });

  it('uses absolute /workspace/<feature.dir>/ in the dir-scope rule (not workspace-relative ambiguity)', () => {
    const out = renderCriticPrompt({ template: BUILTIN_FIX_TEMPLATE, vars: fixVars });
    expect(out).toContain(`/workspace/${fixVars.feature.dir}/`);
  });
});

describe('renderCriticPrompt — round-trip with the §7.4 worked example', () => {
  it('renders the canonical paranoid template with no surprises', () => {
    const tpl = [
      'You are auditing the implementation of phase `{{phase.id}}` in feature',
      '`{{feature.name}}`.',
      '',
      'The plan for this feature is at `{{feature.plan}}`.',
      'The spec for this phase is at `{{phase.spec}}`.',
      'Read both before starting.',
      '',
      'Inspect with `git log {{phase.baseRef}}..HEAD` and `git diff {{phase.baseRef}}..HEAD`.',
      '',
      'This is round `{{critic.round}}` of `{{critic.totalRounds}}` for this critic.',
      'After your fixes, the tests at `{{phase.tests}}` must still pass.',
    ].join('\n');
    const out = renderCriticPrompt({ template: tpl, vars: baseVars });
    expect(out).toContain('phase `01-core`');
    expect(out).toContain('feature\n`auth`'); // line break preserved
    expect(out).toContain('git log abc1234..HEAD` and `git diff abc1234..HEAD');
    expect(out).toContain('round `1` of `2`');
    expect(out).toContain('/workspace/saifctl/features/auth/phases/01-core/tests');
  });
});
