import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliAgentsList } from './CliAgentsList';

const mocks = vi.hoisted(() => ({
  selectedAgentId: null as string | null,
  /** 每格拿到的状态 —— 网格把状态画在图标上,所以这是它唯一的对外读数。 */
  tileStates: [] as Array<{ id: string; state: string }>,
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      status: 'available',
      reading: 'installed',
      updateAvailable: false,
      installOptions: [{ method: 'mise' }],
    },
    {
      id: 'codex',
      name: 'Codex',
      status: 'error',
      reading: 'detected-but-broken',
      updateAvailable: false,
      installOptions: [{ method: 'mise' }],
    },
    {
      id: 'zero',
      name: 'Zero',
      status: 'missing',
      reading: 'not-detected',
      updateAvailable: false,
      installOptions: [{ method: 'mise' }],
    },
  ],
}));

vi.mock('@renderer/lib/stores/use-agents', () => ({ useManagementAgents: () => ({ data: mocks.agents }) }));
vi.mock('@renderer/lib/stores/use-agent-installation-statuses', () => ({
  useBusyInstallAgents: () => new Set<string>(),
}));
vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({ useExpiredAgentIds: () => new Set<string>() }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/lib/ui/label', () => ({ Label: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children) }));
vi.mock('./AgentTile', () => ({
  AgentTile: ({ agent, state, onClick }: { agent: { id: string; name: string }; state: string; onClick: () => void }) => {
    mocks.tileStates.push({ id: agent.id, state });
    return React.createElement('button', { onClick }, agent.name);
  },
}));
vi.mock('./AgentDetailModal', () => ({ AgentDetailModal: ({ agentId }: { agentId: string | null }) => { mocks.selectedAgentId = agentId; return null; } }));

describe('CliAgentsList', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    mocks.selectedAgentId = null;
    mocks.tileStates = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('opens exactly the agent the caller selected, and follows it when the caller changes it', async () => {
    const onSelectAgent = vi.fn();
    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: 'claude', onSelectAgent }));
    });
    expect(mocks.selectedAgentId).toBe('claude');
    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: 'codex', onSelectAgent }));
    });
    expect(mocks.selectedAgentId).toBe('codex');
  });

  it('keeps no second copy of the selection: closing reports null and a re-render with null shows nothing', async () => {
    // 这一条守的就是那个 bug 的形状:从前组件自己 useState 记一份,关闭只写本地那份,
    // 路由里那个 agent 留着 —— 下次挂载又把弹窗打开。现在关闭必须回报给上游,
    // 且上游说 null 时组件不得还留着上一次的选择。
    const onSelectAgent = vi.fn();
    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: 'codex', onSelectAgent }));
    });
    expect(mocks.selectedAgentId).toBe('codex');

    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: null, onSelectAgent }));
    });
    expect(mocks.selectedAgentId).toBeNull();

    // 阳控:点一格确实会报上去(否则「没有第二份 state」也可能只是因为这个组件根本不选人)。
    const tiles = container.querySelectorAll('button');
    expect(tiles.length).toBeGreaterThan(0);
    await act(async () => {
      (tiles[0] as HTMLButtonElement).click();
    });
    expect(onSelectAgent).toHaveBeenCalledWith(expect.any(String));
    // 上游没改 prop ⇒ 弹窗仍然是关的:组件自己不许把它开出来。
    expect(mocks.selectedAgentId).toBeNull();
  });

  it('每格拿到的是那一家自己的状态 —— 坏态不再被并进「未安装」', async () => {
    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: null, onSelectAgent: vi.fn() }));
    });
    expect(mocks.tileStates).toEqual(
      expect.arrayContaining([
        { id: 'claude', state: 'installed' },
        { id: 'codex', state: 'broken' },
        { id: 'zero', state: 'not-installed' },
      ]),
    );
  });

  it('分两组:已安装在前、未安装在后 —— 装了但起不来的那一家在「已安装」里(owner 2026-09-22)', async () => {
    await act(async () => {
      root.render(React.createElement(CliAgentsList, { selectedAgentId: null, onSelectAgent: vi.fn() }));
    });
    const names = (testid: string) =>
      [...container.querySelectorAll(`[data-testid="${testid}"] button`)].map((b) => b.textContent);
    expect(names('agent-group-installed')).toEqual(['Claude Code', 'Codex']);
    expect(names('agent-group-not-installed')).toEqual(['Zero']);
    // 组头说的是「已安装 / 未安装」,❌ 不再是「推荐 / 全部智能体」。
    expect(container.textContent).toContain('agentsPage.installed');
    expect(container.textContent).toContain('agentsPage.notInstalled');
    expect(container.textContent).not.toContain('agentsPage.recommended');
  });
});
