import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { type PanelForm, SidePanelSplit } from '@renderer/lib/layout/side-panel-split';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';

// 群右栏和会话页右栏是同一个分栏(方案 L3-group-panel-fullscreen.md,统筹 110 批):这里量的是群那一边的用法 ——
// 从 520 起步、全屏是盖住消息列(消息列一个像素都不动)、还原回原宽、关上以后槽位卸掉(看不见的页放手,F17)。
// 会话页那一边(收起不卸、分隔线通高、文案跟语言)在 side-panel-split-divider.test.tsx。

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const HOST_WIDTH = 1000;
/** 群槽位那组宽度(groupSlotMemory.ts 的 GROUP_PANEL_WIDTHS):从 520 起、不窄于 360。键是测试自己的。 */
const GROUP_PANEL_WIDTHS = { storageKey: 'test.groupPanel.width', min: 360, initial: 520 };

beforeEach(async () => {
  await page.viewport(1200, 700);
  document.body.style.margin = '0';
  container = document.createElement('div');
  container.className = 'gugu-skin';
  // 群聊那一行是横排 flex:分栏根靠 flex-1 撑满,和 ChatAreaPanel 一样。
  container.style.cssText = `display: flex; width: ${HOST_WIDTH}px; height: 500px;`;
  document.body.appendChild(container);
  localStorage.clear();
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

function renderGroupSplit(form: PanelForm, unmountWhenClosed = true) {
  root!.render(
    <SidePanelSplit
      form={form}
      resizeLabel="Resize the workspace panel"
      widths={GROUP_PANEL_WIDTHS}
      unmountWhenClosed={unmountWhenClosed}
      className="flex-1"
      chatMinWidth={0}
      chatColumn={<div data-testid="messages" className="h-full" />}
      workspacePanel={<div data-testid="slot" className="h-full" />}
    />
  );
}

const width = (testId: string) =>
  container!.querySelector(`[data-testid="${testId}"]`)?.getBoundingClientRect().width ?? 0;
const panelWidth = () => width('session-workspace-panel');

async function settledAt(expected: number) {
  await until(`panel reaches ${expected}px`, () => Math.abs(panelWidth() - expected) < 1);
  await untilStable('panel stops moving', panelWidth);
}

/** 弹簧走的每一帧里这个元素量到过哪些宽(ResizeObserver 每帧报一次变化,开头先报一次当前值)。 */
function recordWidths(testId: string) {
  const seen: number[] = [];
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) seen.push(Math.round(entry.contentRect.width));
  });
  observer.observe(container!.querySelector(`[data-testid="${testId}"]`)!);
  return { seen, stop: () => observer.disconnect() };
}

const chatColumn = () => container!.querySelector<HTMLElement>('[data-testid="session-chat-panel"]')!;
const chatInert = () => chatColumn().inert;
const chatPainted = () => getComputedStyle(chatColumn()).visibility === 'visible';

describe('群右栏用的分栏', () => {
  it('全屏是盖住:消息列全程一个像素都不动、盖着时 inert 且不画;槽位只在盖上、掀开放完各排一次', async () => {
    renderGroupSplit('side');
    await settledAt(520);
    expect(width('messages')).toBe(HOST_WIDTH - 520);
    const messages = recordWidths('messages');
    const slot = recordWidths('slot');
    await until('observers report the starting widths', () => messages.seen.length > 0 && slot.seen.length > 0);

    renderGroupSplit('full');
    await settledAt(HOST_WIDTH);
    expect(width('slot')).toBe(HOST_WIDTH);
    expect(chatInert()).toBe(true);
    await until('chat column stops painting once covered', () => !chatPainted());

    renderGroupSplit('side');
    // 掀开一开始消息列就得露出来 —— 外框还在往回收,它不能等收完才出现。
    await until('chat column painted while the panel is still sweeping back', () => chatPainted() && panelWidth() > 600);
    await settledAt(520);
    expect(chatInert()).toBe(false);
    messages.stop();
    slot.stop();

    // 原来是逐帧挤:消息列 480 → … → 0 → … → 480,槽位每帧一个新宽。里面是终端就是每帧一次 reflow,
    // PTY 一路收到 2 列;是网页就是每帧一次重排。
    expect(messages.seen).toEqual([HOST_WIDTH - 520]);
    expect(slot.seen).toEqual([520, HOST_WIDTH, 520]);
  });

  it('关上:收起动画放完以后槽位卸掉;任务页那样不要求卸的,内容留着', async () => {
    renderGroupSplit('side');
    await settledAt(520);
    renderGroupSplit('closed');
    await until('slot unmounted', () => container!.querySelector('[data-testid="slot"]') === null);
    expect(panelWidth()).toBe(0);
    expect(width('messages')).toBe(HOST_WIDTH);

    renderGroupSplit('side', false);
    await settledAt(520);
    renderGroupSplit('closed', false);
    await settledAt(0);
    expect(container!.querySelector('[data-testid="slot"]')).not.toBeNull();
  });
});
