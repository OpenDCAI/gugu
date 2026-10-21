import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmOpenExternalLink, openExternalLinkInBrowser } from './open-external-link';

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  getSessionView: vi.fn(),
  openExternal: vi.fn(),
  showModal: vi.fn(),
  toast: vi.fn(),
  navigation: {
    currentViewId: 'home',
    viewParamsStore: { session: undefined as Record<string, unknown> | undefined },
  },
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionView: mocks.getSessionView,
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      clipboardWriteText: mocks.clipboardWriteText,
      openExternal: mocks.openExternal,
    },
  },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: mocks.showModal,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: mocks.navigation },
}));

// 语言钉在 en-US 词表：默认偏好跟宿主 locale 漂，断言会随机器红绿。
vi.mock('@renderer/localization/locale-store', async () => {
  const { enUSMessages } = await import('@renderer/localization/messages');
  return {
    translateSessionMessage: (key: keyof typeof enUSMessages) => enUSMessages[key],
  };
});

type ExternalLinkModalArgs = {
  url: string;
  canOpenInEmdashBrowser: boolean;
  onCopy: () => Promise<boolean>;
  onSuccess: (choice: 'emdash-browser' | 'external-browser') => void;
};

function getModalArgs(): ExternalLinkModalArgs {
  return mocks.showModal.mock.calls[0]?.[1] as ExternalLinkModalArgs;
}

describe('confirmOpenExternalLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.navigation.currentViewId = 'home';
    mocks.navigation.viewParamsStore.session = undefined;
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
  });

  it('copies the normalized link and reports success', async () => {
    confirmOpenExternalLink('https://example.com/docs).');

    const args = getModalArgs();
    expect(args.url).toBe('https://example.com/docs');

    await expect(args.onCopy()).resolves.toBe(true);

    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('https://example.com/docs');
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'Link copied' });
  });

  it('reports when the native clipboard write fails', async () => {
    mocks.clipboardWriteText.mockResolvedValue({ success: false, error: 'Clipboard unavailable' });

    confirmOpenExternalLink('https://example.com/docs');
    await expect(getModalArgs().onCopy()).resolves.toBe(false);

    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Copy failed',
      description: 'The link could not be copied to the clipboard.',
      variant: 'destructive',
    });
  });

  it('reports when the clipboard request rejects', async () => {
    mocks.clipboardWriteText.mockRejectedValue(new Error('IPC unavailable'));

    confirmOpenExternalLink('https://example.com/docs');

    await expect(getModalArgs().onCopy()).resolves.toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Copy failed',
      description: 'The link could not be copied to the clipboard.',
      variant: 'destructive',
    });
  });

  // #7052 会话页没有可收起的面板:浏览器页签开进这个会话自己的页签条,开了就在前面。
  it('opens the link as a browser tab in the session', () => {
    const calls: string[] = [];
    const sessionView = {
      paneLayout: {
        open: vi.fn((kind: string, args: { initialUrl?: string }) => {
          calls.push(`open:${kind}:${args.initialUrl}`);
        }),
      },
      setFocusedRegion: vi.fn(),
    };
    mocks.navigation.currentViewId = 'session';
    mocks.navigation.viewParamsStore.session = { projectId: 'project-1', sessionId: 'task-1' };
    mocks.getSessionView.mockReturnValue(sessionView);

    confirmOpenExternalLink('https://github.com/nmhjklnm/gugu/pull/5607');
    const args = getModalArgs();
    expect(args.canOpenInEmdashBrowser).toBe(true);

    args.onSuccess('emdash-browser');

    expect(mocks.getSessionView).toHaveBeenCalledWith('project-1', 'task-1');
    expect(calls).toEqual(['open:browser:https://github.com/nmhjklnm/gugu/pull/5607']);
    expect(sessionView.setFocusedRegion).toHaveBeenCalledWith('main');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});

describe('openExternalLinkInBrowser(#6264 登录窗口里的「在系统浏览器中打开」)', () => {
  beforeEach(() => {
    mocks.showModal.mockReset();
    mocks.openExternal.mockReset();
    mocks.openExternal.mockResolvedValue(undefined);
  });

  it('直接开,❌ 不占全局弹窗位(一占就把登录窗口顶掉)', () => {
    openExternalLinkInBrowser('https://auth.openai.com/codex/device');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('不是 http(s) 的一概不开', () => {
    openExternalLinkInBrowser('file:///etc/passwd');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
