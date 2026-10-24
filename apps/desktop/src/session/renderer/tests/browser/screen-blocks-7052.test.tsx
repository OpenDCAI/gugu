import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { BlockGrip, ScreenFrame, screenDropHandlers, startSessionBlockDrag } from '@renderer/app/screen-frame';
import { blockDropPreview, resolveBlockDrop, setBlockDropPreview } from '@renderer/app/screen-layout-actions';
import { clearDraggedScreenContent, hasDraggedScreenContent, setDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { shieldNativeDrags } from '@renderer/lib/drag-shield';
import { screenLayout } from '@renderer/app/screen-layout';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { drainTopicSplitRequest } from '@/lib/topicSplitRequest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';

// #7052 一屏几块:真组件(ScreenFrame + react-resizable-panels)、真几何。判据钉的是 2026-10-09 实机撞过的几件:
//  · 块与块之间一根 1px 线,和会话列表右边那根同色(owner「怎么会没有任何分割线」→「这么粗的线…不能统一吗」);
//  · 会话页是贴在块上的另一层,压在线两边:线两边那几 px 照样抓得到;
//  · 一列塌成一块(占一块的 App 被收走)之后,剩下的块各得一半,❌ 新挂上的那块只拿到 1%(实测挤成 19px);
//  · 块不够两半(一格最窄 220px)时拖到边上不给落点;正中不接。

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const s = (sessionId: string) => ({ projectId: 'p', sessionId });

beforeEach(async () => {
  vi.stubGlobal('electronAPI', { invoke: async (channel: string) => { if (channel !== 'viewState.save') throw new Error(`unexpected IPC: ${channel}`); }, eventOn: () => () => {} });
  await page.viewport(1200, 700);
  document.body.style.margin = '0';
  host = document.createElement('div');
  host.className = 'gugu-skin';
  host.style.cssText = 'position:relative;display:flex;width:1000px;height:500px';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  clearDraggedScreenContent();
  setBlockDropPreview(null);
});

const nextFrames = async (count: number) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};
const blockWidths = () =>
  [...document.querySelectorAll<HTMLElement>('[data-screen-block]')].map((el) => Math.round(el.getBoundingClientRect().width));
const separator = () => document.querySelector<HTMLElement>('[data-screen-frame] [data-slot="resizable-handle"]');

