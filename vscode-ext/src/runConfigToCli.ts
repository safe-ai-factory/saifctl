/**
 * Build a `saifctl feat run ...` shell command from a persisted run artifact `config` object.
 * Omits script bodies and path mirrors; maps fields that have CLI equivalents.
 */

import { isAbsolute, normalize, resolve } from 'node:path';

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_/@:.,+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pathsEffectivelyEqual(a: string, b: string): boolean {
  try {
    return normalize(resolve(a)) === normalize(resolve(b));
  } catch {
    return a === b;
  }
}

/**
 * True when the path points at scripts/policies shipped with saifctl (or pnpm’s nested copy),
 * so replaying a feat run should rely on `--profile` / defaults instead of emitting path flags.
 */
export function isInternalBundledAssetPath(absoluteResolvedPath: string): boolean {
  const n = normalize(absoluteResolvedPath).replace(/\\/g, '/');
  if (n.includes('/node_modules/@safe-ai-factory/saifctl/')) return true;
  if (/\/\.pnpm\/[^/]*@safe-ai-factory\+saifctl@/.test(n)) return true;
  if (n.includes('/src/orchestrator/policies/') && n.endsWith('.cedar')) return true;
  if (n.includes('/src/sandbox-profiles/')) return true;
  if (n.includes('/src/agent-profiles/')) return true;
  if (n.includes('/src/test-profiles/')) return true;
  return false;
}

function resolveAgainstProject(projectDir: string, p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return trimmed;
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectDir, trimmed);
}

/**
 * Path suitable for a CLI flag: project-relative when under `projectDir`, else absolute.
 */
function cliPathForFlag(opts: {
  projectDir: string;
  absolutePath: string;
  stored: string;
}): string {
  const { projectDir, absolutePath, stored } = opts;
  const proj = normalize(resolve(projectDir));
  const abs = normalize(resolve(absolutePath));
  if (abs.startsWith(proj + '/') || abs === proj) {
    const rel = stored.trim();
    if (rel && !isAbsolute(rel) && !rel.startsWith('..')) return rel;
  }
  return abs;
}

function maybeEmitScriptPathFlag(opts: {
  flag: string;
  fileField: unknown;
  projectDir: string;
  q: (flag: string, value: string) => void;
}): void {
  const { flag, fileField, projectDir, q } = opts;
  const raw = str(fileField);
  if (!raw) return;
  const abs = resolveAgainstProject(projectDir, raw);
  if (!abs || isInternalBundledAssetPath(abs)) return;
  q(flag, cliPathForFlag({ projectDir, absolutePath: abs, stored: raw }));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function engineOf(env: unknown): string | undefined {
  const r = asRecord(env);
  const e = r?.engine;
  return typeof e === 'string' ? e : undefined;
}

/**
 * Serialize `agentEnv` record to one `--agent-env` value (comma-separated KEY=VAL).
 * Values must not contain commas per CLI rules.
 */
function formatAgentEnvRecord(env: unknown): string | undefined {
  const r = asRecord(env);
  if (!r || Object.keys(r).length === 0) return undefined;
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'string' || v.includes(',')) return undefined;
    pairs.push(`${k}=${v}`);
  }
  return pairs.join(',');
}

function appendModelFlags(parts: string[], llm: unknown): void {
  const o = asRecord(llm);
  if (!o) return;

  const globalModel = str(o.globalModel);
  const globalBaseUrl = str(o.globalBaseUrl);
  const agentModels = asRecord(o.agentModels);
  const agentBaseUrls = asRecord(o.agentBaseUrls);

  const modelParts: string[] = [];
  if (globalModel) modelParts.push(globalModel);
  if (agentModels) {
    for (const [agent, model] of Object.entries(agentModels)) {
      if (typeof model === 'string') modelParts.push(`${agent}=${model}`);
    }
  }
  if (modelParts.length > 0) {
    parts.push('--model', shellQuote(modelParts.join(',')));
  }

  const urlParts: string[] = [];
  if (globalBaseUrl) urlParts.push(globalBaseUrl);
  if (agentBaseUrls) {
    for (const [agent, url] of Object.entries(agentBaseUrls)) {
      if (typeof url === 'string') urlParts.push(`${agent}=${url}`);
    }
  }
  if (urlParts.length > 0) {
    parts.push('--base-url', shellQuote(urlParts.join(',')));
  }
}

/**
 * Returns a single line suitable for pasting into a shell (paths quoted).
 */
