/**
 * 问题 9(owner 2026-09-28):Claude 会话里,咕咕发的 MCP server —— 插件清单里那一整份 —— 免审。
 * 一台 server 一条规则;用户自己配的 server 不在这份里,不放行。
 */
import type { SessionMaterialization } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CLAUDE_GUGU_CAPABILITY_PACKAGE, pluginRegistry } from '../../registry';
import { CLAUDE_TIMERS_REPLACED_BY_SCHEDULE } from './session-bundle';

const TIMERS = [...CLAUDE_TIMERS_REPLACED_BY_SCHEDULE];

const GUGU_HOME = '/gugu-home-under-test';
const GUGU = { name: 'gugu', url: 'http://127.0.0.1:1/mcp' };
const EXTENSION = { name: 'quiet-probe-quiet', url: 'http://127.0.0.1:2/mcp', owner: 'gugu' as const };
const USER = { name: 'mine', url: 'http://127.0.0.1:3/mcp', owner: 'user' as const };

function materialize(
  surface: 'acp' | 'tui',
  mcpServers: readonly object[],
  mcpDisabled?: readonly string[],
): SessionMaterialization {
  const materializer = pluginRegistry.get('claude')!.behavior.sessionBundle!.materialize;
  return materializer(
    { surface, lifecycle: 'fresh', cwd: '/worktree' },
    {
      mcpServers,
      ...(mcpDisabled ? { mcpDisabled } : {}),
      env: { GUGU_HOME },
      model: null,
      autonomy: null,
      promptBlocks: {},
      packages: [CLAUDE_GUGU_CAPABILITY_PACKAGE],
    } as never,
  );
}

const allowedTools = (m: SessionMaterialization) =>
  (m.acp?.meta as { claudeCode?: { options?: { allowedTools?: string[] } } } | undefined)?.claudeCode?.options
    ?.allowedTools;

describe("gugu's own MCP servers need no approval in a Claude session", () => {
  it('chat panel: one rule per server gugu delivers, none for the person’s own', () => {
    expect(allowedTools(materialize('acp', [GUGU, EXTENSION, USER]))).toEqual([
      'mcp__plugin_gugu-product_gugu',
      'mcp__plugin_gugu-product_quiet-probe-quiet',
    ]);
  });

  it('chat panel with a server switched off in /mcp: gugu’s rules stay exactly the same', () => {
    expect(allowedTools(materialize('acp', [GUGU, USER], ['mine']))).toEqual([
      'mcp__plugin_gugu-product_gugu',
    ]);
  });

  it('terminal: the rules come right before --plugin-dir, which ends the list', () => {
    const args = materialize('tui', [GUGU, EXTENSION, USER]).argsAppend;
    const at = args.indexOf('--allowedTools');
    expect(args.slice(at, at + 4)).toEqual([
      '--allowedTools',
      'mcp__plugin_gugu-product_gugu',
      'mcp__plugin_gugu-product_quiet-probe-quiet',
      '--plugin-dir',
    ]);
  });

  it('nothing is allowed when gugu delivers no server', () => {
    expect(allowedTools(materialize('acp', [USER]))).toBeUndefined();
    expect(materialize('tui', [USER]).argsAppend).not.toContain('--allowedTools');
  });
});

const disallowedTools = (m: SessionMaterialization) =>
  (m.acp?.meta as { claudeCode?: { options?: { disallowedTools?: string[] } } } | undefined)?.claudeCode?.options
    ?.disallowedTools;
const strictMcpConfig = (m: SessionMaterialization) =>
  (m.acp?.meta as { claudeCode?: { options?: { strictMcpConfig?: boolean } } } | undefined)?.claudeCode?.options
    ?.strictMcpConfig;

/**
 * 10-07 资源库体检:/mcp 关一台,从前是 strict 整份接管(咕咕递回它读得到的那几台)—— 咕咕读不到的
 * 本地级、项目级一起丢。现在交给 claude 自己的 `disallowedTools`,只摘被关的那几台。
 */
