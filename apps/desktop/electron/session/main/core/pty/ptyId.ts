import { asAgentProviderId, pluginRegistry, type AgentProviderId } from '@gugu/session-plugins/agents';

const CONV_SEP = '-conv-';

function providerIdsLongestFirst(): AgentProviderId[] {
  return pluginRegistry
    .ids()
    .map(asAgentProviderId)
    .sort((a, b) => b.length - a.length);
}

export function makePtyId(provider: AgentProviderId | 'shell', sessionId: string): string {
  return `${provider}${CONV_SEP}${sessionId}`;
}

export function parsePtyId(id: string): {
  providerId: AgentProviderId | 'shell';
  sessionId: string;
} | null {
  // Try 'shell' sentinel first, then all known provider IDs longest-first to avoid prefix collisions.
  const candidates: Array<AgentProviderId | 'shell'> = ['shell', ...providerIdsLongestFirst()];
  for (const pid of candidates) {
    const prefix = pid + CONV_SEP;
    if (id.startsWith(prefix)) {
      return { providerId: pid, sessionId: id.slice(prefix.length) };
    }
  }
  return null;
}
