import { describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { resolveSessionRuntimeCompatible } from '@gugu/session-core/agents/plugins';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { materializePiSessionBundle, piSessionBundleDescriptor, PI_GUGU_CAPABILITY_PACKAGE } from './session-bundle';

describe('Pi built-in MCP', () => {
  it.each(['tui', 'acp'] as const)('%s registers native HTTP and stdio servers without injecting another MCP extension', (surface) => {
    const bundle: SessionCapabilityBundle = {
      env: { GUGU_HOME: '/gugu', HTTP_AUTH: 'Bearer fixture', STDIO_TOKEN: 'fixture-stdio' },
      mcpServers: [
        { name: 'gugu', transport: 'http', url: 'http://localhost:1234/mcp', authorizationEnv: 'HTTP_AUTH', alwaysLoad: true },
        { name: 'other', transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: 'STDIO_TOKEN' } },
      ],
      model: null, autonomy: null, promptBlocks: {}, packages: [PI_GUGU_CAPABILITY_PACKAGE],
    };
    const result = materializePiSessionBundle({ surface, lifecycle: 'fresh', cwd: '/work' }, bundle);
    expect(result.argsAppend).toEqual([]);
    expect(JSON.parse(result.env.GUGU_PI_MCP_SERVERS!)).toEqual([
      { name: 'gugu', url: 'http://localhost:1234/mcp', headers: { Authorization: 'Bearer fixture' }, exposure: 'direct' },
      { name: 'other', command: 'node', args: ['server.mjs'], env: { TOKEN: '${STDIO_TOKEN}' }, exposure: 'deferred' },
    ]);
    expect(result.env.HTTP_AUTH).toBeUndefined();
    expect(result.artifacts.some((artifact) => artifact.content.includes('pi-mcp-adapter'))).toBe(false);
  });

  it.each(['tui', 'acp'] as const)('%s refuses a Pi version without built-in MCP and accepts the supported floor', async (surface) => {
    for (const version of ['0.98.0', '0.99.0']) {
      const executionContext = { supportsLocalSpawn: false, exec: async (command: string) => ({ stdout: command === '/pi' ? version : 'v24.14.0', stderr: '' }) } as unknown as IExecutionContext;
      const result = resolveSessionRuntimeCompatible({ providerId: 'pi', surface, descriptor: piSessionBundleDescriptor, executable: '/pi', runtimeExecutable: '/node', executionContext });
      if (version === '0.98.0') await expect(result).rejects.toMatchObject({ code: 'runtime-version-unsupported', installedVersion: version, supportedFloor: '0.99.0' });
      else await expect(result).resolves.toMatchObject({ harnessVersion: version });
    }
  });

  it('still refuses the known-broken Node runtime after Pi passes its own version check', async () => {
    const executionContext = { supportsLocalSpawn: false, exec: async (command: string) => ({ stdout: command === '/pi' ? '1.3.0' : 'v23.7.0', stderr: '' }) } as unknown as IExecutionContext;
    await expect(resolveSessionRuntimeCompatible({ providerId: 'pi', surface: 'tui', descriptor: piSessionBundleDescriptor, executable: '/pi', runtimeExecutable: '/node', executionContext }))
      .rejects.toMatchObject({ code: 'runtime-version-unsupported', runtime: 'node', installedVersion: '23.7.0' });
  });
});
