/**
 * Unit tests for CLI utility functions.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaifctlConfig } from '../config/schema.js';
import { consola } from '../logger.js';
import { loadAgentSecretEnvFromSecretFiles } from '../orchestrator/agent-env.js';
import {
  buildOrchestratorCliInputFromFeatArgs,
  type FeatRunArgs,
  readStorageStringFromCli,
  readStrictFromCli,
  resolveStorageOverrides,
  resolveStrictFlag,
  scriptSourcePathForReporting,
} from './utils.js';

describe('buildOrchestratorCliInputFromFeatArgs', () => {
  it('loads bundled agent scripts for --agent when install/script paths omitted', async () => {
    const cli = await buildOrchestratorCliInputFromFeatArgs({ agent: 'debug' } as FeatRunArgs, {
      projectDir: process.cwd(),
      saifctlDir: 'saifctl',
      config: {} as SaifctlConfig,
    });
    expect(cli.agentProfileId).toBe('debug');
    expect(cli.agentInstallScript).toContain('[agent-install/debug]');
    expect(cli.agentScript).toBeTruthy();
  });
});

describe('resolveStorageOverrides', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consolaErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // @ts-expect-error allow mock implementation of exit
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    consolaErrorSpy = vi.spyOn(consola, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consolaErrorSpy.mockRestore();
  });

  it('rejects unknown storage keys', () => {
    resolveStorageOverrides(readStorageStringFromCli({ storage: 'badkey=local' }), undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consolaErrorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown key "badkey"'));
  });

  it('accepts valid storage keys', () => {
    const overrides = resolveStorageOverrides(
      readStorageStringFromCli({
        storage: 'runs=local,tasks=s3://bucket/tasks',
      }),
      undefined,
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(overrides.storages).toEqual({
      runs: 'local',
      tasks: 's3://bucket/tasks',
    });
  });
});

describe('loadAgentSecretEnvFromSecretFiles', () => {
  it('parses KEY=value lines like agent-env-file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saifctl-secret-'));
    const f = join(dir, 's.env');
    writeFileSync(f, '# c\nFOO_TOKEN=bar\nBAZ=qux\n', 'utf8');
    const out = await loadAgentSecretEnvFromSecretFiles(dir, ['s.env']);
    expect(out).toEqual({ FOO_TOKEN: 'bar', BAZ: 'qux' });
  });

  it('returns {} when fileRaw is empty', async () => {
    expect(await loadAgentSecretEnvFromSecretFiles(process.cwd(), [])).toEqual({});
  });
});

describe('scriptSourcePathForReporting', () => {
  it('returns a relative path when the script is under projectDir', () => {
    const proj = resolve('/tmp/saifctl-proj');
    const script = resolve('/tmp/saifctl-proj/scripts/hook.sh');
    expect(scriptSourcePathForReporting(proj, script)).toMatch(/scripts[/\\]hook\.sh$/);
  });

  it('returns an absolute path when the script is outside projectDir', () => {
    const proj = resolve('/tmp/saifctl-proj');
    const script = resolve('/opt/saifctl/builtin.sh');
    expect(scriptSourcePathForReporting(proj, script)).toBe(script);
  });
});

// Block 7: --strict / --no-strict flag plumbing. Strict is the safe default,
// so the resolver must NEVER silently flip it to false. CLI value wins, then
// project config, then built-in true. `undefined` from the CLI is the "no
// flag passed" signal — distinguishing it from an explicit `--no-strict`
// (false) is what makes the tri-state work.
describe('readStrictFromCli', () => {
  it('returns true when --strict is passed', () => {
    expect(readStrictFromCli({ strict: true })).toBe(true);
  });
  it('returns false when --no-strict is passed', () => {
    expect(readStrictFromCli({ strict: false })).toBe(false);
  });
  it('returns undefined when neither flag is passed (delegates to config/default)', () => {
    expect(readStrictFromCli({})).toBeUndefined();
    expect(readStrictFromCli({ strict: undefined })).toBeUndefined();
  });
});

describe('resolveStrictFlag', () => {
  it('CLI true wins over config false', () => {
    expect(resolveStrictFlag({ cli: true, config: { defaults: { strict: false } } })).toBe(true);
  });
  it('CLI false wins over config true', () => {
    // The user explicitly opted out via --no-strict; respect it even when
    // config says strict.
    expect(resolveStrictFlag({ cli: false, config: { defaults: { strict: true } } })).toBe(false);
  });
  it('config wins when CLI is undefined', () => {
    expect(resolveStrictFlag({ cli: undefined, config: { defaults: { strict: false } } })).toBe(
      false,
    );
  });
  it('falls back to true when neither CLI nor config sets strict', () => {
    expect(resolveStrictFlag({ cli: undefined, config: undefined })).toBe(true);
    expect(resolveStrictFlag({ cli: undefined, config: { defaults: {} } })).toBe(true);
    expect(resolveStrictFlag({ cli: undefined, config: {} })).toBe(true);
  });
});
