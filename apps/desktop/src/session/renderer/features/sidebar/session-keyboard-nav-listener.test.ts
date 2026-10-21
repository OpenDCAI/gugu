// @vitest-environment jsdom
// #6264 设置窗口开着时,打的字❌ 进背后会话页的输入框(2026-09-24 实测:设置 → 设备里敲的 `ssh …` + 回车在背后开了一条真会话)。
// 门在 sessionNavContextFor:它判成 'nav' 的可打印键会被 focusSessionComposer 接走。
import { afterEach, describe, expect, it } from 'vitest';
import { hasOpenModalDialog, sessionNavContextFor } from './session-keyboard-nav-listener';

function keyOn(target: EventTarget, key = 's'): KeyboardEvent {
  let seen: KeyboardEvent | null = null;
  const listener = (event: Event) => {
    seen = event as KeyboardEvent;
  };
  document.addEventListener('keydown', listener);
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  document.removeEventListener('keydown', listener);
  return seen!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('session keyboard nav · 模态窗口开着时不接键盘', () => {
  it('没有模态:焦点在 body 上打字 = nav(会被交给输入框)', () => {
    expect(hasOpenModalDialog()).toBe(false);
    expect(sessionNavContextFor(keyOn(document.body))?.context).toBe('nav');
  });

  it('壳层的模态(设置窗口,aria-modal)开着、焦点掉在 body 上:不是我们的键,❌ 交给背后的输入框', () => {
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(sheet);
    expect(hasOpenModalDialog()).toBe(true);
    expect(sessionNavContextFor(keyOn(document.body))).toBeNull();
  });

  it('模态开着、事件来自背后任务页的输入框本身:同样不接', () => {
    const composer = document.createElement('div');
    composer.setAttribute('data-testid', 'prompt-editor');
    composer.tabIndex = 0;
    document.body.appendChild(composer);
    const sheet = document.createElement('div');
    sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(sheet);
    expect(sessionNavContextFor(keyOn(composer, 'ArrowDown'))).toBeNull();
  });
});
