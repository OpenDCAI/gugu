import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { opencodeScopedMcpAdapter } from './mcp-scopes';

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

const local = (tag: string, extra: Record<string, unknown> = {}) => ({ type: 'local', command: ['node', 'echo.mjs', tag], ...extra });

/** 10-17 资源库 MCP 核查:咕咕起的 OpenCode 任务装了 `<目录>/opencode.json` 里的那台,资源库没列。 */
describe('opencodeScopedMcpAdapter.readScopedServers', () => {
  const home = memoryFs({
    '.config/opencode/opencode.json': JSON.stringify({ mcp: { 'o-echo': local('co'), shared: local('global') } }),
  });

  it('项目 opencode.json / opencode.jsonc 里的那几台记在那个目录下;同名的按字段合并,项目里只写 enabled:false 也是关掉', async () => {
    const proj = memoryFs({
      'opencode.json': JSON.stringify({ mcp: { 'op-echo': local('cop'), shared: { enabled: false } } }),
      // .jsonc 与 .json 同层、后读者胜(厂商加载序),带注释也读得懂。
      'opencode.jsonc': '{ // project\n "mcp": { "op-jsonc": { "type": "local", "command": ["node", "x"] } } }',
    });
    const scoped = await opencodeScopedMcpAdapter().readScopedServers!(home, [{ dir: '/w', fs: proj }]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.servers.map((s) => [s.name, s.command, s.enabled])).toEqual([
      ['op-echo', 'node', undefined],
      ['shared', 'node', false],
      ['op-jsonc', 'node', undefined],
    ]);
    expect(scoped[0]!.servers[1]).toMatchObject({ args: ['echo.mjs', 'global'] });
  });

  it('没有项目配置的目录:没有这一层', async () => {
    expect(await opencodeScopedMcpAdapter().readScopedServers!(home, [{ dir: '/e', fs: memoryFs({}) }])).toEqual([]);
  });
});
