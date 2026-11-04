import type { AgentAuthDescriptor } from '@gugu/session-core/agents/plugins';

const managedConnections = { kind: 'managed' } as const;
export const CLAUDE_AUTH_CONNECTIONS = managedConnections;
export const CODEX_AUTH_CONNECTIONS = managedConnections;

// Browser-safe adapter defaults. Old servers and cached payloads predate this optional
// field; use the same declaration as the adapter without guessing from login methods.
const adapterConnectionDefaults = new Map([
  ['claude', CLAUDE_AUTH_CONNECTIONS],
  ['codex', CODEX_AUTH_CONNECTIONS],
]);

export function normalizeAgentAuthCapabilities(
  providerId: string | undefined,
  auth: AgentAuthDescriptor | undefined,
): AgentAuthDescriptor | undefined {
  if (auth?.kind !== 'supported' || auth.connections !== undefined) return auth;
  const connections = providerId ? adapterConnectionDefaults.get(providerId) : undefined;
  return connections ? { ...auth, connections } : auth;
}
