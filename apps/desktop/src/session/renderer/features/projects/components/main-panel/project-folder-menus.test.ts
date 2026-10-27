// @vitest-environment jsdom
// #7341 项目首页上的菜单真的点得开(真 Base UI 菜单,❌ 打桩):分组标题只能放在 Group 里,
// 少了那一层点开即整页崩「MenuGroupContext is missing」—— 实机撞过,当时的测试从没打开过菜单。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ProjectFolderMenu } from './project-folder-menu';
import { ComposerFolderPicker } from './composer-folder-picker';
import type { ProjectFoldersState } from './project-folders';

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { placement: { entries: new Map() } },
}));
vi.mock('@renderer/lib/chat/sender-avatar', () => ({
  senderAvatarUrl: (fromId: string) => `avatar:${fromId}`,
  subscribeSenderAvatars: () => () => {},
}));
const feedback = vi.hoisted(() => ({ toast: vi.fn(), attach: vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: feedback.toast }));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { projects: { attachProjectFolder: feedback.attach } },
}));

const folder = (workspaceId: string, kind: ProjectFolder['kind'], path: string): ProjectFolder => ({
  workspaceId,
  projectId: 'p1',
  kind,
  path,
  branch: null,
  sessionIds: [],
  attachedAt: null,
});
const ROOT = { ...folder('ws-root', 'root', '/www/gugu'), offline: false };
const WT = { ...folder('ws-wt', 'attached', '/www/gugu-wt'), offline: false };

const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim());

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('project home menus open for real', () => {
  let root: Root;
  let container: HTMLDivElement;
  const thrown: unknown[] = [];
  const onError = (event: ErrorEvent) => thrown.push(event.error);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setLocalePreference('zh-CN');
    thrown.length = 0;
    window.addEventListener('error', onError);
  });

  afterEach(() => {
    window.removeEventListener('error', onError);
    act(() => root.unmount());
    container.remove();
  });

  it('removes the initial folder through the menu and undo still works after the card unmounts', async () => {
    const detach = vi.fn().mockResolvedValue(true);
    feedback.toast.mockClear();
    feedback.attach.mockResolvedValue({ success: true, data: ROOT });
    await act(async () => root.render(
      React.createElement(SessionLocalizationProvider, null,
        React.createElement(ProjectFolderMenu, { folder: ROOT, projectName: 'P', state: { detach }, disabled: false,
          children: React.createElement('div', { 'data-testid': 'folder-menu-target' }, 'Folder') }))
    ));
    await act(async () => container.querySelector('[data-testid="folder-menu-target"]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 10, clientY: 10 })
    ));
    await until(() => menuItems().length > 0 || thrown.length > 0, 'detach menu');
    expect(thrown).toEqual([]);
    expect(menuItems()).toContain('从项目中摘除');
    await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
    expect(detach).toHaveBeenCalledWith(ROOT);
    const undo = feedback.toast.mock.calls[0][0].action.onClick;
    await act(async () => root.render(null));
    await act(async () => undo());
    expect(feedback.attach).toHaveBeenCalledWith('p1', ROOT.path);
  });

  it('the composer folder picker lists every folder and the attach action', async () => {
    const state: ProjectFoldersState = {
      folders: [ROOT, WT],
      loadError: false,
      unanswered: [],
      chosen: ROOT,
      fresh: undefined,
      choose: vi.fn(),
      reload: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
    };
    await act(async () => {
      root.render(
        React.createElement(SessionLocalizationProvider, null, React.createElement(ComposerFolderPicker, { folders: state, onAttach: vi.fn() }))
      );
    });
    await act(async () => container.querySelector<HTMLElement>('[data-testid="composer-folder-picker"]')!.click());
    await until(() => menuItems().length > 0 || thrown.length > 0, 'the folder menu');
    expect(thrown).toEqual([]);
    expect(menuItems()).toEqual([
      expect.stringContaining('项目根目录'),
      expect.stringContaining('gugu-wt'),
      expect.stringContaining('挂'),
    ]);
  });
});
