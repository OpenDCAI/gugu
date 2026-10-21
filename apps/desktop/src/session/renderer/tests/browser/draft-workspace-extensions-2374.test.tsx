import { describe, expect, it, vi } from 'vitest';
import { extensionTabKind } from '@shared/extensions/manifest';

import {
  draftWorkspaceEntries,
  startsExtensionSection
} from '@renderer/features/sessions/workspace-panel-entries';

// 这个模块是**纯列表构造器** —— 打开由调用方注入。所以判据也不必 mock 模块:
// 它一旦需要被 mock 才测得动,就说明它已经不纯了。

// behavior tab-extensions (#2374) —— 草稿态右侧工作区面板必须和会话态提供同一组入口。
//
// 这条判据来自真机:草稿面板是先于 tab 引擎存在的另一套实现,自己内联拼入口列表,
// 于是扩展只出现在会话面板里、草稿面板里没有。是真机上「新建会话」后面板只剩四条
// 内建项才把它暴露出来 —— 两处代码分开看都「有扩展」,看不出漏的是哪一处。

const translate = ((key: string) => key) as never;

// 调用方给的是启用着的 App(installedExtensionsStore.enabledTabContributions):停用的不出现在这份清单里(owner 10-20)。
const contributions = [
  {
    kind: extensionTabKind('arxiv-search', 'search'),
    title: 'arXiv',
    extensionId: 'arxiv-search'
  },
  {
    kind: extensionTabKind('sandbox-probe', 'probe'),
    title: 'Sandbox Probe',
    extensionId: 'sandbox-probe'
  },
  {
    kind: extensionTabKind('clock', 'face'),
    title: 'Clock',
    extensionId: 'clock'
  }
];

describe('draft workspace panel entries', () => {
  it('offers every App it is given, after the built-ins', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: true,
      canOpenFiles: true,
      extensions: contributions,
      translate,
      onOpen: vi.fn()
    });

    expect(entries.map((entry) => entry.label)).toEqual([
      'workspace.sideTask',
      'workspace.review',
      'workspace.terminal',
      'workspace.browser',
      'workspace.files',
      'arXiv',
      'Sandbox Probe',
      'Clock'
    ]);

    // 增量③:扩展自成一组,不是接在内置后面越排越长。分组是画出来的依据,
    // 所以这里判的是每一项归属哪一组 —— 只判顺序的话,把标题去掉也照样绿。
    expect(entries.map((entry) => entry.section ?? 'builtin')).toEqual([
      'builtin',
      'builtin',
      'builtin',
      'builtin',
      'builtin',
      'extensions',
      'extensions',
      'extensions'
    ]);
  });

  it('marks exactly one heading position, wherever the extensions begin', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: true,
      canOpenFiles: true,
      extensions: contributions,
      translate,
      onOpen: vi.fn()
    });

    const headings = entries.map((_, index) => startsExtensionSection(entries, index));
    expect(headings).toEqual([false, false, false, false, false, true, false, false]);
  });

  it('draws no heading when nothing is installed', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: true,
      canOpenFiles: true,
      extensions: [],
      translate,
      onOpen: vi.fn()
    });

    // An empty group must not leave a bare label behind — the heading exists to
    // separate two groups, and with one group there is nothing to separate.
    expect(entries.some((_, index) => startsExtensionSection(entries, index))).toBe(false);
  });

  // owner 2026-08-21:「没绑项目咋了,侧边聊天和文件应该也得有,之前没有是想先做减法,现在有才是
  // 产品正常形态」。所以**内建那一组一项不少**,变的只是哪些够不着 —— 够不着的 disabled 并说明
  // 原因。这里判的是「清单不随工作区形态伸缩」:❌ 少一项就等于告诉用户产品没这功能。
  it('没有工作区时清单一项不少 —— 变的是 disabled 与原因,不是长度', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: false,
      canOpenFiles: false,
      extensions: contributions,
      translate,
      onOpen: vi.fn()
    });

    expect(entries.map((entry) => entry.label)).toEqual([
      'workspace.sideTask',
      'workspace.review',
      'workspace.terminal',
      'workspace.browser',
      'workspace.files',
      'arXiv',
      'Sandbox Probe',
      'Clock'
    ]);

    // 够不着的每一项都必须带原因 —— 一个没有 title 的 disabled 项就是「点了没反应」的按钮。
    for (const label of ['workspace.sideTask', 'workspace.review', 'workspace.files']) {
      const entry = entries.find((candidate) => candidate.label === label);
      expect(entry?.disabled, `${label} 够不着时必须 disabled`).toBe(true);
      expect(entry?.title, `${label} 必须说明为什么够不着`).toBeTruthy();
    }
    // 终端只在没有工作目录时才关,并且它本来就没有原因文案 —— 这条是阳性对照:上面那三条的
    // 「必须有 title」不是因为所有 disabled 项碰巧都有。
    expect(entries.find((entry) => entry.label === 'workspace.terminal')?.disabled).toBe(true);
  });

  it('有工作区时,只有时序上够不着的两项仍然 disabled', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: true,
      canOpenFiles: true,
      extensions: [],
      translate,
      onOpen: vi.fn()
    });

    // 草稿页上还没有会话可分叉、也还没有改动可审阅 —— 这两条与有没有工作区无关。
    expect(entries.filter((entry) => entry.disabled).map((entry) => entry.label)).toEqual([
      'workspace.sideTask',
      'workspace.review'
    ]);
  });

  // #7052 behavior tab-extensions「一个 App 只有一份、放在哪就在哪」:点一个 App = 把它放到这里(草稿面板里开出来,
  // 它原来摆在哪条会话里就从哪拿走 —— 那一步在草稿面板的 openTab 里)。❌ 不再是「在所有会话显示」的开关。
  it('点一个 App = 把它放到这里', () => {
    const onOpen = vi.fn();
    const entries = draftWorkspaceEntries({
      canOpenTerminal: true,
      canOpenFiles: true,
      extensions: contributions,
      translate,
      onOpen
    });

    entries.find((entry) => entry.label === 'Clock')?.onClick();
    expect(onOpen).toHaveBeenCalledWith(extensionTabKind('clock', 'face'));
  });

  it('an App is never disabled here — the built-ins gate on a workspace, an App does not', () => {
    const entries = draftWorkspaceEntries({
      canOpenTerminal: false,
      canOpenFiles: false,
      extensions: contributions,
      translate,
      onOpen: vi.fn()
    });

    for (const label of ['arXiv', 'Sandbox Probe', 'Clock']) {
      expect(entries.find((entry) => entry.label === label)?.disabled, label).toBeFalsy();
    }
  });
});
