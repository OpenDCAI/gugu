import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { agentSupportsConnectionManagement, type AgentCapabilities } from './agent-payload';

describe('adapter-declared connection management', () => {
  it.each(['claude', 'codex'])('%s carries its connection panel declaration through plugin validation', id => {
    expect(agentSupportsConnectionManagement(pluginRegistry.get(id)!.capabilities as AgentCapabilities)).toBe(true);
  });

  it('does not infer saved connections from login or API-key methods', () => {
    const capabilities = { auth: { kind: 'supported', methods: [
      { kind: 'cli-login', id: 'login', name: 'Login', args: ['login'] },
      { kind: 'api-key', id: 'api', name: 'API', envVars: [{ name: 'KEY', label: 'Key' }] },
    ] } } as AgentCapabilities;
    expect(agentSupportsConnectionManagement(capabilities)).toBe(false);
    expect(agentSupportsConnectionManagement({ ...capabilities, auth: { ...capabilities.auth, connections: { kind: 'managed' } } } as AgentCapabilities)).toBe(true);
  });

  it('does not offer a panel before metadata or auth support exists', () => {
    expect(agentSupportsConnectionManagement(null)).toBe(false);
    expect(agentSupportsConnectionManagement(undefined)).toBe(false);
    expect(agentSupportsConnectionManagement({ auth: { kind: 'none' } } as AgentCapabilities)).toBe(false);
  });
});
