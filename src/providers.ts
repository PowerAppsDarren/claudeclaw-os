/**
 * Multi-provider support for ClaudeClaw.
 *
 * The Claude Agent SDK speaks the Anthropic Messages API. Many providers
 * (OpenRouter, Z.AI, Kimi/Moonshot, DeepSeek, Glama, etc.) expose an
 * Anthropic-compatible endpoint, so we can drop them in by setting
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN before spawning the SDK
 * subprocess. The model id changes per provider (e.g. OpenRouter wants
 * `anthropic/claude-sonnet-4.5`, Z.AI wants `glm-4.6`).
 *
 * For providers that don't speak Anthropic at all (raw OpenAI Chat
 * Completions, raw Gemini API), the user can:
 *   - Run a local proxy such as LiteLLM that exposes an Anthropic-compatible
 *     endpoint, then point this at the proxy (`provider: custom`).
 *   - Use the dedicated CLI from that vendor (`gemini`, `codex`) directly
 *     from a Bash tool call inside an agent turn — no provider switch needed.
 *
 * Configuration sources (highest priority first):
 *   1. Per-call argument (e.g. /provider command, future API field)
 *   2. agent.yaml `provider:` and `provider_*:` fields
 *   3. .env defaults: `LLM_PROVIDER`, `LLM_PROVIDER_BASE_URL`, `LLM_PROVIDER_API_KEY_ENV`
 *   4. Built-in default: `claude` (use stock Anthropic / Claude Code auth)
 */

import { readEnvFile } from './env.js';

/** Built-in provider id. `custom` is the escape hatch for any
 *  Anthropic-compatible endpoint not in this list. */
export type ProviderId =
  | 'claude'
  | 'openrouter'
  | 'zai'
  | 'kimi'
  | 'moonshot'
  | 'deepseek'
  | 'glama'
  | 'helicone'
  | 'requesty'
  | 'litellm'
  | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  /** Human-readable name shown in the UI / Telegram. */
  label: string;
  /** Anthropic-compatible Messages endpoint. Empty = use SDK default
   *  (api.anthropic.com), i.e. native Claude. */
  baseUrl: string;
  /** Default env var holding this provider's API key. The value of the
   *  env var is what gets passed as ANTHROPIC_AUTH_TOKEN to the SDK.
   *  Empty = no key needed (e.g. native Claude with OAuth login). */
  apiKeyEnv: string;
  /** Hint string for the docs / .env.example. */
  description: string;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  claude: {
    id: 'claude',
    label: 'Anthropic (native Claude)',
    baseUrl: '',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Default. Uses Claude Code OAuth or ANTHROPIC_API_KEY.',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'Routes to 200+ models. Use model ids like `anthropic/claude-sonnet-4.5`, `openai/gpt-5`, `google/gemini-2.5-pro`.',
  },
  zai: {
    id: 'zai',
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKeyEnv: 'ZAI_API_KEY',
    description: 'GLM-4.6 / GLM-4.5. Anthropic-compatible endpoint.',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    apiKeyEnv: 'KIMI_API_KEY',
    description: 'Kimi K2 series. Anthropic-compatible endpoint.',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot AI',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    description: 'Alias for Kimi using a different env var name.',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek V3 / R1. Anthropic-compatible endpoint.',
  },
  glama: {
    id: 'glama',
    label: 'Glama',
    baseUrl: 'https://glama.ai/api/gateway/anthropic/v1',
    apiKeyEnv: 'GLAMA_API_KEY',
    description: 'Glama gateway with usage tracking.',
  },
  helicone: {
    id: 'helicone',
    label: 'Helicone (proxy)',
    baseUrl: 'https://anthropic.helicone.ai',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Helicone observability proxy in front of Anthropic.',
  },
  requesty: {
    id: 'requesty',
    label: 'Requesty',
    baseUrl: 'https://router.requesty.ai/anthropic',
    apiKeyEnv: 'REQUESTY_API_KEY',
    description: 'Requesty router with provider failover.',
  },
  litellm: {
    id: 'litellm',
    label: 'LiteLLM proxy (local)',
    baseUrl: 'http://localhost:4000',
    apiKeyEnv: 'LITELLM_API_KEY',
    description: 'Local LiteLLM proxy. Bridge to OpenAI / Gemini / Bedrock / Azure / etc.',
  },
  custom: {
    id: 'custom',
    label: 'Custom (Anthropic-compatible)',
    baseUrl: '',
    apiKeyEnv: 'CUSTOM_LLM_API_KEY',
    description: 'Any Anthropic-compatible endpoint. Set provider_base_url and provider_api_key_env explicitly.',
  },
};

