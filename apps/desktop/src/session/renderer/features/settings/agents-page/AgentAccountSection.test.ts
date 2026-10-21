import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, AgentPayload } from '@shared/core/agents/agent-payload';
import { AgentAccountSection } from './AgentAccountSection';
import { LibraryHostProvider, type LibraryHost } from '@renderer/features/library/library-host';

type SignInArgs = {
  providerId: string;
  providerName: string;
  steps: Array<{ methodId: string; program?: string; transport?: string }>;
  onSuccess: () => void;
  onClose: () => void;
};

const mocks = vi.hoisted(() => ({
  auth: null as AuthStatusModelState | null,
  /** 按程序给不同读数(#6335);没给的程序用上面那份。 */
  authByProgram: {} as Record<string, AuthStatusModelState | null>,
  statusCalls: [] as Array<[string, string | undefined]>,
  statusOptions: [] as unknown[],
  refreshAuth: vi.fn(),
  refreshCatalog: vi.fn(),
  invalidate: vi.fn(),
  signIn: vi.fn(),
  /** 这一家在咕咕网关上有几个模型(与新建框同一份目录)。 */
  platformModels: [] as unknown[],
  /** 「订阅」页那份套餐读数(资源库这一行与它同一份)。 */
  plan: undefined as unknown,
  planCalls: [] as Array<[string | null, string]>,
}));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { agents: {}, mcp: {} }, events: { on: () => () => {} } }));

vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({
  useAgentAuthStatuses: (providerId: string, programs: Array<string | undefined>, options?: unknown) => {
    mocks.statusOptions.push(options);
    for (const program of programs) mocks.statusCalls.push([providerId, program]);
    return {
      auths: programs.map((program) =>
        program !== undefined && program in mocks.authByProgram ? mocks.authByProgram[program] : mocks.auth
      ),
      refresh: mocks.refreshAuth,
    };
  },
}));
// ⚠️ 这里 mock 的是**函数**而不是 hook,而那正是本次的要点:抽屉只要「让目录作废」这一下,
// ❌ 不订阅目录 —— 订阅会顺带起一个 harness 进程去探,打开任意一家的抽屉都要付这笔钱。
vi.mock('@renderer/lib/stores/use-harness-model-catalog', () => ({
  forceRefreshHarnessModelCatalog: mocks.refreshCatalog,
}));
vi.mock('@renderer/features/sessions/session-config/platform-model-catalog', () => ({
  usePlatformModelCatalog: () => ({ models: mocks.platformModels }),
}));
vi.mock('@renderer/lib/stores/use-harness-model-credential', () => ({
  harnessModelCredentialKey: (providerId: string) => ['agents', 'modelCredential', providerId],
}));
vi.mock('@renderer/features/settings/subscriptions/subscription-queries', () => ({
  subscriptionKey: (machine: string | null, agentId?: string) => ['subscriptions', machine ?? 'local', ...(agentId ? [agentId] : [])],
  useSubscriptionPlan: (machine: string | null, agentId: string) => {
    mocks.planCalls.push([machine, agentId]);
    return { data: mocks.plan };
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => mocks.signIn }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    translate: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@renderer/lib/ui/field', () => ({
  Field: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@renderer/lib/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}));
vi.mock('@renderer/lib/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
}));

const CLI_LOGIN: AgentCapabilities['auth'] = {
  kind: 'supported',
  methods: [
    { kind: 'cli-login', id: 'claude-login', name: 'Sign in with Claude', args: ['auth', 'login'] },
  ],
};