export function buildFeatRunCliFromArtifactConfig(
  config: Record<string, unknown>,
  projectPath: string,
): string {
  const parts: string[] = ['saifctl', 'feat', 'run'];
  const q = (flag: string, value: string): void => {
    parts.push(flag, shellQuote(value));
  };

  const featureName = str(config.featureName);
  if (featureName) {
    q('-n', featureName);
  }

  const saifctlDir = str(config.saifctlDir);
  if (saifctlDir && saifctlDir !== 'saifctl') {
    q('--saifctl-dir', saifctlDir);
  }

  const projectDir = str(config.projectDir);
  if (projectDir && !pathsEffectivelyEqual(projectDir, projectPath)) {
    q('--project-dir', projectDir);
  }

  const projectName = str(config.projectName);
  if (projectName) {
    q('-p', projectName);
  }

  const testProfileId = str(config.testProfileId);
  if (testProfileId) {
    q('--test-profile', testProfileId);
  }

  const sandboxProfileId = str(config.sandboxProfileId);
  if (sandboxProfileId) {
    q('--profile', sandboxProfileId);
  }

  const agentProfileId = str(config.agentProfileId);
  if (agentProfileId) {
    q('--agent', agentProfileId);
  }

  const maxRuns = num(config.maxRuns);
  if (maxRuns !== undefined) {
    q('--max-runs', String(maxRuns));
  }

  const testRetries = num(config.testRetries);
  if (testRetries !== undefined) {
    q('--test-retries', String(testRetries));
  }

  const gateRetries = num(config.gateRetries);
  if (gateRetries !== undefined) {
    q('--gate-retries', String(gateRetries));
  }

  const resolveAmbiguity = str(config.resolveAmbiguity);
  if (resolveAmbiguity) {
    q('--resolve-ambiguity', resolveAmbiguity);
  }

  if (bool(config.reviewerEnabled) === false) {
    parts.push('--no-reviewer');
  }

  if (bool(config.dangerousNoLeash) === true) {
    parts.push('--dangerous-no-leash');
  }

  const projectDirForPaths = str(config.projectDir) ?? projectPath;
  const cedarPolicyPath = str(config.cedarPolicyPath);
  if (cedarPolicyPath) {
    const abs = resolveAgainstProject(projectDirForPaths, cedarPolicyPath);
    if (abs && !isInternalBundledAssetPath(abs)) {
      q(
        '--cedar',
        cliPathForFlag({
          projectDir: projectDirForPaths,
          absolutePath: abs,
          stored: cedarPolicyPath,
        }),
      );
    }
  }

  maybeEmitScriptPathFlag({
    flag: '--startup-script',
    fileField: config.startupScriptFile,
    projectDir: projectDirForPaths,
    q,
  });
  maybeEmitScriptPathFlag({
    flag: '--gate-script',
    fileField: config.gateScriptFile,
    projectDir: projectDirForPaths,
    q,
  });
  maybeEmitScriptPathFlag({
    flag: '--stage-script',
    fileField: config.stageScriptFile,
    projectDir: projectDirForPaths,
    q,
  });
  maybeEmitScriptPathFlag({
    flag: '--test-script',
    fileField: config.testScriptFile,
    projectDir: projectDirForPaths,
    q,
  });
  maybeEmitScriptPathFlag({
    flag: '--agent-install-script',
    fileField: config.agentInstallScriptFile,
    projectDir: projectDirForPaths,
    q,
  });
  maybeEmitScriptPathFlag({
    flag: '--agent-script',
    fileField: config.agentScriptFile,
    projectDir: projectDirForPaths,
    q,
  });

  const coderImage = str(config.coderImage);
  if (coderImage) {
    q('--coder-image', coderImage);
  }

  const testImage = str(config.testImage);
  if (testImage) {
    q('--test-image', testImage);
  }

  if (bool(config.includeDirty) === true) {
    parts.push('--include-dirty');
  }

  const push = config.push;
  if (typeof push === 'string' && push.length > 0) {
    q('--push', push);
  }

  if (bool(config.pr) === true) {
    parts.push('--pr');
  }

  const targetBranch = str(config.targetBranch);
  if (targetBranch) {
    q('--branch', targetBranch);
  }

  const gitProviderId = str(config.gitProviderId);
  if (gitProviderId) {
    q('--git-provider', gitProviderId);
  }

  if (bool(config.verbose) === true) {
    parts.push('--verbose');
  }

  const agentEnvStr = formatAgentEnvRecord(config.agentEnv);
  if (agentEnvStr) {
    q('--agent-env', agentEnvStr);
  }

  const secretKeys = config.agentSecretKeys;
  if (Array.isArray(secretKeys) && secretKeys.length > 0) {
    const keys = secretKeys.filter((k): k is string => typeof k === 'string');
    if (keys.length > 0) {
      q('--agent-secret', keys.join(','));
    }
  }

  const secretFiles = config.agentSecretFiles;
  if (Array.isArray(secretFiles) && secretFiles.length > 0) {
    const files = secretFiles.filter((f): f is string => typeof f === 'string');
    if (files.length > 0) {
      q('--agent-secret-file', files.join(','));
    }
  }

  appendModelFlags(parts, config.llm);

  const codingEngine = engineOf(config.codingEnvironment);
  const stagingEngine = engineOf(config.stagingEnvironment);
  if (codingEngine && stagingEngine) {
    if (codingEngine !== 'docker' || stagingEngine !== 'docker') {
      q('--engine', `coding=${codingEngine},staging=${stagingEngine}`);
    }
  } else if (codingEngine && codingEngine !== 'docker') {
    q('--engine', `coding=${codingEngine}`);
  } else if (stagingEngine && stagingEngine !== 'docker') {
    q('--engine', `staging=${stagingEngine}`);
  }

  return parts.join(' ');
}
