// @vitest-environment jsdom
import { observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';
import { escapeIsFree } from '@shared/escape-is-free';
import { tabFullscreen } from './tab-fullscreen';

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
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't', isFocused: true };
    tabFullscreen.toggle(pane, 't');
    const term = add('<div class="xterm"><textarea></textarea></div>').querySelector('textarea')!;
    const inTerminal = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    term.dispatchEvent(inTerminal);
    expect(tabFullscreen.isOn(pane, 't')).toBe(true);
    expect(inTerminal.defaultPrevented).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(tabFullscreen.isOn(pane)).toBe(false);
  });

  it('a row of the persistent Chats list holding the focus does not own Esc', () => {
    const row = add('<div role="listbox" aria-label="Chats"><div role="option" tabindex="0">Chat</div></div>').firstElementChild;
    expect(escapeIsFree(row)).toBe(true);
  });

  it('leaves full screen when the focus goes to another pane of the layout', () => {
    const focused = observable.box(true);
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't', get isFocused() { return focused.get(); } };
    tabFullscreen.toggle(pane, 't');
    expect(tabFullscreen.isOn(pane, 't')).toBe(true);
    runInAction(() => focused.set(false));
    expect(tabFullscreen.target).toBeNull();
  });

  it('Esc on the page exits with the persistent Chats list mounted', () => {
    add('<div role="listbox" aria-label="Chats"><div role="option">Chat</div></div>');
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't', isFocused: true };
    tabFullscreen.toggle(pane, 't');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(tabFullscreen.isOn(pane)).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
  });

  it('an open menu owns page Escape without leaving full screen or swallowing the key', () => {
    add('<div role="menu"><button role="menuitem">Open</button></div>');
    const pane = { entries: new Set(['t']), resolvedActiveTabId: 't', isFocused: true };
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
    popup.setAttribute('data-open', '');
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
