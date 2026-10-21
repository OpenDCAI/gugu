/**
 * composer 的 ↑↓ 历史回溯 —— 真 Chromium、真 ProseMirror、真键盘事件。
 *
 * behavior session-page「键盘导航」: ↑↓ 在输入框里永远归输入框,走本会话已发出的用户消息。这条是
 * 「↑↓ 不切会话」的另一半 —— 键让出去了却没人接,空输入框按 ↑ 就成了哑键。
 *
 * 为什么非得真浏览器:走位逻辑有纯函数单测,但「按键到底有没有到达这个扩展」只有真 ProseMirror
 * 答得了。#3202 已经栽过一次同形的坑(prosemirror-view 的 captureKeyDown 每次都 preventDefault,
 * 于是监听器自己把自己让掉了),那类事读代码读不出来。
 */
import { page, userEvent } from '@vitest/browser/context';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components';
import {
  registerSessionLocaleResources,
  translateSessionMessage,
} from '@renderer/localization/locale-store';
import '@renderer/index.css';

/** 已发出的用户消息,最旧在前 —— 与 transcript 的读取顺序一致。 */
const HISTORY = ['第一条已发出的输入', '第二条已发出的输入'];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(width?: number): void {
  container = document.createElement('div');
  container.className = 'emlight gugu-skin bg-background';
  // 窄容器 = 让一段长文字真的软换行(不是插换行符),这是「首行」判据唯一会被折行骗到的场景。
  if (width) container.style.width = `${width}px`;
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
      <ChatComposer getPromptHistory={() => HISTORY} onSubmit={() => {}} onStop={() => {}} />
    </MessageProvider>
  );
}

const editor = () => page.getByTestId('prompt-editor');
const editorText = (): string =>
  (document.querySelector('[data-testid="prompt-editor"]')?.textContent ?? '').trim();

function moveCaretToDocumentStart(): void {
  const element = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
  if (!element) throw new Error('prompt editor is not mounted');

  const selection = window.getSelection();
  if (!selection) throw new Error('browser selection is unavailable');

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.focus();
}

describe('composer 的 ↑↓ 历史回溯', () => {
  beforeEach(async () => {
    registerSessionLocaleResources();
    await page.viewport(1100, 700);
    render();
    await editor().click();
  });

  afterEach(() => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
  });

  it('空输入框按 ↑ 拿回最近一条已发出的输入,再按更早', async () => {
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the newest history entry', () => editorText() === '第二条已发出的输入');
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the oldest history entry', () => editorText() === '第一条已发出的输入');
  });

  it('走到最旧就停住,不会把框清空也不会绕回去', async () => {
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    await until('editor shows the oldest history entry', () => editorText() === '第一条已发出的输入');
  });

  it('↓ 一路走回来会还原原本正在写的草稿', async () => {
    await userEvent.keyboard('写了一半的草稿');
    await until('editor shows the draft', () => editorText() === '写了一半的草稿');
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the newest history entry', () => editorText() === '第二条已发出的输入');
    await userEvent.keyboard('{ArrowDown}');
    await until('editor shows the draft', () => editorText() === '写了一半的草稿');
  });

  it('没在翻历史时 ↓ 不归历史 —— 它得留给光标', async () => {
    await userEvent.keyboard('原样不动的草稿');
    await userEvent.keyboard('{ArrowDown}');
    // 反例对照:上面那条「↓ 还原草稿」若是靠「↓ 一律清空/改写」实现的,这里就会被改掉。
    await until('editor keeps the draft untouched', () => editorText() === '原样不动的草稿');
  });

  it('回溯后光标落在末尾:接着打字是续写,不是插在开头', async () => {
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the newest history entry', () => editorText() === '第二条已发出的输入');
    await userEvent.keyboard('续写');
    await until('typing continues at the end of the recalled entry', () => editorText() === '第二条已发出的输入续写');
  });

  it('软换行的长草稿:光标在第二个视觉行按 ↑ 是上移一行,不是把草稿换成历史', async () => {
    // 重来一次,这次给一个窄到必然折行的容器。
    root?.unmount();
    container?.remove();
    render(240);
    await editor().click();
    const long = '这是一段足够长的草稿'.repeat(6);
    await userEvent.keyboard(long);
    await until('editor holds the long draft', () => editorText() === long);
    // 折行之后光标停在最后一个视觉行;这里的 ↑ 属于光标。
    await userEvent.keyboard('{ArrowUp}');
    await until('editor holds the long draft', () => editorText() === long);
    // 反例对照:把光标直接送到文档最前(❌ 按固定次数的 ↑ —— 视觉行数取决于字体加载后的折行,
    // 那是一场跟排版赛跑,已实测会间歇性不够次数；Control+Home 在 macOS Chromium 里也不会
    // 移动 contenteditable 光标),这时 ↑ 就该拿回历史。
    moveCaretToDocumentStart();
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the newest history entry', () => editorText() === '第二条已发出的输入');
  });

  it('多段草稿:光标在第二行按 ↑ 是上移一行,不是换成历史', async () => {
    await userEvent.keyboard('第一行{Shift>}{Enter}{/Shift}第二行');
    await until('editor holds both lines', () => editorText().replace(/\s+/g, '') === '第一行第二行');
    await userEvent.keyboard('{ArrowUp}');
    await until('editor holds both lines', () => editorText().replace(/\s+/g, '') === '第一行第二行');
  });

  it('改过之后再按 ↑ 从最新一条重新开始,而不是接着上次的位置', async () => {
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    await until('editor shows the oldest history entry', () => editorText() === '第一条已发出的输入');
    // 任何一次用户编辑都结束这轮回溯。
    await userEvent.keyboard('x');
    await until('edit lands on the recalled entry', () => editorText() === '第一条已发出的输入x');
    await userEvent.keyboard('{ArrowUp}');
    await until('editor shows the newest history entry', () => editorText() === '第二条已发出的输入');
  });
});