describe('switching a server off in /mcp, in a Claude chat-panel session', () => {
  it('only that server is disallowed — by the name Claude knows it under; nothing is taken over', () => {
    const LINEAR = { name: 'linear', url: 'http://127.0.0.1:4/mcp', owner: 'integration' as const };
    const m = materialize('acp', [GUGU, EXTENSION, LINEAR, USER], ['linear', 'mine', 'from-a-project']);
    expect(disallowedTools(m)).toEqual([
      ...TIMERS,
      // 咕咕经插件投递的(集成)按插件名摘,与 allowedTools 同一个前缀。
      'mcp__plugin_gugu-product_linear',
      'mcp__mine',
      // 一台不在咕咕清单里的(本地级 / 项目级):照它在 claude 里的名字摘。
      'mcp__from-a-project',
    ]);
    expect(strictMcpConfig(m)).toBeUndefined();
    expect(m.acp?.mcpServers).toEqual([]);
  });

  it('gugu’s own server and what extensions deliver can never be switched off, even if asked', () => {
    expect(disallowedTools(materialize('acp', [GUGU, EXTENSION, USER], ['gugu', 'quiet-probe-quiet']))).toEqual(TIMERS);
  });

  it('nothing switched off: only Claude Code’s own timers, which schedule_create replaces', () => {
    expect(disallowedTools(materialize('acp', [GUGU, USER]))).toEqual(TIMERS);
  });
});

describe("Claude Code's own timers come off a session that has gugu's schedule_create", () => {
  it('terminal: --disallowedTools names them, before the allow rules and --plugin-dir', () => {
    const args = materialize('tui', [GUGU, USER]).argsAppend;
    const at = args.indexOf('--disallowedTools');
    expect(args.slice(at, at + TIMERS.length + 2)).toEqual(['--disallowedTools', ...TIMERS, '--allowedTools']);
  });

  it('no gugu server, no schedule_create: the timers stay', () => {
    expect(disallowedTools(materialize('acp', [USER]))).toBeUndefined();
    expect(materialize('tui', [USER]).argsAppend).not.toContain('--disallowedTools');
  });
});

/**
 * 资源库 → MCP 勾上的那台单独装进 `mcp-library` 插件(❌ 混进 `gugu-product`):工具名和用户自己装的插件同形。
 * 装在咕咕品牌的插件里时,GLM-5.3 在 Claude 终端腿上每次把 `gugu-product_` 那一段去掉,调不到(10-18 mac1 抓包)。
 */
describe('library MCP servers get a plugin of their own in a Claude session', () => {
  const LIBRARY = { name: 'lib-tui', transport: 'stdio' as const, command: 'node', args: ['echo.mjs'], owner: 'integration' as const, library: true as const };

  it('terminal: a second --plugin-dir with only the library server; the allow rule names that plugin', () => {
    const m = materialize('tui', [GUGU, LIBRARY]);
    const dirs = m.argsAppend.flatMap((arg, index) => (arg === '--plugin-dir' ? [m.argsAppend[index + 1]!] : []));
    expect(dirs).toHaveLength(2);
    expect(dirs[1]).toContain('/capability-packages/claude/mcp-library/');
    const mcpJson = (dir: string) => JSON.parse(m.artifacts.find((artifact) => artifact.path === `${dir}/.mcp.json`)!.content) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcpJson(dirs[0]!).mcpServers)).toEqual(['gugu']);
    expect(Object.keys(mcpJson(dirs[1]!).mcpServers)).toEqual(['lib-tui']);
    const manifest = JSON.parse(m.artifacts.find((artifact) => artifact.path === `${dirs[1]}/.claude-plugin/plugin.json`)!.content) as { name: string };
    expect(manifest.name).toBe('mcp-library');
    expect(m.argsAppend).toContain('mcp__plugin_mcp-library_lib-tui');
  });

  it('chat panel: both plugins are loaded; switching the library one off in /mcp names its own plugin', () => {
    const m = materialize('acp', [GUGU, LIBRARY], ['lib-tui']);
    const options = (m.acp?.meta as { claudeCode: { options: { plugins: { path: string }[]; allowedTools: string[]; disallowedTools?: string[] } } }).claudeCode.options;
    expect(options.plugins).toHaveLength(2);
    expect(options.allowedTools).toEqual(['mcp__plugin_gugu-product_gugu', 'mcp__plugin_mcp-library_lib-tui']);
    expect(options.disallowedTools).toEqual([...TIMERS, 'mcp__plugin_mcp-library_lib-tui']);
  });
});
