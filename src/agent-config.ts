import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT } from './config.js';
import { readEnvFile } from './env.js';

// Shared roster path. Written by Node on startup and any time the agent
// roster changes (new agent, deleted agent). Read by the Python Pipecat
// voice stack so new agents propagate into voice War Room without a
// full bot restart.
export const WARROOM_ROSTER_PATH = '/tmp/warroom-agents.json';

/** Single source of truth for "is this string a syntactically valid
 *  agent id?". Lifted out of the various inline copies in the dashboard
 *  HTTP layer so the avatar / chat / agent-files handlers all share one
 *  definition. Lower-case alphanumerics plus `_` and `-`; `i` flag is
 *  kept for backwards compatibility with the historical regex. */
export const AGENT_ID_RE = /^[a-z0-9_-]+$/i;

/** Cheap "does this agent exist on disk?" check. `main` always exists
 *  (it's the root process); any other id needs an `agent.yaml` next to
 *  resolveAgentDir(id). Returns false for syntactically invalid ids so
 *  callers can use this as the only existence check they need. */
export function agentExists(agentId: string): boolean {
  if (!AGENT_ID_RE.test(agentId)) return false;
  if (agentId === 'main') return true;
  try {
    const dir = resolveAgentDir(agentId);
    return fs.existsSync(path.join(dir, 'agent.yaml'));
  } catch {
    return false;
  }
}

export interface AgentConfig {
  name: string;
  description: string;
  botTokenEnv: string;
  botToken: string;
  model?: string;
  /** Optional LLM provider override. See src/providers.ts for the list of
   *  preset ids ('claude', 'openrouter', 'zai', 'kimi', 'deepseek', ...).
   *  When unset, the agent uses native Claude (or whatever LLM_PROVIDER
   *  is set in .env). */
  provider?: {
    provider?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiKey?: string;
    model?: string;
  };
  mcpServers?: string[];
  /** Per-agent war-room tool allowlist. Tokens are SDK tool names
   *  ("Bash", "Write") or "mcp:<name>" entries to opt an MCP server in.
   *  Overrides the defaults in warroom-tool-policy.ts. Unset = use
   *  defaults. */
  warroomTools?: string[];
  obsidian?: {
    vault: string;
    folders: string[];
    readOnly?: string[];
  };
  /** Pika voice id used when this agent joins a video meeting. Falls back
   *  to the Pika preset English_radiant_girl if unset. */
  meetVoiceId?: string;
  /** Display name shown in the meeting ("Your Agent wants to join"). Falls
   *  back to the agent's name or id with first letter capitalized. */
  meetBotName?: string;
}

/**
 * Resolve the directory for a given agent, checking CLAUDECLAW_CONFIG first,
 * then falling back to PROJECT_ROOT/agents/<id>.
 */
export function resolveAgentDir(agentId: string): string {
  const externalDir = path.join(CLAUDECLAW_CONFIG, 'agents', agentId);
  if (fs.existsSync(path.join(externalDir, 'agent.yaml'))) {
    return externalDir;
  }
  return path.join(PROJECT_ROOT, 'agents', agentId);
}

/**
 * Resolve the CLAUDE.md path for a given agent, checking CLAUDECLAW_CONFIG first,
 * then falling back to PROJECT_ROOT/agents/<id>/CLAUDE.md.
 */
export function resolveAgentClaudeMd(agentId: string): string | null {
  const externalPath = path.join(CLAUDECLAW_CONFIG, 'agents', agentId, 'CLAUDE.md');
  if (fs.existsSync(externalPath)) {
    return externalPath;
  }
  const repoPath = path.join(PROJECT_ROOT, 'agents', agentId, 'CLAUDE.md');
  if (fs.existsSync(repoPath)) {
    return repoPath;
  }
  return null;
}

