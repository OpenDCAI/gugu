import type { AgentProviderId } from '@gugu/session-plugins/agents';

function capitalizeProviderId(providerId: AgentProviderId): string {
  return `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
}

function parseDefaultTitleIndex(title: string, providerId: AgentProviderId): number | null {
  const match = title.match(new RegExp(`^${providerId} \\(([1-9]\\d*)\\)$`, 'i'));
  if (!match) return null;

  const rawIndex = match[1];
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 1) return null;
  if (String(index) !== rawIndex) return null;
  return index;
}

/** Display the provider-generated counter title with the same casing used by the task sidebar. */
export function formatSessionTitleForDisplay(
  providerId: AgentProviderId,
  title: string,
): string {
  const index = parseDefaultTitleIndex(title, providerId);
  if (index === null) return title;
  return `${capitalizeProviderId(providerId)} (${index})`;
}
