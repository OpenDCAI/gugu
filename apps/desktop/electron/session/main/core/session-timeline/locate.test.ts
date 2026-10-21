import { describe, expect, it } from 'vitest';

import { locateSessionRecord, sessionRecordHarnessForProvider } from './locate';

const home = '/home/u';

function opencodeLocator(provider: string, env: Record<string, string | undefined> = {}) {
  const location = locateSessionRecord({ provider, providerSessionId: 'ses_1', env, homeDir: home });
  if (!location.supported || location.locator.harness !== 'opencode') throw new Error(`not opencode: ${provider}`);
  return location.locator;
}

describe('locateSessionRecord · opencode 族', () => {
  it('mimocode 读自己的库,只读主 agent', () => {
    const locator = opencodeLocator('mimocode', { XDG_DATA_HOME: '/xdg' });
    expect(locator.agentId).toBe('main');
    expect(locator.roots).toEqual(['/xdg/mimocode/mimocode.db', `${home}/.local/share/mimocode/mimocode.db`]);
    // 安装通道不是 latest/beta/prod 时库叫 `mimocode-<通道>.db`:同样这两个数据目录，交给记录源按名字认。
    expect(locator.channelDbs).toEqual({ app: 'mimocode', dirs: ['/xdg/mimocode', `${home}/.local/share/mimocode`] });
  });

  it('关了按通道分库，或者用环境变量整个指定了库：不再认通道库', () => {
    expect(opencodeLocator('mimocode', { MIMOCODE_DISABLE_CHANNEL_DB: 'TRUE' }).channelDbs).toBeUndefined();
    expect(opencodeLocator('mimocode', { MIMOCODE_DISABLE_CHANNEL_DB: '1' }).channelDbs).toBeUndefined();
    expect(opencodeLocator('mimocode', { MIMOCODE_DISABLE_CHANNEL_DB: '0' }).channelDbs).toBeDefined();
    expect(opencodeLocator('mimocode', { MIMOCODE_DB: '/abs/x.db' }).channelDbs).toBeUndefined();
    expect(opencodeLocator('opencode', { OPENCODE_DISABLE_CHANNEL_DB: 'true' }).channelDbs).toBeUndefined();
  });

  it('mimocode 认 MIMOCODE_HOME 与 MIMOCODE_DB(绝对路径直接用,相对路径相对数据目录)', () => {
    expect(opencodeLocator('mimocode', { MIMOCODE_HOME: '/m' }).roots).toEqual([
      '/m/data/mimocode.db',
      `${home}/.local/share/mimocode/mimocode.db`,
    ]);
    expect(opencodeLocator('mimocode', { MIMOCODE_DB: '/abs/x.db' }).roots[0]).toBe('/abs/x.db');
    expect(opencodeLocator('mimocode', { MIMOCODE_DB: 'y.db' }).roots).toEqual([`${home}/.local/share/mimocode/y.db`]);
  });

  it('opencode 不带 agentId,路径照旧', () => {
    const locator = opencodeLocator('opencode', { XDG_DATA_HOME: '/xdg' });
    expect(locator.agentId).toBeUndefined();
    expect(locator.roots).toEqual(['/xdg/opencode/opencode.db', `${home}/.local/share/opencode/opencode.db`]);
  });

  it('表里没有的家不支持,也不按名字形状推', () => {
    expect(sessionRecordHarnessForProvider('kilocode')).toBeNull();
    expect(locateSessionRecord({ provider: 'kilocode', providerSessionId: 'ses_1' }).supported).toBe(false);
  });
});

describe('locateSessionRecord · 候选顺序(每家一格)', () => {
  const managed = '/managed';
  const roots = (provider: string, env: Record<string, string | undefined>) => {
    const location = locateSessionRecord({ provider, providerSessionId: 's-1', env, homeDir: home, managedConfigRoot: managed });
    if (!location.supported) throw new Error(location.reason);
    return location.locator.roots;
  };

  it.each([
    ['claude', { CLAUDE_CONFIG_DIR: '/e' }, ['/managed/projects', '/e/projects', `${home}/.claude/projects`]],
    ['codex', { CODEX_HOME: '/e' }, ['/managed/sessions', '/e/sessions', `${home}/.codex/sessions`]],
    ['copilot', { COPILOT_HOME: '/e' }, ['/managed/session-state', '/e/session-state', `${home}/.copilot/session-state`]],
    ['hermes', { HERMES_HOME: '/e' }, ['/managed/state.db', '/e/state.db', `${home}/.hermes/state.db`]],
    ['qwen', { QWEN_RUNTIME_DIR: '/r', QWEN_HOME: '/e' }, ['/managed/projects', '/r/projects', '/e/projects', `${home}/.qwen/projects`]],
    ['pi', { GUGU_HOME: '/g' }, ['/managed/sessions', '/g/.pi/agent/sessions', '/g/.pi/acp-agent/sessions']],
    ['opencode', { XDG_DATA_HOME: '/x' }, ['/managed/opencode.db', '/x/opencode/opencode.db', `${home}/.local/share/opencode/opencode.db`]],
    ['mimocode', { MIMOCODE_HOME: '/m', XDG_DATA_HOME: '/x' }, ['/managed/mimocode.db', '/m/data/mimocode.db', '/x/mimocode/mimocode.db', `${home}/.local/share/mimocode/mimocode.db`]],
  ] as const)('%s:托管根 → 环境变量 → 默认根', (provider, env, expected) => {
    expect(roots(provider, env)).toEqual(expected);
  });

  it('opencode 族用 <家>_DB 指了绝对路径的库：它排在托管根前面', () => {
    expect(roots('mimocode', { MIMOCODE_DB: '/abs/x.db' })[0]).toBe('/abs/x.db');
  });
});

describe('locateSessionRecord · copilot', () => {
  it('COPILOT_HOME 是覆盖不是替换：两个 session-state 根都给', () => {
    const location = locateSessionRecord({ provider: 'copilot', providerSessionId: 'c-1', env: { COPILOT_HOME: '/ch' }, homeDir: home });
    expect(location).toEqual({
      supported: true,
      locator: { harness: 'copilot', providerSessionId: 'c-1', roots: ['/ch/session-state', `${home}/.copilot/session-state`] },
    });
    expect(sessionRecordHarnessForProvider('copilot')).toBe('copilot');
  });
});

describe('locateSessionRecord · hermes', () => {
  it('HERMES_HOME 是覆盖不是替换：两份 state.db 都给', () => {
    const location = locateSessionRecord({ provider: 'hermes', providerSessionId: 'h-1', env: { HERMES_HOME: '/hh' }, homeDir: home });
    expect(location).toEqual({
      supported: true,
      locator: { harness: 'hermes', providerSessionId: 'h-1', roots: ['/hh/state.db', `${home}/.hermes/state.db`] },
    });
    expect(sessionRecordHarnessForProvider('hermes')).toBe('hermes');
  });
});
