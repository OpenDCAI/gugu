import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { passthroughMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpService as McpServiceType } from './McpService';

// ── In-memory PluginFs ───────────────────────────────────────────────────────

function createMemoryFs(initial: Record<string, string> = {}): PluginFs {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async read(path: string) {
      return store.get(path) ?? null;
    },
    async write(path: string, content: string) {
      store.set(path, content);
    },
    async delete(path: string) {
      store.delete(path);
    },
    async exists(path: string) {
      return store.has(path);
    },
    async list(_path: string) {
      return [];
    },
  };
}

// ── Fake plugin registry ─────────────────────────────────────────────────────

function fakeProvider(id: string, configPath: string, legacyReadPaths?: string[]) {
  return {
    metadata: { id, name: id, description: '', websiteUrl: '' },
    capabilities: {
      mcp: { kind: 'supported' as const, supportedTransports: ['stdio', 'http'] as const, toolNames: { kind: 'unmeasured' as const } },
    },
    behavior: { mcp: passthroughMcpAdapter(configPath, legacyReadPaths) },
  };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockProviders: ReturnType<typeof fakeProvider>[] = [];

vi.mock('@gugu/session-plugins/agents', () => ({
  pluginRegistry: {
    getAll: () => mockProviders,
    get: (id: string) => mockProviders.find((p) => p.metadata.id === id),
  },
}));

let mockFs: PluginFs;

vi.mock('@main/core/agents/plugin-fs', () => ({
  createPluginFs: () => mockFs,
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('McpService', () => {
  let service: McpServiceType;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProviders.length = 0;
    mockFs = createMemoryFs();
    const { McpService } = await import('./McpService');
    service = new McpService();
  });

  describe('listForAgent', () => {
    it('returns servers for a specific agent', async () => {
      mockProviders.push(fakeProvider('claude', '.claude.json'));
      await mockFs.write(
        '.claude.json',
        JSON.stringify({
          mcpServers: { s1: { command: 'npx' }, s2: { url: 'https://x.com', type: 'http' } },
        })
      );

      const servers = await service.listForAgent('claude');
      expect(servers).toHaveLength(2);
      expect(servers.every((s) => s.providers.includes('claude'))).toBe(true);
    });

    it('读不了就抛出去,❌ 回 [](那会被记成「这条会话一台都没装」)', async () => {
      mockProviders.push(fakeProvider('claude', '.claude.json'));
      const broken = new Error('EACCES: permission denied');
      mockFs = { ...mockFs, read: async () => { throw broken; } };

      await expect(service.listForAgent('claude', '/nonexistent-libmcp/proj')).rejects.toBe(broken);
    });

    it('停用的不算这条会话装了的', async () => {
      mockProviders.push(fakeProvider('claude', '.claude.json'));
      await mockFs.write('.claude.json', JSON.stringify({ mcpServers: { on: { command: 'a' }, off: { command: 'b', enabled: false } } }));

      expect((await service.listForAgent('claude')).map((s) => s.name)).toEqual(['on']);
    });

    it('returns empty array for unknown agent', async () => {
      const servers = await service.listForAgent('unknown-agent');
      expect(servers).toEqual([]);
    });

    it('returns empty array when agent has no mcp behavior', async () => {
      mockProviders.push({
        metadata: { id: 'no-mcp', name: 'No MCP', description: '', websiteUrl: '' },
        capabilities: { mcp: { kind: 'none' as const } },
        behavior: { mcp: undefined },
      } as unknown as ReturnType<typeof fakeProvider>);

      const servers = await service.listForAgent('no-mcp');
      expect(servers).toEqual([]);
    });

    it('给了目录:分目录的层按那一家的优先级盖过全局同名的那台(本地级 > 项目级 > 用户级)', async () => {
      mockProviders.push(scopedProvider());
      await mockFs.write('.claude.json', JSON.stringify({ mcpServers: { shared: { command: 'user-cmd' }, only: { command: 'u' } } }));

      const servers = await service.listForAgent('claude', '/nonexistent-libfloor/proj');
      expect(Object.fromEntries(servers.map((s) => [s.name, s.command]))).toEqual({
        shared: 'local-cmd',
        only: 'u',
        'proj-only': 'project-cmd',
      });
      // 不给目录 = 只有全局那一层(与改之前一致)。
      expect((await service.listForAgent('claude')).map((s) => s.name)).toEqual(['shared', 'only']);
    });
  });
});

/** 一家分作用域的 harness:每个目录里一台项目级、一台与全局同名的本地级。 */
function scopedProvider() {
  const provider = fakeProvider('claude', '.claude.json');
  return {
    ...provider,
    behavior: {
      mcp: {
        ...provider.behavior.mcp,
        readScopedServers: async (_fs: PluginFs, dirs: readonly { dir: string }[]) =>
          dirs.flatMap(({ dir }) => [
            { kind: 'project' as const, dir, servers: [{ name: 'proj-only', command: 'project-cmd' }] },
            { kind: 'local' as const, dir, servers: [{ name: 'shared', command: 'local-cmd' }] },
          ]),
      },
    },
  };
}
