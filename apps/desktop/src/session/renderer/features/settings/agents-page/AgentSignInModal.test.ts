import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StepProps = {
  methodId: string;
  program?: string;
  stepLabel: string | null;
  onSuccess: () => void;
  onClose: () => void;
};

const mocks = vi.hoisted(() => ({ steps: [] as StepProps[], agents: {} as Record<string, unknown> }));

// 只验「几步怎么接」:每一步的正文由各自的组件负责,这里换成记下 props 的桩。
vi.mock('./AcpAuthenticateSignIn', () => ({
  AcpAuthenticateSignIn: (props: StepProps) => {
    mocks.steps.push(props);
    return null;
  },
}));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
// 这一家声明了几种登录方法,弹窗靠它决定要不要先让人挑。
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgent: (id: string) => ({ data: mocks.agents[id] ?? null }) }));
// 远端登录(#6264)那一支用到的设置页零件会在导入时读 `window`(平台适配层);这里只验本机几步怎么接。
vi.mock('@/components/settings/addServer/CommandBlock', () => ({ CommandBlock: () => null }));
vi.mock('@/i18n/registerSettingsCatalog', () => ({}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
// 弹窗外壳(Base UI 的 Dialog 根)不在这里挂:选择那一屏的标题与按钮区换成直通的容器。
vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { DialogHeader: pass, DialogTitle: pass, DialogContentArea: pass, DialogFooter: pass };
});
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    translate: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));

const { AgentSignInModal } = await import('./AgentSignInModal');

describe('AgentSignInModal 几步依次登(#6335)', () => {
  let dom: JSDOM;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    root = createRoot(dom.window.document.getElementById('root')!);
    mocks.steps = [];
    mocks.agents = {};
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('一步成功就接下一步,最后一步成功才算整趟成功;标题带步数', async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(AgentSignInModal, {
          providerId: 'antigravity',
          providerName: 'Antigravity',
          steps: [
            { methodId: 'a', transport: 'acp-authenticate' },
            { methodId: 'b', program: 'antigravity-cli', transport: 'acp-authenticate' },
          ],
          onSuccess,
          onClose,
        })
      );
    });
    const first = mocks.steps.at(-1)!;
    expect(first).toMatchObject({ methodId: 'a', stepLabel: 'agentsPage.signInStep:1,2' });
    expect(first.program).toBeUndefined();
    await act(async () => first.onSuccess());
    expect(onSuccess).not.toHaveBeenCalled();
    const second = mocks.steps.at(-1)!;
    expect(second).toMatchObject({ methodId: 'b', program: 'antigravity-cli', stepLabel: 'agentsPage.signInStep:2,2' });
    await act(async () => second.onSuccess());
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // 任何一步关窗 = 整趟结束
    second.onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('只有一步时不画步数', async () => {
    await act(async () => {
      root.render(
        React.createElement(AgentSignInModal, {
          providerId: 'x',
          providerName: 'X',
          steps: [{ methodId: 'a', transport: 'acp-authenticate' }],
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      );
    });
    expect(mocks.steps.at(-1)?.stepLabel).toBeNull();
  });

  it('一个程序声明了两种登录方法(CodeBuddy 国际版 / 中国版)⇒ 先让人挑,挑哪个就登哪个', async () => {
    mocks.agents.codebuddy = {
      capabilities: {
        auth: {
          kind: 'supported',
          methods: [
            { kind: 'acp-authenticate', id: 'codebuddy-international', name: '国际版', methodId: 'external' },
            { kind: 'acp-authenticate', id: 'codebuddy-china', name: '中国版', methodId: 'internal' },
          ],
        },
      },
    };
    await act(async () => {
      root.render(
        React.createElement(AgentSignInModal, {
          providerId: 'codebuddy',
          providerName: 'CodeBuddy Code',
          steps: [{ methodId: 'codebuddy-international', transport: 'acp-authenticate' }],
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      );
    });
    // 挑之前一步都没起
    expect(mocks.steps).toHaveLength(0);
    const china = dom.window.document.querySelector('[data-testid="agent-sign-in-method-codebuddy-china"]')!;
    expect(dom.window.document.querySelector('[data-testid="agent-sign-in-method-codebuddy-international"]')).not.toBeNull();
    await act(async () => (china as HTMLElement).click());
    expect(mocks.steps.at(-1)).toMatchObject({ methodId: 'codebuddy-china' });
  });

  it('只声明一种时不摆选择,直接登', async () => {
    mocks.agents.x = {
      capabilities: { auth: { kind: 'supported', methods: [{ kind: 'acp-authenticate', id: 'a', name: 'A', methodId: 'a' }] } },
    };
    await act(async () => {
      root.render(
        React.createElement(AgentSignInModal, {
          providerId: 'x',
          providerName: 'X',
          steps: [{ methodId: 'a', transport: 'acp-authenticate' }],
          onSuccess: vi.fn(),
          onClose: vi.fn(),
        })
      );
    });
    expect(mocks.steps.at(-1)).toMatchObject({ methodId: 'a' });
  });
});
