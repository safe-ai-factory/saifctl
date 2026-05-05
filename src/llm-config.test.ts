/**
 * Unit tests for LLM config resolution and validation.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createProviderModel,
  dummyInspectLlmConfig,
  isSupportedAgentName,
  resolveAgentLlmConfig,
  resolveAgentLlmConfigForContainer,
  SUPPORTED_AGENT_NAMES,
} from './llm-config.js';

describe('llm-config', () => {
  beforeEach(() => {
    // Ensure at least one provider has a key for resolution tests
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  describe('isSupportedAgentName', () => {
    it('returns true for supported agents', () => {
      for (const name of SUPPORTED_AGENT_NAMES) {
        expect(isSupportedAgentName(name)).toBe(true);
      }
    });

    it('returns false for unknown agents', () => {
      expect(isSupportedAgentName('bad-agent')).toBe(false);
      expect(isSupportedAgentName('')).toBe(false);
      expect(isSupportedAgentName('Coder')).toBe(false); // case-sensitive
    });
  });

  describe('resolveAgentLlmConfig', () => {
    it('throws for unknown agent name', () => {
      expect(() => resolveAgentLlmConfig('unknown-agent', {})).toThrow(
        /Unknown agent "unknown-agent"/,
      );
      expect(() => resolveAgentLlmConfig('unknown-agent', {})).toThrow(
        new RegExp(SUPPORTED_AGENT_NAMES.join(', ')),
      );
    });

    it('resolves config for supported agent', () => {
      const config = resolveAgentLlmConfig('coder', {});
      expect(config.provider).toBeDefined();
      expect(config.modelId).toBeDefined();
      expect(config.apiKey).toBe('sk-test-key');
    });
  });

  describe('resolveAgentLlmConfigForContainer', () => {
    it('returns sk-none instead of throwing when no API key is present', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      // With an explicit model that would normally require a key, it should not throw.
      const config = resolveAgentLlmConfigForContainer('coder', {
        globalModel: 'openai/gpt-4o',
      });
      expect(config.apiKey).toBe('sk-none');
      expect(config.provider).toBe('openai');
      expect(config.modelId).toBe('gpt-4o');
    });

    it('returns the key when it is present', () => {
      process.env.OPENAI_API_KEY = 'sk-test-key';
      const config = resolveAgentLlmConfigForContainer('coder', {
        globalModel: 'openai/gpt-4o',
      });
      expect(config.apiKey).toBe('sk-test-key');
    });

    it('returns a no-op placeholder when no credentials and no model are provided', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const config = resolveAgentLlmConfigForContainer('coder', {});
      expect(config.apiKey).toBe('sk-none');
    });

    it('throws for unknown agent name', () => {
      expect(() => resolveAgentLlmConfigForContainer('unknown-agent', {})).toThrow(
        /Unknown agent "unknown-agent"/,
      );
    });
  });

  describe('dummyInspectLlmConfig', () => {
    it('returns a stable placeholder without reading env', () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      const c = dummyInspectLlmConfig();
      expect(c).toEqual({
        modelId: 'inspect',
        provider: 'ollama',
        fullModelString: 'ollama/inspect',
        apiKey: 'sk-none',
      });
    });
  });

  describe('createProviderModel', () => {
    // Verifies the dispatch table from Decision D-05: native SDKs for the
    // four providers without OpenAI-compatible endpoints (Anthropic,
    // Google, Vertex, OpenAI), and `@ai-sdk/openai` with a baseURL for
    // every other registered provider plus unknown providers.

    it('uses the native Anthropic SDK for the anthropic provider', () => {
      const model = createProviderModel({
        provider: 'anthropic',
        modelId: 'claude-3-5-sonnet-latest',
        fullModelString: 'anthropic/claude-3-5-sonnet-latest',
        apiKey: 'sk-ant-test',
      });
      // Anthropic SDK exposes a provider id starting with "anthropic".
      expect(model.provider).toMatch(/^anthropic/);
      expect(model.modelId).toBe('claude-3-5-sonnet-latest');
    });

    it('routes the groq provider through @ai-sdk/openai with the registered baseURL', () => {
      const model = createProviderModel({
        provider: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        fullModelString: 'groq/llama-3.3-70b-versatile',
        apiKey: 'gsk-test',
      });
      // openai-compat path → Vercel OpenAI SDK reports its provider as "openai.*".
      expect(model.provider).toMatch(/^openai/);
      expect(model.modelId).toBe('llama-3.3-70b-versatile');
    });

    it('routes the mistral provider through @ai-sdk/openai (openai-compat)', () => {
      const model = createProviderModel({
        provider: 'mistral',
        modelId: 'mistral-large-latest',
        fullModelString: 'mistral/mistral-large-latest',
        apiKey: 'mistral-test',
      });
      expect(model.provider).toMatch(/^openai/);
      expect(model.modelId).toBe('mistral-large-latest');
    });

    it('routes unknown providers through @ai-sdk/openai using the supplied baseURL', () => {
      const model = createProviderModel({
        provider: 'mythical-vendor',
        modelId: 'big-model-9000',
        fullModelString: 'mythical-vendor/big-model-9000',
        apiKey: 'unknown-test',
        baseURL: 'https://api.mythical-vendor.example.com/v1',
      });
      expect(model.provider).toMatch(/^openai/);
      expect(model.modelId).toBe('big-model-9000');
    });
  });
});
