import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_API_VERSION,
  extensionTabKind,
  parseExtensionManifest,
} from '@shared/extensions/manifest';
import { MessageProvider } from '@gugu/session-ui/react/components';
import {
  registerSessionLocaleResources,
  translateSessionMessage,
} from '@renderer/localization/locale-store';
import { UnavailableTabPlaceholder } from '@renderer/features/tabs/unavailable-tab';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { until } from '../../../../../../../tests/support/awaitCondition';

// owner (#5265):「如果扩展还在被其他 tab 页面上使用,但是我们把他移除了,这种情况你有考虑吗」
// 从面板移除 = 停用,开着的 tab 落回占位。占位得分两种情况说话:扩展没了 → 说没了、给关闭;
// 扩展装着只是停用 → 说是哪个、启用就原位回来、给「启用」。旧代码两种情况一句话,没有启用入口。

const mocks = vi.hoisted(() => ({ toast: vi.fn(), setEnabled: vi.fn(), register: vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@renderer/lib/ipc', () => {
  const mod = {
  rpc: { extensions: { setEnabled: mocks.setEnabled } },
  events: { on: () => () => {} },
  };
  // #6264 一套工作台:按机器路由的那几个口,替身里都落到本机这一份。
  return {
    rpcOn: () => mod.rpc,
    onMachineEvent: () => () => {},
    ...mod,
  };
});
vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({
  registerInstalledExtensionTabs: vi.fn(),
  registerExtensionTabs: mocks.register,
  unregisterExtensionTabs: vi.fn(),
}));

const probe = parseExtensionManifest({
  id: 'probe',
  name: 'Sandbox Probe',
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION,
  entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Probe Tab' }] },
});
const kind = extensionTabKind('probe', 'main');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function draw(onClose = vi.fn()) {
  registerSessionLocaleResources();
  await act(async () => {
    root.render(
      <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
        <UnavailableTabPlaceholder kind={kind} onClose={onClose} />
      </MessageProvider>
    );
  });
}
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];
const placeholder = () => container.querySelector('[data-testid="unavailable-tab-placeholder"]')!;

describe('a tab whose extension is not enabled', () => {
  it('names the extension and offers Enable, which brings the providers back', async () => {
    await act(async () => {
      installedExtensionsStore.manifests = [probe];
      installedExtensionsStore.applyDisabled(['probe']);
    });
    await draw();
    expect(placeholder().getAttribute('data-reason')).toBe('not-enabled');
    expect(container.textContent).toContain('Sandbox Probe');

    const enable = buttons().find((b) => /^(启用|Enable)$/.test(b.textContent?.trim() ?? ''));
    expect(enable, 'offers Enable').toBeTruthy();
    mocks.setEnabled.mockResolvedValue({ success: true, data: { disabled: [] } });
    await act(async () => {
      enable!.click();
    });
    // The enable path is loaded on the click (a dynamic import, see the component),
    // so this waits for facts rather than counting microtasks: the write reaching main,
    // then the providers registering again — the last step of setExtensionEnabled.
    await until('enable write reaches main', () => mocks.setEnabled.mock.calls.length > 0);
    await until('enabled extension registers its tabs again', () => mocks.register.mock.calls.length > 0);
    expect(mocks.setEnabled).toHaveBeenCalledWith({ extensionId: 'probe', enabled: true });
    expect(installedExtensionsStore.isEnabled('probe')).toBe(true);
    expect(mocks.register).toHaveBeenCalledWith(probe);
  });

  it('an extension that is gone gets the plain placeholder — nothing to enable', async () => {
    await act(async () => {
      installedExtensionsStore.manifests = [];
      installedExtensionsStore.applyDisabled([]);
    });
    await draw();
    expect(placeholder().getAttribute('data-reason')).toBe('unavailable');
    expect(buttons().find((b) => /^(启用|Enable)$/.test(b.textContent?.trim() ?? ''))).toBeUndefined();
    expect(buttons().find((b) => /关闭标签页|Close tab/.test(b.textContent ?? ''))).toBeTruthy();
  });
});
