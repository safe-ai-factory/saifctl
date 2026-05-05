/**
 * Renderer for critic prompt templates (Block 4 of TODO_phases_and_critics).
 *
 * Closed variable set (§7.2):
 *   feature.{name,dir,plan}
 *   phase.{id,dir,spec,baseRef,tests}
 *   critic.{id,round,totalRounds}
 *
 * One partial (§7.3): `{{> file <workspace-relative-path>}}` — inlines the
 * file's contents inside a fenced code block so prose vs. file content stays
 * unambiguous in the rendered prompt.
 *
 * Built on mustache.js with two saifctl-specific guarantees on top:
 *
 * 1. **Closed variable set, fail-loud on typos.** mustache.js renders unknown
 *    variables as empty strings; we pre-scan the template and throw
 *    `CriticPromptRenderError` when a token references a var outside the
 *    documented set. Catches typos like `{{phase.basRef}}` instead of letting
 *    them silently disappear into a fresh-LLM-per-round prompt.
 *
 * 2. **Custom `file` partial with workspace-relative path constraints.** The
 *    standard mustache `{{> name}}` partial form is reused — partial name is
 *    `file <path>`. The path is workspace-relative and rejected if it escapes
 *    the sandbox (no `..`, no absolute paths) — same rule the schema applies
 *    to `phase.spec` and `tests.immutable-files`.
 *
 * No HTML escaping — these prompts go to LLMs, not browsers. We override
 * mustache's default escape with the identity function on a per-render basis
 * so the global default isn't mutated.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import Mustache from 'mustache';

/** Closed view shape passed to the renderer. */
export interface CriticPromptVars {
  feature: {
    /** `featureName` from compile opts (e.g. 'auth'). */
    name: string;
    /** Workspace-relative feature dir (e.g. 'saifctl/features/auth'). */
    dir: string;
    /** Container path to plan.md (e.g. '/workspace/saifctl/features/auth/plan.md'). */
    plan: string;
  };
  phase: {
    id: string;
    /** Container path to the phase dir. */
    dir: string;
    /** Container path to the phase spec file. */
    spec: string;
    /**
     * Git rev at the start of this phase's implementer subtask. Captured at
     * runtime by the loop and passed in just before the critic subtask
     * becomes the active row. May be the empty string in dry-run / preview
     * contexts (`feat phases compile`); production renders always supply a
     * real rev.
     */
    baseRef: string;
    /** Container path to the phase tests dir. */
    tests: string;
  };
  critic: {
    id: string;
    round: number;
    totalRounds: number;
    /**
     * Which step of the (discover, fix) pair this template is for. Discover
     * uses the user's `critics/<id>.md`; fix uses {@link BUILTIN_FIX_TEMPLATE}.
     * The renderer doesn't switch templates itself — the caller picks; the
     * variable is exposed so templates can branch their wording on it if
     * they ever need to.
     */
    step: 'discover' | 'fix';
    /**
     * Container-side path to the temp findings file shared between this
     * round's discover + fix subtasks. Discover writes to it; fix reads,
     * applies, deletes.
     */
    findingsPath: string;
  };
}

/** Closed list — every dotted path that resolves cleanly. Used in error messages. */
export const CRITIC_PROMPT_VARS = [
  'feature.name',
  'feature.dir',
  'feature.plan',
  'phase.id',
  'phase.dir',
  'phase.spec',
  'phase.baseRef',
  'phase.tests',
  'critic.id',
  'critic.round',
  'critic.totalRounds',
  'critic.step',
  'critic.findingsPath',
] as const;
const CRITIC_PROMPT_VAR_SET = new Set<string>(CRITIC_PROMPT_VARS);

/**
 * Reads a file by workspace-relative path and returns its contents. Used by
 * the `{{> file <path>}}` partial. Implementations resolve the path against
 * the sandbox code dir at runtime; for tests, supply a stub.
 *
 * Returning `null` is treated the same as throwing — we convert to a
 * `CriticPromptRenderError` with the offending path so a missing-preamble
 * bug surfaces in the run log instead of silently producing an empty fence
 * block.
 */
export type CriticPromptFileResolver = (workspaceRelativePath: string) => string | null;

