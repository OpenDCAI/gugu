import type { InitializeRequest } from '@agentclientprotocol/sdk';
import { isOk } from '@gugu/session-shared';
import { createScope } from '@gugu/session-wire/util';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent, FakeAcpProcessHost } from '../acp-test-support';
import { createAcpAgentConnection } from './acp-agent-connection';

async function initializeWithFailureReader(protocolVersion: 1 | 2): Promise<InitializeRequest> {
  const agent = Object.assign(new FakeAcpAgent(), { protocolVersion });
  const scope = createScope({ label: 'initialize-capabilities' });
  try {
    const result = await createAcpAgentConnection(
      {
        host: new FakeAcpProcessHost(),
        behavior: {
          buildSpawn: () => ({ command: '/fake/agent', args: [], env: {} }),
          connect: agent.behavior.connect,
          turnFailure: { fromPromptResponse: () => null },
        },
      },
      {
        connectionKey: 'claude:initialize',
        providerId: 'claude',
        spawn: { command: '/fake/agent', args: [], env: {}, cwd: '/tmp/workspace' },
        scope,
        buildClient: vi.fn(),
        onClosed: vi.fn(),
      },
    );
    expect(isOk(result)).toBe(true);
    return agent.initialize.mock.calls[0]?.[0] as InitializeRequest;
  } finally {
    await scope.dispose();
  }
}

describe('ACP extension negotiation', () => {
  it('keeps v2 on standard subagents even when it can read AIR session failures (#503)', async () => {
    const request = await initializeWithFailureReader(2);
    expect(request.clientCapabilities).toMatchObject({ subagents: {}, _meta: { asyncTasks: {} } });
    // Any AIR namespace selects the bridge's v1 subagent_spawned dialect,
    // which its v2 translator cannot emit, even with only sessionFailure enabled.
    expect(request.clientCapabilities?._meta).not.toHaveProperty('jetbrains');
  });

  it('continues negotiating AIR session failures with v1 adapters', async () => {
    const request = await initializeWithFailureReader(1);
    expect(request.clientCapabilities?._meta).toMatchObject({
      jetbrains: {
        air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks', 'sessionFailure'] },
      },
    });
  });
});
