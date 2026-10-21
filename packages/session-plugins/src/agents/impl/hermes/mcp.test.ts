import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { hermesMcpAdapter } from './mcp';

function memoryFs(files: Record<string, string>, mcpWriteScope?: PluginFs['mcpWriteScope']): PluginFs & {
  files: Record<string, string>;
} {
  return {
    files,
    mcpWriteScope,
    async read(path) {
      return path in files ? files[path] : null;
    },
    async write(path, content) {
      files[path] = content;
    },
    async delete(path) {
      delete files[path];
    },
    async exists(path) {
      return path in files;
    },
    async list() {
      return Object.keys(files);
    },
  };
}

const USER_CONFIG = [
  '# my hermes setup',
  'model:',
  '  provider: openrouter # routed through my own key',
  'mcp_servers:',
  '  github:',
  '    command: npx',
  '    args: [-y, "@modelcontextprotocol/server-github"]',
  '    env:',
  '      GITHUB_TOKEN: ghp_placeholder',
  '  remote:',
  '    url: https://mcp.example.test/mcp',
  '    headers:',
  '      Authorization: Bearer placeholder',
  '  paused:',
  '    command: uvx',
  '    enabled: false',
  '',
].join('\n');

describe('hermesMcpAdapter', () => {
  it('reads stdio and HTTP servers from mcp_servers in config.yaml', async () => {
    const servers = await hermesMcpAdapter().readServers(memoryFs({ '.hermes/config.yaml': USER_CONFIG }));
    expect(servers).toEqual([
      {
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_placeholder' },
      },
      {
        name: 'remote',
        url: 'https://mcp.example.test/mcp',
        headers: { Authorization: 'Bearer placeholder' },
        transport: 'http',
        type: 'http',
      },
      { name: 'paused', command: 'uvx', enabled: false },
    ]);
  });

  it('reads a config without mcp_servers, and a missing file, as no servers', async () => {
    const adapter = hermesMcpAdapter();
    expect(await adapter.readServers(memoryFs({ '.hermes/config.yaml': 'model:\n  default: x\n' }))).toEqual([]);
    expect(await adapter.readServers(memoryFs({}))).toEqual([]);
  });

  it('never writes the user config: a non-owned fs is refused before any byte changes', async () => {
    const fs = memoryFs({ '.hermes/config.yaml': USER_CONFIG }, 'user-config');
    await expect(
      hermesMcpAdapter().writeServers(fs, [{ name: 'gugu', url: 'http://127.0.0.1:1/mcp', transport: 'http' }])
    ).rejects.toThrow(/read-only/);
    await expect(hermesMcpAdapter().removeServer(fs, 'github')).rejects.toThrow(/read-only/);
    expect(fs.files['.hermes/config.yaml']).toBe(USER_CONFIG);
  });

  it('writes an owned config in place: comments and other entries survive, the entry round-trips', async () => {
    const fs = memoryFs({ '.hermes/config.yaml': USER_CONFIG }, 'owned');
    const adapter = hermesMcpAdapter();
    await adapter.writeServers(fs, [
      { name: 'gugu', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'x' }, transport: 'http', type: 'http' },
    ]);
    const written = fs.files['.hermes/config.yaml'];
    expect(written).toContain('# my hermes setup');
    expect(written).toContain('# routed through my own key');
    const byName = Object.fromEntries((await adapter.readServers(fs)).map((server) => [server.name, server]));
    expect(Object.keys(byName)).toEqual(['github', 'remote', 'paused', 'gugu']);
    expect(byName.gugu).toEqual({
      name: 'gugu',
      url: 'http://127.0.0.1:1/mcp',
      headers: { Authorization: 'x' },
      transport: 'http',
      type: 'http',
    });
    // Writing the same registration again is idempotent (the conflict check compares native shapes).
    await adapter.writeServers(fs, [
      { name: 'gugu', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'x' }, transport: 'http', type: 'http' },
    ]);
    expect(fs.files['.hermes/config.yaml']).toBe(written);
  });

  it('creates mcp_servers in an empty owned config', async () => {
    const fs = memoryFs({}, 'owned');
    await hermesMcpAdapter().writeServers(fs, [{ name: 'local', command: 'node', args: ['server.js'] }]);
    expect(await hermesMcpAdapter().readServers(fs)).toEqual([{ name: 'local', command: 'node', args: ['server.js'] }]);
  });

  it('removes one owned entry in place and keeps the comments', async () => {
    const fs = memoryFs({ '.hermes/config.yaml': USER_CONFIG }, 'owned');
    await hermesMcpAdapter().removeServer(fs, 'remote');
    const written = fs.files['.hermes/config.yaml'];
    expect(written).toContain('# my hermes setup');
    expect((await hermesMcpAdapter().readServers(fs)).map((server) => server.name)).toEqual(['github', 'paused']);
  });
});