export class CriticPromptRenderError extends Error {
  override readonly name = 'CriticPromptRenderError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Render a critic prompt template against the closed variable set + optional
 * file partials.
 *
 * @throws {CriticPromptRenderError} on unknown variables, unsupported section
 *   syntax, malformed partials, or partial files that the resolver couldn't
 *   read. The error message names the offending token so the user can locate
 *   it in their template.
 */
export function renderCriticPrompt(opts: {
  template: string;
  vars: CriticPromptVars;
  /**
   * Resolves `{{> file <path>}}` partials to file contents. Optional —
   * templates that don't use the partial render fine without it.
   */
  readFile?: CriticPromptFileResolver;
}): string {
  const { template, vars, readFile } = opts;

  // 1. Validate every token before mustache renders. This is the closed-var
  //    enforcement — we cannot do this from inside the partials function
  //    because mustache.js never calls a hook for plain {{var}} lookups.
  validateTokens(template);

  // 2. Pre-substitute partials BEFORE handing the template to mustache, so
  //    partial content is treated as literal text (not a nested template).
  //    Two reasons we don't use mustache's built-in partials mechanism:
  //
  //    a. **Infinite-recursion / re-expansion footgun.** mustache.js parses
  //       partial output as a template fragment. A file that documents the
  //       partial syntax (e.g. an HTML comment containing the literal
  //       `{{> file <path>}}`) would recursively expand itself. Pre-
  //       substituting once with a sentinel avoids this entirely.
  //    b. **Predictable semantics.** With pre-substitution, `{{phase.id}}`
  //       hiding in a referenced file is rendered verbatim, not substituted
  //       — partial content is text, not a template. Critic templates that
  //       want to interpolate a variable should put it in the template
  //       directly, not in a referenced file.
  //
  //    Sentinels use NULL bytes (`\x00`) — invalid in UTF-8 prose and
  //    trivially impossible to clash with template content.
  //
  //    User-facing consequence (worth surfacing because it bit a real user):
  //    the inlined file ships verbatim into the LLM prompt, INCLUDING any
  //    HTML comments or editorial commentary the author put in. Partial
  //    files should contain LLM-direct content only, not author-aimed prose.
  //    Author-aimed docs go in a sibling README that isn't inlined. See
  //    saifctl/features/_phases-example/_README.md "Authoring partial files".
  const { rewritten, restorations } = substitutePartials(template, readFile);

  // 3. Disable HTML escaping for this render only — we're producing LLM
  //    prompts, not browser output. Restore the default afterwards so other
  //    parts of the codebase using mustache (none today, but cheap insurance)
  //    aren't affected by a global mutation.
  const prevEscape = Mustache.escape;
  let rendered: string;
  try {
    Mustache.escape = (s: unknown): string => (typeof s === 'string' ? s : String(s));
    rendered = Mustache.render(rewritten, vars);
  } finally {
    Mustache.escape = prevEscape;
  }

  // 4. Restore partial content. Sentinels are NULL-byte delimited; loop until
  //    none remain (they don't contain mustache syntax so a single pass is
  //    sufficient, but the loop is robust against future changes).
  for (const [sentinel, content] of restorations) {
    rendered = rendered.split(sentinel).join(content);
  }
  return rendered;
}

/** Internal — recognises `{{> file <path>}}` in a template string. */
const PARTIAL_RE = /\{\{>\s*([^{}]+?)\s*\}\}/g;

/**
 * Walk the template, validate + read every `{{> file <path>}}` partial, and
 * replace each with a NULL-byte-delimited sentinel. Returns the rewritten
 * template plus a `Map<sentinel, fenced-content>` for post-render restoration.
 *
 * Throws {@link CriticPromptRenderError} on:
 * - non-`file` partial names,
 * - empty / `..`-containing / absolute paths,
 * - missing readFile resolver,
 * - missing files (resolver returns `null`),
 * - sandbox escape (resolver throws).
 */
function substitutePartials(
  template: string,
  readFile: CriticPromptFileResolver | undefined,
): { rewritten: string; restorations: Map<string, string> } {
  const restorations = new Map<string, string>();
  let counter = 0;
  const rewritten = template.replace(PARTIAL_RE, (_match, raw: string) => {
    const name = raw.trim();
    if (!name.startsWith('file ')) {
      throw new CriticPromptRenderError(
        `Unsupported partial '{{> ${name}}}'. Only '{{> file <workspace-relative-path>}}' is supported.`,
      );
    }
    const path = name.slice('file '.length).trim();
    if (!path) {
      throw new CriticPromptRenderError("Partial '{{> file ...}}' requires a path.");
    }
    if (path.includes('..') || path.startsWith('/')) {
      throw new CriticPromptRenderError(
        `Partial path '${path}' must be workspace-relative; no '..' segments, no absolute paths.`,
      );
    }
    if (!readFile) {
      throw new CriticPromptRenderError(
        `Partial '{{> file ${path}}}' used but no file resolver was supplied to the renderer.`,
      );
    }
    // Note: a malicious resolver may throw (e.g. sandbox escape). Let it
    // propagate as CriticPromptRenderError per the resolver contract.
    const content = readFile(path);
    if (content === null) {
      throw new CriticPromptRenderError(
        `Partial '{{> file ${path}}}' could not be resolved (file not found in sandbox).`,
      );
    }
    const fenced = '```\n' + content.replace(/\n+$/u, '') + '\n```';
    const sentinel = `\x00CRITIC_PROMPT_PARTIAL_${counter++}\x00`;
    restorations.set(sentinel, fenced);
    return sentinel;
  });
  return { rewritten, restorations };
}

/**
 * Build a {@link CriticPromptFileResolver} that reads files from inside
 * `sandboxRoot` and refuses any path that resolves *outside* that root via
 * symlink chains.
 *
 * **Why not `readFileSync(join(sandboxRoot, p), 'utf8')`?**
 *   `readFileSync` follows symlinks transparently. The agent runs inside the
 *   container with `/workspace` bind-mounted to `sandboxRoot`, and can create
 *   arbitrary files there. If a critic template uses
 *   `{{> file plan.md}}` and the agent has replaced `plan.md` with a symlink
 *   to `/etc/passwd`, the host-side renderer would inline host secrets into
 *   the next critic's LLM prompt. The template-side path validator
 *   (`..`/absolute-path rejection) does not catch this — those checks see
 *   only the user-authored partial argument.
 *
 * Containment check: resolve both the sandbox root and the requested file
 * via `realpathSync`, then verify the resolved file is `=== root` or starts
 * with `root + sep`. Sandbox escapes throw {@link CriticPromptRenderError}
 * (loud, distinguishable from "file not found") so a malicious symlink
 * surfaces in the run log instead of silently producing an empty fence.
 *
 * Missing files return `null` (the resolver contract); the renderer turns
 * that into a CriticPromptRenderError with the offending path.
 */
export function createSandboxFileResolver(sandboxRoot: string): CriticPromptFileResolver {
  // Canonicalise the root once — macOS `/tmp → /private/tmp`, container
  // bind-mounts that resolve through `/var → /private/var`, etc. Without
  // this, a perfectly legitimate file inside the sandbox would compare-fail
  // against the un-canonicalised root prefix.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(sandboxRoot);
  } catch {
    canonicalRoot = resolve(sandboxRoot);
  }
  const rootWithSep = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;

