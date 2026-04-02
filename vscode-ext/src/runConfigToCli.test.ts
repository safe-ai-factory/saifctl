import { describe, expect, it } from 'vitest';

import { buildFeatRunCliFromArtifactConfig, isInternalBundledAssetPath } from './runConfigToCli';

describe('buildFeatRunCliFromArtifactConfig', () => {
  it('builds feat run with core flags', () => {
    const config = {
      featureName: 'feat-x',
      gitProviderId: 'github',
      testProfileId: 'vitest',
      sandboxProfileId: 'vitest',
      agentProfileId: 'openhands',
      projectDir: '/tmp/proj',
      maxRuns: 5,
      llm: {},
      saifctlDir: 'saifctl',
      projectName: 'test-pkg',
      testImage: 'test:latest',
      resolveAmbiguity: 'ai',
      dangerousNoLeash: false,
      cedarPolicyPath: '',
      coderImage: '',
      push: null,
      pr: false,
      gateRetries: 10,
      reviewerEnabled: true,
      agentEnv: {},
      agentSecretKeys: [] as string[],
      agentSecretFiles: [] as string[],
      testRetries: 1,
      stagingEnvironment: { engine: 'docker', app: {}, appEnvironment: {} },
      codingEnvironment: { engine: 'docker' },
    };

    const line = buildFeatRunCliFromArtifactConfig(config, '/tmp/proj');

    expect(line).toMatch(/^saifctl feat run/);
    expect(line).toMatch(/(?:-n|--name) (?:'feat-x'|feat-x)\b/);
    expect(line).toContain('--test-profile');
    expect(line).toContain('vitest');
    expect(line).toContain('--profile');
    expect(line).toContain('--agent openhands');
    expect(line).toContain('-p test-pkg');
    expect(line).not.toContain('--project-dir');
  });

  it('adds --project-dir when artifact dir differs from tree project path', () => {
    const config = {
      featureName: 'a',
      projectDir: '/other/root',
      saifctlDir: 'saifctl',
      projectName: 'p',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };

    const line = buildFeatRunCliFromArtifactConfig(config, '/workspace/safe-ai-factory');
    expect(line).toContain('--project-dir');
    expect(line).toContain('/other/root');
  });

  it('emits --no-reviewer when reviewer disabled', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      reviewerEnabled: false,
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };

    expect(buildFeatRunCliFromArtifactConfig(config, '/w')).toContain('--no-reviewer');
  });

  it('serializes llm config from artifact', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      llm: {
        globalModel: 'anthropic/claude-3-5-sonnet-latest',
        globalBaseUrl: 'https://api.anthropic.com/v1',
      },
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };

    const line = buildFeatRunCliFromArtifactConfig(config, '/w');
    expect(line).toContain('--model');
    expect(line).toContain('claude-3-5-sonnet-latest');
    expect(line).toContain('--base-url');
  });

  it('emits --engine when coding is not docker', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'local' },
    };

    const line = buildFeatRunCliFromArtifactConfig(config, '/w');
    expect(line).toContain('--engine');
    expect(line).toContain('coding=local');
    expect(line).toContain('staging=docker');
  });

  it('omits --cedar for bundled default policy path', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      projectDir: '/w',
      cedarPolicyPath:
        '/repo/node_modules/@safe-ai-factory/saifctl/src/orchestrator/policies/default.cedar',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };
    expect(buildFeatRunCliFromArtifactConfig(config, '/w')).not.toContain('--cedar');
  });

  it('emits --cedar for a user policy path', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      projectDir: '/w',
      cedarPolicyPath: '/w/policies/custom.cedar',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };
    const line = buildFeatRunCliFromArtifactConfig(config, '/w');
    expect(line).toContain('--cedar');
    expect(line).toContain('custom.cedar');
  });

  it('emits --gate-script when gate path is not bundled', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      projectDir: '/w',
      gateScriptFile: 'scripts/my-gate.sh',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };
    expect(buildFeatRunCliFromArtifactConfig(config, '/w')).toContain('--gate-script');
  });

  it('omits --gate-script when gate path is under saifctl package', () => {
    const config = {
      featureName: 'x',
      saifctlDir: 'saifctl',
      projectName: 'p',
      projectDir: '/w',
      gateScriptFile:
        '/x/node_modules/@safe-ai-factory/saifctl/src/sandbox-profiles/node-pnpm-python/gate.sh',
      llm: {},
      agentEnv: {},
      agentSecretKeys: [],
      agentSecretFiles: [],
      stagingEnvironment: { engine: 'docker' },
      codingEnvironment: { engine: 'docker' },
    };
    expect(buildFeatRunCliFromArtifactConfig(config, '/w')).not.toContain('--gate-script');
  });
});

describe('isInternalBundledAssetPath', () => {
  it('detects saifctl package and src policy trees', () => {
    expect(isInternalBundledAssetPath('/a/node_modules/@safe-ai-factory/saifctl/foo.cedar')).toBe(
      true,
    );
    expect(isInternalBundledAssetPath('/a/src/orchestrator/policies/default.cedar')).toBe(true);
    expect(isInternalBundledAssetPath('/a/src/sandbox-profiles/x/gate.sh')).toBe(true);
    expect(isInternalBundledAssetPath('/a/my-gate.sh')).toBe(false);
  });
});
