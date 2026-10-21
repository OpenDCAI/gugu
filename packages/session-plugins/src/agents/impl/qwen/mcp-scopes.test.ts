import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { qwenScopedMcpAdapter } from './mcp-scopes';

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

/** qwen 0.24.4 `hashMcpServerConfig` 的同一算法(去掉 scope 等,键逐层排序,sha256)—— 造一条「已批准」记录用。 */
const qwenHash = (config: Record<string, unknown>) =>
  createHash('sha256')
    .update(JSON.stringify(config, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
        : v))
    .digest('hex');

const stateOf = (s: { enabled?: boolean }) => (s.enabled === false ? 'disabled' : 'enabled');

/** 10-17 资源库 MCP 核查:`qwen mcp list` 在 task-home 里列出了 .mcp.json 与 .qwen/settings.json 两层(都待批准),资源库只列了用户级。 */
describe('qwenScopedMcpAdapter.readScopedServers', () => {
  const approved = { command: 'node', args: ['echo.mjs', 'ok'] };
  const home = memoryFs({
    '.qwen/settings.json': JSON.stringify({ mcpServers: { 'q-echo': { command: 'node' } }, mcp: { excluded: ['ex-*'] } }),
    '.qwen/mcpApprovals.json': JSON.stringify({
      '/w': {
        'p-ok': { hash: qwenHash(approved), status: 'approved' },
        'p-no': { hash: qwenHash({ command: 'node', args: ['no'] }), status: 'rejected' },
        // 批准过,但配置后来改了:hash 对不上 ⇒ 又是待批准，不连。
        'p-changed': { hash: qwenHash({ command: 'node', args: ['old'] }), status: 'approved' },
      },
    }),
  });
  const proj = memoryFs({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        'p-ok': approved,
        'p-no': { command: 'node', args: ['no'] },
        'p-changed': { command: 'node', args: ['new'] },
        'p-new': { command: 'node', args: ['new'] },
        'ex-1': { command: 'node' },
        // Claude 写法的 http:qwen 读成 httpUrl,资源库按同一份方言显示成 http。
        'p-http': { type: 'http', url: 'https://mcp.example.invalid/q' },
      },
    }),
    // 工作区 settings 盖过 .mcp.json 的同名那台。
    '.qwen/settings.json': JSON.stringify({ mcpServers: { 'p-new': { command: 'uvx', args: ['ws'] } } }),
  });

  it('项目 .mcp.json + 工作区 .qwen/settings.json,批准状态照 mcpApprovals.json(hash 绑定),mcp.excluded 不连', async () => {
    const scoped = await qwenScopedMcpAdapter().readScopedServers!(home, [{ dir: '/w', fs: proj }]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.kind).toBe('project');
    expect(scoped[0]!.servers.map((s) => `${s.name}:${stateOf(s)}`)).toEqual([
      'p-ok:enabled',
      'p-no:disabled',
      'p-changed:disabled',
      'p-new:disabled',
      'ex-1:disabled',
      'p-http:disabled',
    ]);
    expect(scoped[0]!.servers.find((s) => s.name === 'p-new')).toMatchObject({ command: 'uvx', args: ['ws'] });
    expect(scoped[0]!.servers.find((s) => s.name === 'p-http')).toMatchObject({ type: 'http', url: 'https://mcp.example.invalid/q' });
  });

  it('没有项目 / 工作区配置的目录:没有这一层;全局那一层仍只由 readServers 给', async () => {
    const adapter = qwenScopedMcpAdapter();
    expect(await adapter.readScopedServers!(home, [{ dir: '/e', fs: memoryFs({}) }])).toEqual([]);
    expect((await adapter.readServers(home)).map((s) => s.name)).toEqual(['q-echo']);
  });
});
