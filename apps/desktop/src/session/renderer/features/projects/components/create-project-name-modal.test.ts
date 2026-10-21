import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { CreateProjectNameModal } from './create-project-name-modal';

// owner 2026-09-25:「我发现新建项目居然不支持远程项目,应该得支持啊」——
// 新建空白项目在别的机器上:建在那台机器的默认项目目录下(规则同本机,目录是那台机器自己的设置)。

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  mountProject: vi.fn(),
  typeName: null as null | ((value: string) => void),
}));

// jsdom 下 React 的输入事件垫片会走 IE 那条 attachEvent;起名输入框直接拿它的 onChange 喂字。
vi.mock('@renderer/lib/ui/input', () => ({
  Input: ({ onChange, value }: { onChange: (event: { target: { value: string } }) => void; value: string }) => {
    mocks.typeName = (next) => onChange({ target: { value: next } });
    return React.createElement('input', { value, readOnly: true });
  },
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ createProject: mocks.createProject, mountProject: mocks.mountProject }),
}));

vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { device: () => null, connectionState: () => 'connected' },
}));

// 默认项目目录按「设置问的是哪台机器」给:判据是弹窗真的把设置读到了那台机器上。
vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { useSettingsHost } = await vi.importActual<typeof import('@renderer/features/settings/settings-host')>(
    '@renderer/features/settings/settings-host'
  );
  return {
    useAppSettingsKey: () => {
      const host = useSettingsHost();
      return {
        value: { defaultProjectsDirectory: host.remote ? `/home/${host.remote.deviceId}/Documents` : '/Users/me/Documents' },
      };
    },
  };
});

vi.mock('@renderer/lib/ui/confirm-button', () => ({
  ConfirmButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', { type: 'button', 'data-testid': 'confirm', ...props }, children),
}));

vi.mock('@renderer/lib/ui/dialog', () => {
  const pass = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { DialogHeader: pass, DialogTitle: pass, DialogContentArea: pass, DialogFooter: pass };
});

describe('新建空白项目(#6264 别的机器)', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.createProject.mockReset().mockResolvedValue('project-new');
    mocks.mountProject.mockReset().mockResolvedValue(undefined);
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    container = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(container);
    setLocalePreference('zh-CN');
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function createNamed(machine: { deviceId: string; label: string } | null, name: string) {
    const onSuccess = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement(CreateProjectNameModal, { machine, onSuccess, onClose: vi.fn() })
        )
      );
    });
    await act(async () => mocks.typeName?.(name));
    await act(async () => (container.querySelector('[data-testid="confirm"]') as HTMLButtonElement).click());
    return onSuccess;
  }

  it('选了别的机器:建在那台机器的默认项目目录下,建好就挂上(侧栏里有它)', async () => {
    const onSuccess = await createNamed({ deviceId: 'd22', label: 'd22 服务器' }, 'demo');
    expect(container.textContent).toContain('在 d22 服务器 上新建项目');
    expect(mocks.createProject).toHaveBeenCalledWith(
      { type: 'local', machine: 'd22' },
      expect.objectContaining({ mode: 'pick', path: '/home/d22/Documents/demo', name: 'demo', createDirectory: true })
    );
    expect(mocks.mountProject).toHaveBeenCalledWith('project-new');
    expect(onSuccess).toHaveBeenCalledWith('project-new');
  });

  it('本机照旧:本机的默认项目目录,项目类型不带机器', async () => {
    const onSuccess = await createNamed(null, 'demo');
    expect(mocks.createProject).toHaveBeenCalledWith(
      { type: 'local' },
      expect.objectContaining({ path: '/Users/me/Documents/demo', createDirectory: true })
    );
    expect(onSuccess).toHaveBeenCalledWith('project-new');
  });
});
