import type { CostFooterMode } from './config.js';
import type { UsageInfo } from './agent.js';

/**
 * Format token counts for display.
 * 45000 -> "45k", 1200000 -> "1.2M", 500 -> "500"
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Build a cost footer string to append to Telegram responses.
 * Returns empty string if mode is 'off' or no usage data.
 *
 * Modes:
 *   'compact' - model name only (good for subscription users)
 *   'verbose' - model + token counts
 *   'cost'    - model + cost (for pay-per-use users)
 *   'full'    - model + tokens + cost
 *   'off'     - nothing
 */
export function buildCostFooter(
  mode: CostFooterMode,
  usage: UsageInfo | null,
  model?: string,
): string {
  if (mode === 'off' || !usage) return '';

  const modelLabel = model
    ? model.replace('claude-', '').replace(/-\d+[-\d]*$/, '')
    : 'unknown';

  // Non-Claude providers (OpenRouter, Z.AI, Kimi, ...) come back through
  // the Anthropic-shaped Messages API but their pricing isn't Anthropic
  // pricing. The SDK's total_cost_usd is computed against Anthropic rates
  // and is meaningless (often $0.00) for third-party endpoints. Show the
  // provider tag instead of a fake dollar amount.
  const isNativeClaude = !usage.provider || usage.provider === 'claude';
  const formatCost = (): string =>
    isNativeClaude
      ? `$${usage.totalCostUsd.toFixed(2)}`
      : `${usage.provider} (cost n/a)`;

  if (mode === 'compact') {
    const tag = isNativeClaude ? modelLabel : `${modelLabel} via ${usage.provider}`;
    return `\n\n[${tag}]`;
  }

  if (mode === 'verbose') {
    const inTokens = formatTokens(usage.inputTokens);
    const outTokens = formatTokens(usage.outputTokens);
    const tag = isNativeClaude ? modelLabel : `${modelLabel} via ${usage.provider}`;
    return `\n\n[${tag} | ${inTokens} in | ${outTokens} out]`;
  }

  if (mode === 'cost') {
    return `\n\n[${modelLabel} | ${formatCost()}]`;
  }

  if (mode === 'full') {
    const inTokens = formatTokens(usage.inputTokens);
    const outTokens = formatTokens(usage.outputTokens);
    return `\n\n[${modelLabel} | ${inTokens} in | ${outTokens} out | ${formatCost()}]`;
  }

  return '';
}
