import { describe, expect, it } from 'vitest';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { claudeMcpAdapter } from './mcp-scopes';
import { claudeUserServerToolPrefix } from './session-bundle';

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

const echo = (tag: string) => ({ type: 'stdio', command: 'node', args: ['echo.mjs', tag] });

/**
 * 10-07 资源库体检:Claude 会话装载了本地级与项目级的 server,资源库与 `/mcp` 面板一台都没列。
 * 判据照 Claude Code 2.1.267 实测的读法(gugu-base evidence/2026-10-07-library-audit/readings/fix-plan-measurements.md)。
 */
const stateOf = (server: { enabled?: boolean }) => (server.enabled === false ? 'disabled' : 'enabled');
const rows = (scoped: { kind: string; dir: string; servers: { name: string; enabled?: boolean }[] }[]) =>
  scoped.map(({ kind, dir, servers }) => ({ kind, dir, servers: servers.map((s) => `${s.name}:${stateOf(s)}`) }));

/**
 * 10-07 资源库体检补了本地级与项目级;10-17 资源库 MCP 核查补了插件层与两份关闭 / 批准名单。
 * 判据照 Claude 自己的列法:mac1 隔离 HOME、claude 2.1.293 的 `claude mcp list` + 咕咕 Claude 任务的 echo 账本
 * (gugu-base evidence/2026-10-17-library-mcp)。
 */
describe('claudeMcpAdapter.readScopedServers', () => {
  const home = memoryFs({
    '.claude.json': JSON.stringify({
      mcpServers: { 'echo-user': echo('user'), 'u-off': echo('uoff') },
      projects: {
        '/work/proj': {
          mcpServers: { 'echo-local': echo('local') },
          // `/mcp` 里关掉一台写的是这里:只对这个目录。
          disabledMcpServers: ['u-off'],
          disabledMcpjsonServers: ['off-in-claude-json'],
        },
      },
    }),
  });
  const proj = memoryFs({
    '.mcp.json': JSON.stringify({
      mcpServers: {
        'echo-project': echo('project'),
        'off-in-claude-json': echo('off1'),
        'off-in-settings-local': echo('off2'),
        unapproved: echo('unapproved'),
      },
    }),
    '.claude/settings.local.json': JSON.stringify({ disabledMcpjsonServers: ['off-in-settings-local'] }),
    '.claude/settings.json': JSON.stringify({ enabledMcpjsonServers: ['echo-project'] }),
  });

  it('本地级、在这个目录里关掉的用户级、项目级:被拒的停用,其余开着', async () => {
    const scoped = await claudeMcpAdapter().readScopedServers!(home, [{ dir: '/work/proj', fs: proj }]);
    expect(rows(scoped)).toEqual([
      { kind: 'local', dir: '/work/proj', servers: ['echo-local:enabled', 'u-off:disabled'] },
      {
        kind: 'project',
        dir: '/work/proj',
        servers: [
          'echo-project:enabled',
          // 关闭名单在 ~/.claude.json 的 projects 条目里、或在 .claude/settings.local.json 里,都算(docs:Any file)。
          'off-in-claude-json:disabled',
          'off-in-settings-local:disabled',
          // 没批准的:非交互的会话照样连它 —— ❌ 筛掉。
          'unapproved:enabled',
        ],
      },
    ]);
    expect(scoped[0]!.servers[0]).toMatchObject({ name: 'echo-local', command: 'node', args: ['echo.mjs', 'local'] });
  });

  it('全局那一层仍只由 readServers 给,不混进分目录的层', async () => {
    const adapter = claudeMcpAdapter();
    expect((await adapter.readServers(home)).map((s) => s.name)).toEqual(['echo-user', 'u-off']);
    expect(await adapter.readScopedServers!(home, [{ dir: '/elsewhere', fs: memoryFs({}) }])).toEqual([]);
  });

  it('读不懂的 .mcp.json:那一层没有 server(Claude 自己也装不出来),❌ 抛', async () => {
    const scoped = await claudeMcpAdapter().readScopedServers!(memoryFs({}), [
      { dir: '/work/broken', fs: memoryFs({ '.mcp.json': '{ not json' }) },
    ]);
    expect(scoped).toEqual([]);
  });
});

