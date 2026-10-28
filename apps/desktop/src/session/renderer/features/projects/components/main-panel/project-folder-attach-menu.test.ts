// @vitest-environment jsdom
// #7341 第二步:卡片上的「+」在有几台机器时先弹机器菜单 —— 真 Base UI 菜单(❌ 打桩)真的点得开,
// 选哪台就去哪台挑文件夹;此刻连不上的那台列着、点不了。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ProjectFolderCard, type AttachMachine } from './project-folder-card';
import type { ProjectFoldersState } from './project-folders';

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { placement: { entries: new Map() } },
}));
vi.mock('@renderer/lib/chat/sender-avatar', () => ({
  senderAvatarUrl: (fromId: string) => `avatar:${fromId}`,
  subscribeSenderAvatars: () => () => {},
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { projects: {} },
}));

const ROOT: ProjectFolder & { offline: boolean } = {
  workspaceId: 'ws-root',
  projectId: 'p1',
  kind: 'root',
  path: '/www/gugu',
  branch: null,
  sessionIds: [],
  attachedAt: null,
  offline: false,
};
const MACHINES: AttachMachine[] = [
  { id: null, label: '这台电脑', online: true, kind: 'computer' },
  { id: 'd22', label: 'd22', online: true, kind: 'server' },
  { id: 'd15', label: 'd15', online: false, kind: 'server' },
];

const machineItems = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid="project-folder-attach-machine"]')];

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the card’s + with several machines', () => {
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

  it('opens a machine menu and attaches on the machine picked; an offline one is listed but disabled', async () => {
    const onAttach = vi.fn();
    const state: ProjectFoldersState = {
      folders: [ROOT],
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
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement(ProjectFolderCard, {
            projectId: 'p1',
            projectName: 'gugu',
            folders: state,
            machineOf: () => ({ label: '这台电脑', online: true, kind: 'computer' as const }),
            attachMachines: MACHINES,
            onAttach,
            onDropFolder: vi.fn(),
          })
        )
      );
    });
    await act(async () => container.querySelector<HTMLElement>('[data-testid="project-folder-attach"]')!.click());
    await until(() => machineItems().length > 0 || thrown.length > 0, 'the machine menu');
    expect(thrown).toEqual([]);
    // 菜单开着时不该先替人挑了一台。
    expect(onAttach).not.toHaveBeenCalled();
    expect(machineItems().map((item) => item.textContent?.trim())).toEqual(['这台电脑', 'd22', 'd15']);
    expect(machineItems()[2]!.getAttribute('aria-disabled') ?? machineItems()[2]!.getAttribute('data-disabled')).not.toBeNull();
    await act(async () => machineItems()[1]!.click());
    expect(onAttach).toHaveBeenCalledWith('d22');
  });
});
