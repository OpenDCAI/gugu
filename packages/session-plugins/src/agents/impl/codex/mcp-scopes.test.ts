import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { codexScopedMcpAdapter } from './mcp-scopes';

function memoryFs(files: Record<string, string>): PluginFs {
  return {
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
  } as PluginFs;
}

/** 10-17 资源库 MCP 核查:咕咕起的 Codex 任务装了 `<目录>/.codex/config.toml` 里的那台,资源库没列。 */
describe('codexScopedMcpAdapter.readScopedServers', () => {
  const home = memoryFs({
    '.codex/config.toml': '[mcp_servers.x-echo]\ncommand = "node"\nargs = ["echo.mjs", "cx"]\n\n[mcp_servers.shared]\ncommand = "node"\nargs = ["user"]\n',
  });

  it('项目 .codex/config.toml 的那几台记在那个目录下;同名的按字段合并,只写 enabled = false 也是关掉', async () => {
    const proj = memoryFs({
      '.codex/config.toml': '[mcp_servers.xp-echo]\ncommand = "node"\nargs = ["echo.mjs", "cxp"]\n\n[mcp_servers.shared]\nenabled = false\n',
    });
    const scoped = await codexScopedMcpAdapter().readScopedServers!(home, [{ dir: '/w', fs: proj }]);
    expect(scoped.map(({ kind, dir, servers }) => ({ kind, dir, rows: servers.map((s) => [s.name, s.args, s.enabled]) }))).toEqual([
      { kind: 'project', dir: '/w', rows: [['xp-echo', ['echo.mjs', 'cxp'], undefined], ['shared', ['user'], false]] },
    ]);
  });

  it('没有项目配置的目录:没有这一层;全局那一层仍只由 readServers 给', async () => {
    const adapter = codexScopedMcpAdapter();
    expect(await adapter.readScopedServers!(home, [{ dir: '/e', fs: memoryFs({}) }])).toEqual([]);
    expect((await adapter.readServers(home)).map((s) => s.name)).toEqual(['x-echo', 'shared']);
  });
});