export function loadAgentConfig(agentId: string): AgentConfig {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent config not found: ${configPath}`);
  }

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

  const name = raw['name'] as string;
  const description = (raw['description'] as string) ?? '';
  const botTokenEnv = raw['telegram_bot_token_env'] as string;
  const model = raw['model'] as string | undefined;

  if (!name || !botTokenEnv) {
    throw new Error(`Agent config ${configPath} must have 'name' and 'telegram_bot_token_env'`);
  }

  const env = readEnvFile([botTokenEnv]);
  const botToken = process.env[botTokenEnv] || env[botTokenEnv] || '';
  if (!botToken) {
    throw new Error(`Bot token not found: set ${botTokenEnv} in .env`);
  }

  let obsidian: AgentConfig['obsidian'];
  const obsRaw = raw['obsidian'] as Record<string, unknown> | undefined;
  if (obsRaw) {
    const vault = obsRaw['vault'] as string;
    if (vault && !fs.existsSync(vault)) {
      // eslint-disable-next-line no-console
      console.warn(`[${agentId}] WARNING: Obsidian vault path does not exist: ${vault}`);
      console.warn(`[${agentId}] Update obsidian.vault in agent.yaml to your local vault path.`);
    }
    obsidian = {
      vault,
      folders: (obsRaw['folders'] as string[]) ?? [],
      readOnly: (obsRaw['read_only'] as string[]) ?? [],
    };
  }

  // Provider override block. Two shapes are accepted:
  //   provider: openrouter            # short form, just the preset id
  //   provider:                       # long form for non-preset endpoints
  //     name: custom
  //     base_url: https://my-proxy/v1
  //     api_key_env: MY_KEY
  let provider: AgentConfig['provider'];
  const providerRaw = raw['provider'];
  if (typeof providerRaw === 'string') {
    provider = { provider: providerRaw };
  } else if (providerRaw && typeof providerRaw === 'object') {
    const p = providerRaw as Record<string, unknown>;
    provider = {
      provider: typeof p['name'] === 'string' ? (p['name'] as string)
        : typeof p['provider'] === 'string' ? (p['provider'] as string)
        : typeof p['id'] === 'string' ? (p['id'] as string)
        : undefined,
      baseUrl: typeof p['base_url'] === 'string' ? (p['base_url'] as string)
        : typeof p['baseUrl'] === 'string' ? (p['baseUrl'] as string)
        : undefined,
      apiKeyEnv: typeof p['api_key_env'] === 'string' ? (p['api_key_env'] as string)
        : typeof p['apiKeyEnv'] === 'string' ? (p['apiKeyEnv'] as string)
        : undefined,
      apiKey: typeof p['api_key'] === 'string' ? (p['api_key'] as string) : undefined,
      model: typeof p['model'] === 'string' ? (p['model'] as string) : undefined,
    };
  }
  // If the top-level model field exists and provider doesn't already
  // specify one, copy it across so a single `model:` declaration still
  // applies to whichever endpoint is selected.
  if (provider && !provider.model && model) {
    provider.model = model;
  }

  const mcpServers = raw['mcp_servers'] as string[] | undefined;
  // War-room tool policy override. If present in agent.yaml, this list
  // overrides the per-agent default in warroom-tool-policy.ts. Tokens
  // can be SDK tool names ("Bash", "Write") or "mcp:<name>" to opt that
  // MCP server into the war-room session.
  const warroomTools = raw['warroom_tools'] as string[] | undefined;
  const meetVoiceId = typeof raw['meet_voice_id'] === 'string' ? (raw['meet_voice_id'] as string) : undefined;
  const meetBotName = typeof raw['meet_bot_name'] === 'string' ? (raw['meet_bot_name'] as string) : undefined;

  return {
    name,
    description,
    botTokenEnv,
    botToken,
    model,
    provider,
    mcpServers,
    warroomTools,
    obsidian,
    meetVoiceId,
    meetBotName,
  };
}

/** Update the model field in an agent's agent.yaml file. */
export function setAgentModel(agentId: string, model: string): void {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw['model'] = model;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** List all configured agent IDs (directories under agents/ with agent.yaml).
 *  Scans both CLAUDECLAW_CONFIG/agents/ and PROJECT_ROOT/agents/, deduplicating.
 */
export function listAgentIds(): string[] {
  const ids = new Set<string>();

  for (const baseDir of [
    path.join(CLAUDECLAW_CONFIG, 'agents'),
    path.join(PROJECT_ROOT, 'agents'),
  ]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const d of fs.readdirSync(baseDir)) {
      if (d.startsWith('_')) continue;
      const yamlPath = path.join(baseDir, d, 'agent.yaml');
      if (fs.existsSync(yamlPath)) ids.add(d);
    }
  }

  return [...ids];
}

/** Return the capabilities (name + description) for a specific agent. */
export function getAgentCapabilities(
  agentId: string,
): { name: string; description: string } | null {
  try {
    const config = loadAgentConfig(agentId);
    return { name: config.name, description: config.description };
  } catch {
    return null;
  }
}

/**
 * List all configured agents with their descriptions.
 * Unlike `listAgentIds()`, this returns richer metadata and silently
 * skips agents whose config fails to load (e.g. missing token).
 */
export function listAllAgents(): Array<{
  id: string;
  name: string;
  description: string;
  model?: string;
}> {
  const ids = listAgentIds();
  const result: Array<{
    id: string;
    name: string;
    description: string;
    model?: string;
  }> = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      result.push({
        id,
        name: config.name,
        description: config.description,
        model: config.model,
      });
    } catch {
      // Skip agents with broken config
    }
  }

  return result;
}

/**
 * Write the current agent roster to the path the Python Pipecat voice
 * stack reads from. Call this:
 *   - On main-bot startup (index.ts does this already)
 *   - After creating or deleting an agent (agent-create flow)
 *   - Before /warroom/text turns (orchestrator does this cheaply too)
 *
 * The file is read-only metadata: id, name, description. The voice
 * server kills + respawns its subprocess when this changes if callers
 * want the new roster to take effect immediately.
 */
export function refreshWarRoomRoster(): void {
  try {
    const ids = ['main', ...listAgentIds().filter((id) => id !== 'main')];
    const roster = ids.map((id) => {
      try {
        if (id === 'main') return { id: 'main', name: 'Main', description: 'General ops and triage' };
        const cfg = loadAgentConfig(id);
        return { id, name: cfg.name || id, description: cfg.description || '' };
      } catch {
        return { id, name: id, description: '' };
      }
    });
    fs.writeFileSync(WARROOM_ROSTER_PATH, JSON.stringify(roster, null, 2));
  } catch {
    // Non-fatal. Voice stack falls back to the built-in default roster
    // if the file is missing.
  }
}
