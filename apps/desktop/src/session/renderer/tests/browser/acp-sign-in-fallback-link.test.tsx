/**
 * 协议登录弹窗里的「如果浏览器没打开,点这里」:点下去直接在系统浏览器里开,登录弹窗留着、这一趟登录不取消。
 *
 * 从前它走 `confirmOpenExternalLink`:「打开链接?」确认框占掉唯一的弹窗位,把登录弹窗换下来 —— 登录弹窗卸载
 * 即取消登录,不管在确认框里选什么,回来都是「未登录」。终端登录那一支早就改走 `openExternalLinkInBrowser`
 * (#6264),这一支漏了。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

const LINK = 'https://www.codebuddy.ai/login?platform=CLI&state=s1';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));
// 这一家只声明了一种登录方法:不出「选哪种」那一屏,直接进协议登录。
vi.mock('@renderer/lib/stores/use-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/stores/use-agents')>()),
  useAgent: () => ({ data: null }),
}));
// 运行时那一侧:登录已经起来、在等浏览器,厂商给了登录链接。
vi.mock('@renderer/lib/acp/auth-login-binding', () => ({
  AcpAuthLoginBinding: {
    create: async () => ({
      status: {
        current: () => ({
          status: { kind: 'unauthenticated' },
          login: {
            methodId: 'codebuddy-international',
            startedAt: 1,
            transport: 'acp-authenticate',
            pendingUrl: { id: 'u1', url: LINK },
            exit: null,
            outcome: null,
          },
        }),
      },
      dispose: mocks.dispose,
    }),
  },
}));
// 只换掉「交给系统浏览器」那一下,其余 ipc 照旧。
vi.mock('@renderer/lib/ipc', async (importOriginal) => {
  const original = await importOriginal<typeof import('@renderer/lib/ipc')>();
  const app = new Proxy(original.rpc.app, {
    get: (target, key) => (key === 'openExternal' ? mocks.openExternal : Reflect.get(target, key)),
  });
  return {
    ...original,
    rpc: new Proxy(original.rpc, { get: (target, key) => (key === 'app' ? app : Reflect.get(target, key)) }),
  };
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <ModalRenderer />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  modalStore.closeModal();
  mocks.dispose.mockClear();
  mocks.openExternal.mockClear();
});

afterEach(() => {
  modalStore.closeModal();
  root.unmount();
  host.remove();
});

it('点备用链接:系统浏览器打开它,登录弹窗留着,登录不取消', async () => {
  showModal('agentSignInModal', {
    providerId: 'codebuddy',
    providerName: 'CodeBuddy',
    steps: [{ methodId: 'codebuddy-international', transport: 'acp-authenticate' }],
  });
  await until('the fallback link is shown', () => document.querySelector('[data-testid="acp-sign-in-fallback"]') !== null);

  await userEvent.click(document.querySelector<HTMLElement>('[data-testid="acp-sign-in-fallback"]')!);

  // 两种结局都会很快落定:链接交给了系统浏览器,或者登录弹窗被别的弹窗换下来。
  await until(
    'the click settled',
    () => mocks.openExternal.mock.calls.length > 0 || modalStore.activeModalId !== 'agentSignInModal'
  );
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(mocks.openExternal).toHaveBeenCalledWith(LINK);
  expect(document.querySelector('[data-testid="acp-sign-in-waiting"]')).not.toBeNull();
  expect(mocks.dispose).not.toHaveBeenCalled();
});
