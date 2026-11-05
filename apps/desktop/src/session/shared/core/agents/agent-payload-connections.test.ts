import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { agentSupportsConnectionManagement, type AgentCapabilities } from './agent-payload';

const payload = (id: string, capabilities: AgentCapabilities) => ({ id, capabilities });

describe('adapter-declared connection management', () => {
  it.each(['claude', 'codex'])('%s carries its connection panel declaration through plugin validation', id => {
    expect(agentSupportsConnectionManagement(payload(id, pluginRegistry.get(id)!.capabilities as AgentCapabilities))).toBe(true);
  });

  it.each(['claude', 'codex'])('%s normalizes old remote/cache auth without mutating the received payload', id => {
    const original = pluginRegistry.get(id)!.capabilities as AgentCapabilities;
    if (original.auth.kind !== 'supported') throw new Error('expected the real adapter auth');
    const auth = { ...original.auth };
    delete auth.connections;
    const capabilities = { ...original, auth };
    expect(agentSupportsConnectionManagement(payload(id, capabilities))).toBe(true);
    expect(capabilities.auth.connections).toBeUndefined();
  });

  it('does not infer saved connections from login or API-key methods for other adapters', () => {
    const capabilities = { auth: { kind: 'supported', methods: [
      { kind: 'cli-login', id: 'login', name: 'Login', args: ['login'] },
      { kind: 'api-key', id: 'api', name: 'API', envVars: [{ name: 'KEY', label: 'Key' }] },
    ] } } as AgentCapabilities;
    expect(agentSupportsConnectionManagement(payload('other-adapter', capabilities))).toBe(false);
    expect(agentSupportsConnectionManagement(payload('other-adapter', { ...capabilities, auth: { ...capabilities.auth, connections: { kind: 'managed' } } } as AgentCapabilities))).toBe(true);
  });

  it('does not offer a panel before metadata or auth support exists', () => {
    expect(agentSupportsConnectionManagement(null)).toBe(false);
    expect(agentSupportsConnectionManagement(undefined)).toBe(false);
    expect(agentSupportsConnectionManagement(payload('claude', { auth: { kind: 'none' } } as AgentCapabilities))).toBe(false);
  });
});