const ACP_AUTH: AgentCapabilities['auth'] = {
  kind: 'supported',
  methods: [
    { kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' },
  ],
};

const agent = (auth: AgentCapabilities['auth'], status: AgentPayload['status'] = 'available') =>
  ({
    id: 'claude',
    name: 'Claude Code',
    status,
    capabilities: { auth } as AgentCapabilities,
  }) as unknown as AgentPayload;

describe('AgentAccountSection', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  const render = async (payload: AgentPayload, host?: LibraryHost) => {
    await act(async () => {
      const section = React.createElement(AgentAccountSection, { agent: payload });
      root.render(host ? React.createElement(LibraryHostProvider, { value: host }, section) : section);
    });
  };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    mocks.auth = null;
    mocks.authByProgram = {};
    mocks.statusCalls = [];
    mocks.statusOptions = [];
    mocks.refreshAuth.mockClear();
    mocks.refreshCatalog.mockClear();
    mocks.invalidate.mockClear();
    mocks.signIn.mockClear();
    mocks.platformModels = [];
    mocks.plan = undefined;
    mocks.planCalls = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('只声明 api-key 的家:一个字都不画', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(
      agent({
        kind: 'supported',
        methods: [
          {
            kind: 'api-key',
            id: 'gemini-api-key',
            name: 'Use a Gemini API key',
            envVars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key' }],
          },
        ],
      })
    );
    expect(container.textContent).toBe('');
  });

  it('没声明 auth 的家:一个字都不画', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent({ kind: 'none' }));
    expect(container.textContent).toBe('');
  });

  it('声明了 cli-login 的家:未登录 + 可点的登录按钮(上面三条的阳控)', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent(CLI_LOGIN));
    expect(container.textContent).toContain('agentsPage.account');
    expect(
      container.querySelector('[data-testid="agent-account-status"]')?.textContent
    ).toBe('agentsPage.accountSignedOut');
    const button = container.querySelector(
      '[data-testid="agent-account-sign-in"]'
    ) as HTMLButtonElement;
    expect(button.textContent).toBe('agentsPage.accountSignIn');
    expect(button.disabled).toBe(false);
  });

  it('未登录、但这一家有咕咕的模型:提示一句「用咕咕的模型不用登录」,登录按钮照旧在', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    mocks.platformModels = [{ id: 'glm-5.3-flash' }];
    await render(agent(CLI_LOGIN));
    expect(container.textContent).toContain('agentsPage.accountOptionalWithGugu');
    expect(container.querySelector('[data-testid="agent-account-status"]')?.textContent).toBe('agentsPage.accountSignedOut');
    expect((container.querySelector('[data-testid="agent-account-sign-in"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('已登录 —— 带上 harness 给的账号,按钮改成「重新登录」', async () => {
    mocks.auth = { status: { kind: 'authenticated', account: 'me@example.com' }, login: null };
    await render(agent(CLI_LOGIN));
    expect(container.querySelector('[data-testid="agent-account-status"]')?.textContent).toBe(
      'agentsPage.accountSignedInAs:me@example.com'
    );
    expect(container.querySelector('[data-testid="agent-account-sign-in"]')?.textContent).toBe(
      'agentsPage.accountSignInAgain'
    );
  });

  it('已登录而且是订阅:账号下面一行写套餐名，与「订阅」页同一份读数;别的付钱方式 / 没登录不写', async () => {
    const planLine = () => container.querySelector('[data-testid="agent-account-plan"]')?.textContent ?? null;
    mocks.auth = { status: { kind: 'authenticated', account: 'me@example.com' }, login: null };
    mocks.plan = { payer: 'subscription', plan: 'Claude Max 20x' };
    await render(agent(CLI_LOGIN));
    expect(planLine()).toBe('subscriptions.payer.subscription · Claude Max 20x');
    expect(mocks.planCalls.at(-1)).toEqual([null, 'claude']);

    mocks.plan = { payer: 'api-key', plan: 'MiMo 按量付费' };
    await render(agent(CLI_LOGIN));
    expect(planLine()).toBeNull();

    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    mocks.plan = { payer: 'subscription', plan: 'Claude Max 20x' };
    await render(agent(CLI_LOGIN));
    expect(planLine()).toBeNull();
  });

  it('未知 —— 说清读不出,❌ 不静默', async () => {
    mocks.auth = { status: { kind: 'unknown' }, login: null };
    await render(agent(CLI_LOGIN));
    expect(container.querySelector('[data-testid="agent-account-status"]')?.textContent).toBe(
      'agentsPage.accountUnknown'
    );
    expect(container.textContent).toContain('agentsPage.accountUnknownHint');
  });

  it('还没读到 —— 显示「正在检查」,❌ 不显示「未知」', async () => {
    mocks.auth = null;
    await render(agent(CLI_LOGIN));
    expect(container.querySelector('[data-testid="agent-account-status"]')?.textContent).toBe(
      'agentsPage.checking'
    );
  });

  it('没装的家:按钮灰掉并说明先装 —— ❌ 不摆一个点下去必然失败的按钮', async () => {
    mocks.auth = { status: { kind: 'unknown' }, login: null };
    await render(agent(CLI_LOGIN, 'missing'));
    const button = container.querySelector(
      '[data-testid="agent-account-sign-in"]'
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('agentsPage.accountNeedsInstall');
  });

  it('装好的那一刻重探登录态;status 不变的重渲染不探 —— 弹窗开着装完,不用关掉重开才翻(#6335)', async () => {
    mocks.auth = { status: { kind: 'unknown' }, login: null };
    await render(agent(ACP_AUTH, 'missing'));
    await render(agent(ACP_AUTH, 'missing'));
    expect(mocks.refreshAuth).not.toHaveBeenCalled();
    await render(agent(ACP_AUTH, 'available'));
    expect(mocks.refreshAuth).toHaveBeenCalledTimes(1);
  });

  it('没装的协议登录家:说明写「咕咕要通过它来登录」—— ❌ 不说「跑它自己的命令行」(#6335)', async () => {
    mocks.auth = { status: { kind: 'unknown' }, login: null };
    await render(agent(ACP_AUTH, 'missing'));
    expect(container.textContent).toContain('agentsPage.accountNeedsInstallProtocol');
  });

  it('点登录 → 开这一家的登录终端;登录回调 → 强制重读登录态、模型目录与凭据', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent(CLI_LOGIN));
    await act(async () => {
      (
        container.querySelector('[data-testid="agent-account-sign-in"]') as HTMLButtonElement
      ).click();
    });
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    const args = mocks.signIn.mock.calls[0]?.[0] as SignInArgs;
    expect(args).toMatchObject({
      providerId: 'claude',
      providerName: 'Claude Code',
      steps: [{ methodId: 'claude-login', transport: 'terminal' }],
    });
    // 单程序的家:一步、不带 program(与从前发出去的请求逐字节一致)
    expect(args.steps[0]).not.toHaveProperty('program');

    // 重读只该由登录动作的回调触发,❌ 不该在点击那一下就发生。
    expect(mocks.refreshCatalog).not.toHaveBeenCalled();

    await act(async () => args.onSuccess());
    expect(mocks.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mocks.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.refreshCatalog.mock.calls[0]?.[1]).toBe('claude');
    expect(mocks.invalidate).toHaveBeenCalledWith({
      queryKey: ['agents', 'modelCredential', 'claude'],
    });
    // 套餐跟着登录走:登完连同「订阅」页那份一起重问。
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['subscriptions', 'local', 'claude'] });

    // 关窗同样要重问:登录成没成只有 harness 知道(见 login-success.ts)。
    await act(async () => args.onClose());
    expect(mocks.refreshAuth).toHaveBeenCalledTimes(2);
    expect(mocks.refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it('资源库看的是别的机器:读那台机器报的登录读数,点登录 = 在那台机器上登录(同一个登录窗口)', async () => {
    const host = {
      key: 'remote:d22',
      agents: {},
      mcp: {},
      remote: { deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null },
    } as unknown as LibraryHost;
    // 读数经同一个钩子、问的是 d22(路由表送到那台机器)。
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent(CLI_LOGIN), host);
    expect(mocks.statusOptions.at(-1)).toEqual({ machine: 'd22' });
    expect(container.querySelector('[data-testid="agent-account-status"]')?.textContent).toBe('agentsPage.accountSignedOut');
    await act(async () => {
      (container.querySelector('[data-testid="agent-account-sign-in"]') as HTMLButtonElement).click();
    });
    const args = mocks.signIn.mock.calls[0]?.[0] as SignInArgs & { remote: Record<string, unknown> };
    expect(args.remote).toMatchObject({ deviceId: 'd22', deviceLabel: 'Linux 1', command: 'claude auth login' });
    await act(async () => args.onSuccess());
    // 登完重问那台机器上这一家的读数(账号、模型目录)。
    expect(mocks.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['agents'] });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['subscriptions', 'd22', 'claude'] });
    expect(mocks.refreshCatalog).not.toHaveBeenCalled();
    // 套餐问的也是那台机器。
    expect(mocks.planCalls.at(-1)).toEqual(['d22', 'claude']);
  });

  describe('一家两个程序(#6335,owner 定:一行、一颗按钮)', () => {
    const program = (dependencyId: string, legs: string[], status: string) => ({
      dependencyId, name: dependencyId, binaryName: dependencyId, legs, reading: 'installed', status,
      version: null, managed: true, managedVersion: null, managedUpdateAvailable: false,
    });
    const antigravity = (cliStatus = 'available') =>
      ({
        id: 'antigravity',
        name: 'Antigravity',
        status: 'available',
        capabilities: {
          auth: {
            ...ACP_AUTH,
            programs: {
              'antigravity-cli': { methods: [{ kind: 'cli-login', id: 'google', name: 'Google 账号', args: [] }] },
            },
          },
        } as unknown as AgentCapabilities,
        programs: [program('antigravity', ['acp'], 'available'), program('antigravity-cli', ['tui'], cliStatus)],
      }) as unknown as AgentPayload;
    const signedIn: AuthStatusModelState = { status: { kind: 'authenticated' }, login: null };
    const signedOut: AuthStatusModelState = { status: { kind: 'unauthenticated', message: '钥匙串里没有 agy 的登录凭据。' }, login: null };
    const status = () => container.querySelector('[data-testid="agent-account-status"]')?.textContent;
    const buttons = () => container.querySelectorAll('[data-testid="agent-account-sign-in"]');
    const click = async () => {
      await act(async () => (buttons()[0] as HTMLButtonElement).click());
      return mocks.signIn.mock.calls.at(-1)?.[0] as SignInArgs;
    };

    it('只有一行一颗按钮;两个都读、合成一份', async () => {
      mocks.auth = signedIn;
      mocks.authByProgram = { 'antigravity-cli': signedIn };
      await render(antigravity());
      expect(mocks.statusCalls).toEqual([
        ['antigravity', undefined],
        ['antigravity', 'antigravity-cli'],
      ]);
      expect(buttons()).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="agent-account-status"]')).toHaveLength(1);
      expect(status()).toBe('agentsPage.accountSignedIn');
      expect(buttons()[0]?.textContent).toBe('agentsPage.accountSignInAgain');
      // 全登了 ⇒ 「重新登录」依次重登两个
      const args = await click();
      expect(args.steps).toEqual([
        { methodId: 'google', transport: 'acp-authenticate' },
        { methodId: 'google', program: 'antigravity-cli', transport: 'terminal' },
      ]);
    });

    it('还差一步:说哪种模式还要再登一次(不露内部词);点一下只跑没登的那个,登完不强制重探目录', async () => {
      mocks.auth = signedIn;
      mocks.authByProgram = { 'antigravity-cli': signedOut };
      await render(antigravity());
      expect(status()).toBe('agentsPage.accountPartial');
      expect(container.textContent).toContain(
        'agentsPage.accountPartialHint:agentsPage.accountModeRow:taskConfig.sessionViewCode'
      );
      expect(container.textContent).not.toContain('agy');
      expect(buttons()[0]?.textContent).toBe('agentsPage.accountSignIn');
      const args = await click();
      expect(args.steps).toEqual([{ methodId: 'google', program: 'antigravity-cli', transport: 'terminal' }]);
      await act(async () => args.onClose());
      expect(mocks.refreshAuth).toHaveBeenCalled();
      // 模型目录与凭据是主程序起出来的,这一趟没登它就不强制重探;
      // 套餐读数却正是读终端那个程序的登录(product spec)⇒ 只重问它。
      expect(mocks.refreshCatalog).not.toHaveBeenCalled();
      expect(mocks.invalidate.mock.calls).toEqual([[{ queryKey: ['subscriptions', 'local', 'antigravity'] }]]);
    });

    it('都没登 ⇒ 未登录,一颗按钮依次登两个;登完强制重探目录', async () => {
      mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
      mocks.authByProgram = { 'antigravity-cli': signedOut };
      await render(antigravity());
      expect(status()).toBe('agentsPage.accountSignedOut');
      const args = await click();
      expect(args.steps.map((step) => step.transport)).toEqual(['acp-authenticate', 'terminal']);
      await act(async () => args.onSuccess());
      expect(mocks.refreshCatalog).toHaveBeenCalledTimes(1);
    });

    it('要跑的那一步还没装 ⇒ 按钮灰掉并说先装;判不出 ⇒ 未知', async () => {
      mocks.auth = signedIn;
      mocks.authByProgram = { 'antigravity-cli': signedOut };
      await render(antigravity('missing'));
      expect((buttons()[0] as HTMLButtonElement).disabled).toBe(true);
      expect(container.textContent).toContain('agentsPage.accountNeedsInstall');

      mocks.authByProgram = { 'antigravity-cli': { status: { kind: 'unknown' }, login: null } };
      await render(antigravity());
      expect(status()).toBe('agentsPage.accountUnknown');
      expect(container.textContent).toContain('agentsPage.accountUnknownHint');
    });
  });
});