  return (workspaceRelativePath) => {
    const requested = join(canonicalRoot, workspaceRelativePath);
    let resolved: string;
    try {
      resolved = realpathSync(requested);
    } catch {
      // File doesn't exist (or unreadable) — surfaces as "could not be
      // resolved" via the renderer's null-return path.
      return null;
    }
    if (resolved !== canonicalRoot && !resolved.startsWith(rootWithSep)) {
      throw new CriticPromptRenderError(
        `Partial '{{> file ${workspaceRelativePath}}}' resolves to '${resolved}' ` +
          `which is outside the sandbox root '${canonicalRoot}'. ` +
          `Symlink escape blocked — the agent cannot use the file partial to read host files.`,
      );
    }
    try {
      return readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  };
}

const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const VAR_PATH_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/**
 * Walk every `{{ ... }}` token in the template and reject anything outside
 * the closed contract:
 *
 * - Section / inverted-section / closing tokens (`#`, `^`, `/`).
 * - Empty tokens (`{{}}`).
 * - Variables not in {@link CRITIC_PROMPT_VARS}.
 *
 * Partials (`>`) are passed through to mustache.js, which calls our resolver.
 * Comments (`!`) and triple-stash (`{{{...}}}`) are not supported and would
 * fail the var-path regex; they error out here.
 */
function validateTokens(template: string): void {
  // Triple-stash `{{{x}}}` is mustache's "render unescaped" form. We've already
  // disabled HTML escaping per-render, so triple-stash is at best redundant
  // noise. More importantly, the regex below skips the inner `{` and would
  // miss the surrounding triple-brace context entirely — leaving a foot-gun
  // where typos like `{{{phase.basRef}}}` would render as the empty string.
  // Reject the syntax outright; templates that need a literal `{{{` can split
  // it across lines or characters.
  if (template.includes('{{{')) {
    throw new CriticPromptRenderError(
      `Triple-stash tokens like '{{{x}}}' are not supported. Critic prompts use the ` +
        `closed variable set with '{{x}}' (HTML escaping is already disabled per-render).`,
    );
  }
  const tokens = template.matchAll(TOKEN_RE);
  for (const m of tokens) {
    const inner = (m[1] ?? '').trim();
    if (inner.startsWith('>')) continue;
    if (inner === '') {
      throw new CriticPromptRenderError(`Empty template token '{{${m[1]}}}'.`);
    }
    if (inner.startsWith('#') || inner.startsWith('^') || inner.startsWith('/')) {
      throw new CriticPromptRenderError(
        `Unsupported template token '{{${inner}}}'. Critic prompts use a closed variable set ` +
          `(no sections, no loops): ${CRITIC_PROMPT_VARS.join(', ')}.`,
      );
    }
    // Strip the optional triple-stash syntax: mustache treats `{{{x}}}` as
    // unescaped — but our default is already unescaped, so the third brace
    // is redundant noise we'd rather reject than silently accept.
    const head = inner.startsWith('&') ? inner.slice(1).trim() : inner;
    if (!VAR_PATH_RE.test(head)) {
      throw new CriticPromptRenderError(
        `Invalid variable expression '{{${inner}}}'. Variables must be dotted identifiers ` +
          `from the closed set: ${CRITIC_PROMPT_VARS.join(', ')}.`,
      );
    }
    if (!CRITIC_PROMPT_VAR_SET.has(head)) {
      throw new CriticPromptRenderError(
        `Unknown variable '${head}' in critic prompt. Allowed: ${CRITIC_PROMPT_VARS.join(', ')}.`,
      );
    }
  }
}

/**
 * Built-in template for the **fix** step of a critic round (§7.5).
 *
 * Saifctl-owned, not user-provided. The agent reads the findings file written
 * by the matching `discover` step and applies every fix in code. Empty /
 * `no findings` (case-insensitive, possibly surrounded by whitespace) ⇒
 * no-op exit.
 *
 * **Findings-file lifecycle is owned by the orchestrator, not this template.**
 * On a successful fix subtask (gate tests pass), the loop deletes the file
 * via {@link cleanupFindingsForFixRow} in `critic-findings.ts`. This is
 * intentional — earlier drafts of this template told the agent to delete the
 * file as the last step before verifying tests, but that order had a
 * silent-data-loss bug: a test failure after deletion wiped the findings
 * before the gate's reset+retry path could re-read them, turning the whole
 * critic round into a no-op while the implementer's bugs remained.
 *
 * Renders against the same closed variable set as user critic templates;
 * `critic.step` is always `'fix'` here. Power users can shadow this template
 * later via a per-critic override (`critics/<id>.fix.md`) — out of scope for
 * v1.
 */
export const BUILTIN_FIX_TEMPLATE = `\
You are the **fix** step for the '{{critic.id}}' critic in phase \`{{phase.id}}\` of feature \`{{feature.name}}\`.

The discover step wrote its findings to \`{{critic.findingsPath}}\`. Read that file first.

If the file is empty, missing, or contains exactly the text \`no findings\` (case-insensitive, possibly with leading/trailing whitespace), then the discover step found no issues. Exit immediately — your work is done. Saifctl will clean up the findings file when this subtask completes.

Otherwise, the file is a markdown checklist of issues. For each item:

- Apply the fix in the code under \`/workspace\`. Within \`/workspace/{{feature.dir}}/\`, you may modify ONLY \`{{feature.plan}}\` (this feature's plan) and \`{{phase.spec}}\` (this phase's spec) — and only when your fix genuinely deviates from them, in which case update them to match what you actually built. Do NOT modify any other file under \`/workspace/{{feature.dir}}/\`.
- Do NOT edit tests under \`{{phase.tests}}\` to make a failing test pass. Updating a test is appropriate only when the spec or the finding itself explicitly calls for a contract change.

After every item is addressed, verify that the tests at \`{{phase.tests}}\` still pass.

**Do not delete the findings file yourself.** Saifctl owns that lifecycle: on a successful fix (gate tests pass), the file is removed automatically. If the gate fails, your changes are reset and you'll be re-invoked with the same findings file still in place — fix whatever you missed and try again.

This is round {{critic.round}} of {{critic.totalRounds}} for the '{{critic.id}}' critic.
`;

