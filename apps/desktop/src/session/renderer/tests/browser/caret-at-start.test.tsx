/**
 * `caretAtStartOf` —— 真 Chromium 上量「← 此刻在输入框里是不是无事可做」。
 *
 * behavior session-page「键盘导航」: ← 只在光标已在最前且无选中文字时才是出口。这条判据决定的是
 * 「按 ← 会不会莫名其妙跳出输入框」,而它只能在真 DOM 的 Selection/Range 上量 —— jsdom 里
 * `Range.toString()` 与换行节点的行为跟浏览器不一致,量了也不算数。
 */
import { page } from '@vitest/browser/context';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caretAtStartOf } from '@renderer/features/sidebar/caret-at-start';

let host: HTMLDivElement;

/** 一个立得住的替身:真 contenteditable,内容由调用方用真节点搭。 */
function mount(build: (el: HTMLElement) => void): HTMLElement {
  host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.appendChild(host);
  build(host);
  return host;
}

function putCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('caretAtStartOf', () => {
  beforeEach(async () => {
    await page.viewport(800, 600);
  });

  afterEach(() => {
    host?.remove();
  });

  it('空输入框:光标就在最前', () => {
    const el = mount((e) => {
      e.append(document.createTextNode(''));
    });
    putCaret(el.firstChild!, 0);
    expect(caretAtStartOf(el)).toBe(true);
  });

  it('有字且光标在开头 = 在最前;往后挪一格就不是了', () => {
    const el = mount((e) => {
      e.append(document.createTextNode('草稿'));
    });
    putCaret(el.firstChild!, 0);
    expect(caretAtStartOf(el)).toBe(true);
    putCaret(el.firstChild!, 1);
    expect(caretAtStartOf(el)).toBe(false);
  });

  it('选中了文字就不是 —— 那时 ← 是取消选择', () => {
    const el = mount((e) => {
      e.append(document.createTextNode('草稿'));
    });
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 2);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(caretAtStartOf(el)).toBe(false);
  });

  it('首行是空行时,第二行行首不算最前 —— 换行不是文字,只看文字会误判', () => {
    const el = mount((e) => {
      e.append(document.createElement('br'));
      e.append(document.createTextNode('第二行'));
    });
    putCaret(el.lastChild!, 0);
    // 反例对照:同一棵树上,把光标放到 br 之前就该是 true,否则这条断言可能恒假。
    expect(caretAtStartOf(el)).toBe(false);
    putCaret(el, 0);
    expect(caretAtStartOf(el)).toBe(true);
  });
});