describe('一屏几块的骨架 (#7052)', () => {
  it.each([
    ['left', 0.3, 0.4], ['right', 0.7, 0.4], ['top', 0.4, 0.3], ['bottom', 0.6, 0.7],
  ] as const)('previews and splits a task dropped in the chat centre nearest its %s edge', async (edge, x, y) => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-centre' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    const blockId = screenLayout.order[0];
    const block = host!.querySelector<HTMLElement>('[data-screen-block]')!;
    const rect = block.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'session', ...s('incoming'), title: 'Incoming' });
    const handlers = screenDropHandlers(true);
    const event = { dataTransfer, target: block, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handlers.onDragOverCapture(event as never);
    expect(blockDropPreview.get()).toEqual({ blockId, edge });
    await until('split preview rendered', () => document.querySelector(`[data-block-drop-preview="${edge}"]`) !== null);
    handlers.onDropCapture(event as never);
    expect(screenLayout.order).toHaveLength(2);
    expect(screenLayout.blockOfSession('incoming')).toBeDefined();
    expect(blockDropPreview.get()).toBeNull();
  });

  it('leaves a chat composer drop to its own mention handler even near an edge', async () => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-composer' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    const block = host!.querySelector<HTMLElement>('[data-screen-block]')!;
    const rect = block.getBoundingClientRect();
    const composer = document.createElement('div');
    composer.dataset.slot = 'composer-bar';
    block.appendChild(composer);
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'session', ...s('incoming'), title: 'Incoming' });
    const event = { dataTransfer, target: composer, clientX: rect.left + 5, clientY: rect.bottom - 5, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const handlers = screenDropHandlers(true);
    handlers.onDragOverCapture(event as never);
    handlers.onDropCapture(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(blockDropPreview.get()).toBeNull();
    expect(screenLayout.order).toHaveLength(1);
    composer.remove();
  });

  it('opens a topic only after its source chat lands in a workspace split', async () => {
    screenLayout.show(s('a'));
    root!.render(<ScreenFrame />);
    await until('one block', () => blockWidths().length === 1);
    const rect = host!.querySelector('[data-screen-block]')!.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'chat', chatId: 'group', title: 'Topic', topic: { chatId: 'topic', name: 'Topic' } });
    const handlers = screenDropHandlers(true);
    const event = { dataTransfer, target: host, clientX: rect.left + 5, clientY: rect.top + rect.height / 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const composer = document.createElement('div');
    composer.dataset.slot = 'composer-bar';
    handlers.onDropCapture({ ...event, target: composer } as never);
    expect(drainTopicSplitRequest('group')).toBeNull();
    handlers.onDropCapture(event as never);
    expect(screenLayout.order).toHaveLength(2);
    expect(drainTopicSplitRequest('group')).toEqual({ chatId: 'topic', name: 'Topic', sourceChatId: 'group', focusComposer: true });
    screenLayout.close(screenLayout.order.find((id) => screenLayout.blocks.get(id)?.kind === 'chat')!);
    clearDraggedScreenContent();
  });

  it('can move an existing block beside its neighbour using the space its old block releases', async () => {
    host!.style.width = '800px';
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('two narrow blocks', () => blockWidths().length === 2 && blockWidths().every((w) => w > 390 && w < 410));
    const blockId = screenLayout.blockOfSession('b')!;
    const rect = document.querySelector<HTMLElement>(`[data-screen-block="${blockId}"]`)!.getBoundingClientRect();
    // Each current block is narrower than two 220px panes, but moving a releases its old 400px.
    expect(resolveBlockDrop(rect.right - 5, rect.top + rect.height / 2, { kind: 'session', ...s('a') })).toEqual({ blockId, edge: 'right' });
    // A new third block would really have to fit inside those 400px.
    expect(resolveBlockDrop(rect.right - 5, rect.top + rect.height / 2, { kind: 'session', ...s('c') })).toBeNull();
  });

  it('两块之间一根 1px 线,和别处的分界线(话题分栏、右栏)同一个 token;会话页压在两边时线两边那几 px 仍抓得到', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const line = separator()!;
    const rect = line.getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(1);
    const reference = document.createElement('div');
    reference.className = 'bg-[var(--border-subtle)]';
    host!.appendChild(reference);
    expect(getComputedStyle(line).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    reference.remove();

    // 会话页那一层:绝对定位、贴在每块上(同 anchoredToBlock),和线在同一个叠放层里。
    for (const block of document.querySelectorAll<HTMLElement>('[data-screen-block]')) {
      const box = block.getBoundingClientRect();
      const page = document.createElement('div');
      page.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;background:white`;
      page.dataset.fakePage = '';
      host!.appendChild(page);
    }
    const x = rect.left + rect.width / 2;
    for (const dx of [-3, -2, 0, 2, 3]) {
      expect(document.elementFromPoint(x + dx, 250)?.closest('[data-slot="resizable-handle"]'), `x${dx >= 0 ? '+' : ''}${dx}`).toBe(line);
    }
  });

  it('一列塌成一块之后,两块各得一半(❌ 新挂上的那块只拿到 1%)', async () => {
    // 先摆好两块、画出来,再在右边那块下面分出一块 —— 那一刀是在分块那组已经挂好之后才长出来的(实机就是这个顺序;
    // 一开始就画三块复现不出来)。
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    screenLayout.placeAt({ kind: 'session', projectId: 'p', sessionId: 'c' }, screenLayout.blockOfSession('b')!, 'bottom');
    await until('三块铺开', () => blockWidths().length === 3);
    await nextFrames(5);

    screenLayout.forgetSession('c');
    await until('收成两块', () => blockWidths().length === 2);
    await nextFrames(10);
    // 不重挂时这里是 [979, 20]。
    expect(blockWidths().every((w) => Math.abs(w - 500) < 10), JSON.stringify(blockWidths())).toBe(true);
  });

  it('拖到一块的边上 = 分出一块;正中不接;块放不下两半(一格最窄 220px)就不给落点', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const blockB = document.querySelector<HTMLElement>(`[data-screen-block="${screenLayout.blockOfSession('b')}"]`)!.getBoundingClientRect();
    const incoming = { kind: 'session' as const, projectId: 'p', sessionId: 'c' };
    expect(resolveBlockDrop(blockB.left + 10, blockB.top + blockB.height / 2, incoming)).toMatchObject({ edge: 'left' });
    expect(resolveBlockDrop(blockB.left + blockB.width / 2, blockB.top + blockB.height / 2, incoming)).toBeNull();

    // 窄到 400px 宽:两块各 200 都不到 441,左右边上都不接;上下照样能分(500 高 > 160 × 2)。
    host!.style.width = '400px';
    await until('窄到每块不足 230', () => blockWidths().every((w) => w < 230));
    const narrow = document.querySelector<HTMLElement>(`[data-screen-block="${screenLayout.blockOfSession('b')}"]`)!.getBoundingClientRect();
    expect(resolveBlockDrop(narrow.left + 5, narrow.top + narrow.height / 2, incoming)).toBeNull();
    expect(resolveBlockDrop(narrow.left + narrow.width / 2, narrow.bottom - 10, incoming)).toMatchObject({ edge: 'bottom' });
  });

  // owner 2026-10-15「拖到边缘是分屏,中间是 session 信息粘贴」:边带两成(照 dockview),正中落在另一条会话的输入面上 = 插 @ ——
  // 这一屏不收(不 preventDefault,让聊天区 / 终端自己的 drop 插),只画出 @ 会落进去的地方。
  it('边带两成;会话落在另一条会话正中 = 画出插 @ 的落点、不在这一屏收走', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const blockIdB = screenLayout.blockOfSession('b')!;
    const blockB = document.querySelector<HTMLElement>(`[data-screen-block="${blockIdB}"]`)!.getBoundingClientRect();
    const incoming = { kind: 'session' as const, projectId: 'p', sessionId: 'c' };
    const midY = blockB.top + blockB.height / 2;
    // 离左边 25%:原来的三成边带里算「往左分」,现在是正中。
    expect(resolveBlockDrop(blockB.left + blockB.width * 0.25, midY, incoming)).toBeNull();
    expect(resolveBlockDrop(blockB.left + blockB.width * 0.15, midY, incoming)).toMatchObject({ edge: 'left' });

    // 会话页是贴在块上的另一层:这里只摆它的输入面(聊天区 / 终端都带这两个标记)。
    const sessionPage = document.createElement('div');
    sessionPage.setAttribute('data-screen-page', blockIdB);
    const surface = document.createElement('div');
    surface.setAttribute('data-session-chat-surface', 'source');
    surface.setAttribute('data-session-chat-session-id', 'b');
    const transcript = document.createElement('div');
    surface.appendChild(transcript);
    sessionPage.appendChild(surface);
    host!.appendChild(sessionPage);

    const handlers = screenDropHandlers(true);
    const dragOver = (sessionId: string, x: number) => {
      const dataTransfer = new DataTransfer();
      setDraggedScreenContent(dataTransfer, { kind: 'session', sessionId, title: sessionId, projectId: 'p' });
      const preventDefault = vi.fn();
      handlers.onDragOverCapture({ dataTransfer, target: transcript, clientX: x, clientY: midY, preventDefault, stopPropagation: vi.fn() } as never);
      clearDraggedScreenContent();
      return preventDefault;
    };

    const centre = dragOver('c', blockB.left + blockB.width / 2);
    expect(blockDropPreview.get()).toEqual({ blockId: blockIdB, mention: { sessionId: 'b' } });
    expect(centre).not.toHaveBeenCalled();

    const edge = dragOver('c', blockB.left + 10);
    expect(blockDropPreview.get()).toMatchObject({ blockId: blockIdB, edge: 'left' });
    expect(edge).toHaveBeenCalled();

    // 拖它自己到自己的输入面上:@ 自己没有意义,不画。
    dragOver('b', blockB.left + blockB.width / 2);
    expect(blockDropPreview.get()).toBeNull();

    setBlockDropPreview(null);
    sessionPage.remove();
  });

  // 拖 ⋮⋮ 也要开拖拽遮罩:它的 onDragStart 曾经 stopPropagation,React 19 把原生 dragstart 停在根容器上,document 上的
  // shieldNativeDrags 听不到 —— 拖着经过 HTML 预览时指针进了 iframe(复核 659bafb7f 在真 React 上量到)。真组件、真 React 根。
  it('拖 ⋮⋮ 时遮罩开、拖完关', async () => {
    const stop = shieldNativeDrags(document, hasDraggedScreenContent, () => {});
    try {
      root!.render(<BlockGrip label="grip" onDragStart={(event) => startSessionBlockDrag(event, { projectId: 'p', sessionId: 'g', title: 'G' })} />);
      await nextFrames(2);
      const grip = host!.querySelector<HTMLElement>('[data-block-grip]')!;
      const dataTransfer = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(true);
      grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
    } finally {
      stop();
      clearDraggedScreenContent();
    }
  });
});
