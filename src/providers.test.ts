import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  applyProviderToEnv,
  PROVIDER_PRESETS,
  resolveProvider,
} from './providers.js';

const TMP_DIR = '/tmp/claudeclaw-providers-test';
const TMP_ENV = path.join(TMP_DIR, '.env');

function writeEnv(content: string): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(TMP_ENV, content, 'utf-8');
}

function cleanup(): void {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

describe('resolveProvider', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.LITELLM_API_KEY;
  });

  it('defaults to claude when nothing is configured', () => {
    writeEnv('');
    const r = resolveProvider();
    expect(r.id).toBe('claude');
    expect(r.baseUrl).toBe('');
  });

  it('resolves a preset from the override block', () => {
    writeEnv('OPENROUTER_API_KEY=sk-or-test\n');
    const r = resolveProvider({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(r.id).toBe('openrouter');
    expect(r.baseUrl).toBe(PROVIDER_PRESETS.openrouter.baseUrl);
    expect(r.authToken).toBe('sk-or-test');
    expect(r.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('reads LLM_PROVIDER from .env when no override is given', () => {
    writeEnv('LLM_PROVIDER=zai\nZAI_API_KEY=zai-test\n');
    const r = resolveProvider();
    expect(r.id).toBe('zai');
    expect(r.authToken).toBe('zai-test');
  });

  it('honors per-call apiKeyEnv override', () => {
    process.env.MY_CUSTOM_KEY = 'custom-key-value';
    writeEnv('');
    const r = resolveProvider({
      provider: 'openrouter',
      apiKeyEnv: 'MY_CUSTOM_KEY',
    });
    expect(r.authToken).toBe('custom-key-value');
    delete process.env.MY_CUSTOM_KEY;
  });

  it('falls back to custom for unknown provider ids', () => {
    writeEnv('');
    const r = resolveProvider({
      provider: 'totally-made-up',
      baseUrl: 'https://my-proxy/v1',
      apiKey: 'literal-key',
    });
    expect(r.id).toBe('custom');
    expect(r.baseUrl).toBe('https://my-proxy/v1');
    expect(r.authToken).toBe('literal-key');
  });

  it('prefers override.apiKey over env lookup', () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    writeEnv('');
    const r = resolveProvider({
      provider: 'openrouter',
      apiKey: 'inline-key',
    });
    expect(r.authToken).toBe('inline-key');
  });
});

describe('applyProviderToEnv', () => {
  it('is a no-op for native claude', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-anth',
      OTHER: 'preserved',
    };
    applyProviderToEnv(env, {
      id: 'claude', baseUrl: '', authToken: '', model: undefined,
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-anth');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OTHER).toBe('preserved');
  });

  it('sets BASE_URL/AUTH_TOKEN and clears native Claude creds for non-Claude providers', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-anth',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    };
    applyProviderToEnv(env, {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      authToken: 'sk-or-x',
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-x');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('throws when a non-Claude provider has no base URL', () => {
    expect(() => applyProviderToEnv({}, {
      id: 'custom', baseUrl: '', authToken: 'k', model: undefined,
    })).toThrow(/no base URL/);
  });

  it('throws when a non-Claude provider has no API key', () => {
    expect(() => applyProviderToEnv({}, {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      authToken: '',
      model: undefined,
    })).toThrow(/no API key/);
  });
});