describe('claudeMcpAdapter — 插件带的 server', () => {
  const installPath = '/Users/me/.claude/plugins/cache/mk/probe/0.0.1';
  const pluginHome = (extra: Record<string, string> = {}) =>
    memoryFs({
      '.claude.json': JSON.stringify({ mcpServers: { 'echo-user': echo('user') } }),
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'probe@mk': true, 'off@mk': false } }),
      '.claude/plugins/installed_plugins.json': JSON.stringify({
        version: 2,
        plugins: {
          'probe@mk': [{ scope: 'user', installPath }],
          'off@mk': [{ scope: 'user', installPath: '/Users/me/.claude/plugins/cache/mk/off/1' }],
        },
      }),
      '.claude/plugins/cache/mk/probe/0.0.1/.claude-plugin/plugin.json': JSON.stringify({
        name: 'probe',
        mcpServers: { inline: { command: '${CLAUDE_PLUGIN_ROOT}/bin/inline' } },
      }),
      '.claude/plugins/cache/mk/probe/0.0.1/.mcp.json': JSON.stringify({
        mcpServers: { 'plug-echo': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } },
      }),
      '.claude/plugins/cache/mk/off/1/.mcp.json': JSON.stringify({ mcpServers: { never: echo('never') } }),
      ...extra,
    });

  it('开着的插件:插件根 .mcp.json + plugin.json 的 mcpServers,名字照 claude 列成 plugin:<插件>:<名>,替换 ${CLAUDE_PLUGIN_ROOT}', async () => {
    const servers = await claudeMcpAdapter().readServers(pluginHome());
    expect(servers.map((s) => s.name)).toEqual(['echo-user', 'plugin:probe:plug-echo', 'plugin:probe:inline']);
    expect(servers[1]).toMatchObject({ command: 'node', args: [`${installPath}/server.js`] });
    expect(servers[2]).toMatchObject({ command: `${installPath}/bin/inline` });
  });

  it('项目 settings 里关掉的插件:它的 server 在那个目录下标停用', async () => {
    const scoped = await claudeMcpAdapter().readScopedServers!(pluginHome(), [
      { dir: '/w', fs: memoryFs({ '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'probe@mk': false } }) }) },
    ]);
    expect(rows(scoped)).toEqual([
      { kind: 'project', dir: '/w', servers: ['plugin:probe:plug-echo:disabled', 'plugin:probe:inline:disabled'] },
    ]);
  });

  it('在这个目录里 /mcp 关掉的插件 server 也算(disabledMcpServers 覆盖插件 server)', async () => {
    const home = pluginHome({
      '.claude.json': JSON.stringify({ projects: { '/w': { disabledMcpServers: ['plugin:probe:plug-echo'] } } }),
    });
    const scoped = await claudeMcpAdapter().readScopedServers!(home, [{ dir: '/w', fs: memoryFs({}) }]);
    expect(rows(scoped)).toEqual([{ kind: 'local', dir: '/w', servers: ['plugin:probe:plug-echo:disabled'] }]);
  });
});

describe('claudeUserServerToolPrefix', () => {
  it('插件带的 server 在 claude 工具名里是 mcp__plugin_<插件>_<名>,其余 mcp__<名>(/mcp 面板关它时 disallowedTools 要对得上)', () => {
    expect(claudeUserServerToolPrefix('plugin:libmcp-plug:plug-echo')).toBe('mcp__plugin_libmcp-plug_plug-echo');
    expect(claudeUserServerToolPrefix('u-echo')).toBe('mcp__u-echo');
  });
});

describe('claudeMcpAdapter — 某个插件读不了', () => {
  it('跳过那一个插件,用户级与别的插件照常列(❌ 整家读不出)', async () => {
    const home = memoryFs({
      '.claude.json': JSON.stringify({ mcpServers: { 'echo-user': echo('user') } }),
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'good@mk': true, 'odd@mk': true } }),
      '.claude/plugins/installed_plugins.json': JSON.stringify({
        version: 2,
        plugins: {
          'good@mk': [{ scope: 'user', installPath: '/Users/me/.claude/plugins/cache/mk/good/1' }],
          'odd@mk': [{ scope: 'user', installPath: '/opt/elsewhere/odd' }],
        },
      }),
      '.claude/plugins/cache/mk/good/1/.mcp.json': JSON.stringify({ mcpServers: { g: echo('g') } }),
    });
    const adapter = claudeMcpAdapter();

    expect((await adapter.readServers(home)).map((s) => s.name)).toEqual(['echo-user', 'plugin:good:g']);
  });
});