/** Resolved per-turn provider state. */
export interface ResolvedProvider {
  id: ProviderId;
  /** May be empty when id === 'claude'. */
  baseUrl: string;
  /** May be empty when running native Claude with OAuth. */
  authToken: string;
  /** Original model id, untouched. The Agent SDK forwards it as-is. */
  model: string | undefined;
}

/** Per-agent provider override sourced from agent.yaml. */
export interface ProviderOverride {
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Inline key — discouraged in favor of apiKeyEnv but supported for parity. */
  apiKey?: string;
  model?: string;
}

function isProviderId(s: string): s is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, s);
}

/**
 * Resolve the active provider for a turn.
 *
 * @param override  Per-agent override loaded from agent.yaml.
 * @param model     Per-turn model id (e.g. from /model command).
 *
 * Precedence: override > .env defaults (LLM_PROVIDER) > 'claude'.
 */
export function resolveProvider(
  override?: ProviderOverride,
  model?: string,
): ResolvedProvider {
  const envDefaults = readEnvFile([
    'LLM_PROVIDER',
    'LLM_PROVIDER_BASE_URL',
    'LLM_PROVIDER_API_KEY_ENV',
  ]);

  const requested =
    override?.provider ||
    envDefaults['LLM_PROVIDER'] ||
    'claude';

  const id: ProviderId = isProviderId(requested) ? requested : 'custom';
  const preset = PROVIDER_PRESETS[id];

  const baseUrl =
    override?.baseUrl ??
    envDefaults['LLM_PROVIDER_BASE_URL'] ??
    preset.baseUrl;

  let authToken = '';
  if (override?.apiKey) {
    authToken = override.apiKey;
  } else {
    const keyEnvName =
      override?.apiKeyEnv ||
      envDefaults['LLM_PROVIDER_API_KEY_ENV'] ||
      preset.apiKeyEnv;
    if (keyEnvName) {
      const fromProcess = process.env[keyEnvName];
      if (fromProcess) {
        authToken = fromProcess;
      } else {
        const fromFile = readEnvFile([keyEnvName])[keyEnvName];
        if (fromFile) authToken = fromFile;
      }
    }
  }

  return {
    id,
    baseUrl,
    authToken,
    model: override?.model ?? model,
  };
}

/**
 * Apply a resolved provider to the env dict that gets handed to the
 * Claude Agent SDK subprocess. Mutates and returns the env. Caller is
 * expected to have already scrubbed secrets via getScrubbedSdkEnv.
 *
 * Behavior:
 *   - claude (default): no-op. SDK uses its own defaults.
 *   - everything else: sets ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.
 *     We also unset ANTHROPIC_API_KEY so the SDK doesn't accidentally
 *     send a stale Anthropic key to a third-party endpoint.
 *
 * If id !== 'claude' but no baseUrl could be resolved (custom provider
 * with nothing configured), throws — failing loud is better than silently
 * sending traffic to api.anthropic.com with a non-Anthropic key.
 */
export function applyProviderToEnv(
  env: Record<string, string | undefined>,
  resolved: ResolvedProvider,
): Record<string, string | undefined> {
  if (resolved.id === 'claude') {
    return env;
  }

  if (!resolved.baseUrl) {
    throw new Error(
      `Provider "${resolved.id}" has no base URL configured. Set provider_base_url in agent.yaml or LLM_PROVIDER_BASE_URL in .env.`,
    );
  }

  if (!resolved.authToken) {
    const keyEnv = PROVIDER_PRESETS[resolved.id].apiKeyEnv;
    throw new Error(
      `Provider "${resolved.id}" has no API key. Set ${keyEnv} in .env (or override provider_api_key_env in agent.yaml).`,
    );
  }

  env['ANTHROPIC_BASE_URL'] = resolved.baseUrl;
  env['ANTHROPIC_AUTH_TOKEN'] = resolved.authToken;
  delete env['ANTHROPIC_API_KEY'];
  delete env['CLAUDE_CODE_OAUTH_TOKEN'];

  return env;
}

/** Pretty label for cost footers, dashboard, etc. */
export function providerLabel(id: ProviderId): string {
  return PROVIDER_PRESETS[id]?.label ?? id;
}
