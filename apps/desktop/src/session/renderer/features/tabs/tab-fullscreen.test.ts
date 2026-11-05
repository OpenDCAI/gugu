// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { escapeIsFree, tabFullscreen } from './tab-fullscreen';

/** 全屏时 Esc 退出,但先让给正在用它的:弹窗 / 菜单、输入框、终端、编辑器(统筹 10-28 补的那一格)。 */
describe('tab full screen: Esc', () => {
  afterEach(() => {
    tabFullscreen.exit();
    document.body.replaceChildren();
  });
  const add = (html: string) => {
    const box = document.createElement('div');
    box.innerHTML = html;
    document.body.append(box);
    return box.firstElementChild as HTMLElement;
  };

  it('is free on the page itself; taken by a field, a terminal, an editor, or an open dialog / menu', () => {
    expect(escapeIsFree(document.body)).toBe(true);
    expect(escapeIsFree(add('<input />'))).toBe(false);
    expect(escapeIsFree(add('<div contenteditable="true"></div>'))).toBe(false);
    expect(escapeIsFree(add('<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>').querySelector('textarea'))).toBe(false);
    expect(escapeIsFree(add('<div class="cm-editor"><span></span></div>').firstElementChild)).toBe(false);
    add('<div role="dialog"></div>');
    expect(escapeIsFree(document.body)).toBe(false);
  });

  it('Esc on the page leaves full screen; Esc in a terminal does not (and is not swallowed)', () => {
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't' };
    tabFullscreen.toggle(pane, 't');
    const term = add('<div class="xterm"><textarea></textarea></div>').querySelector('textarea')!;
    const inTerminal = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    term.dispatchEvent(inTerminal);
    expect(tabFullscreen.isOn(pane, 't')).toBe(true);
    expect(inTerminal.defaultPrevented).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(tabFullscreen.isOn(pane)).toBe(false);
  });

  it('Esc on the page exits with the persistent Chats list mounted', () => {
    add('<div role="listbox" aria-label="Chats"><div role="option">Chat</div></div>');
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't' };
    tabFullscreen.toggle(pane, 't');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(tabFullscreen.isOn(pane)).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
  });

  it('an open menu owns page Escape without leaving full screen or swallowing the key', () => {
    add('<div role="menu"><button role="menuitem">Open</button></div>');
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't' };
    tabFullscreen.toggle(pane, 't');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(tabFullscreen.isOn(pane, 't')).toBe(true);
    expect(escape.defaultPrevented).toBe(false);
  });

  it('a popup listbox owns page Escape, including a popup controlled by an expanded trigger', () => {
    const popup = add('<div role="listbox" data-open><div role="option">Option</div></div>');
    expect(escapeIsFree(document.body)).toBe(false);
    popup.removeAttribute('data-open');
    popup.id = 'popup';
    const trigger = add('<button aria-expanded="true" aria-controls="other popup">Choose</button>');
    expect(escapeIsFree(document.body)).toBe(false);
    trigger.setAttribute('aria-expanded', 'false');
    expect(escapeIsFree(document.body)).toBe(true);
    expect(escapeIsFree(popup.firstElementChild)).toBe(false);
  });

  it.each([
    '<div hidden><div role="dialog"></div></div>',
    '<div style="display: none"><div role="menu"></div></div>',
    '<div role="menu" style="visibility: hidden"></div>',
    '<div inert><div role="dialog"></div></div>',
    '<div aria-hidden="true"><div role="menu"></div></div>',
    '<div role="listbox" data-open data-closed></div>',
  ])('hidden or closed overlays do not own page Escape: %s', (html) => {
    add(html);
    expect(escapeIsFree(document.body)).toBe(true);
  });
});
