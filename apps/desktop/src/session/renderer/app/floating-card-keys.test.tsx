// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFloatingCardKeys } from './floating-card-keys';

/**
 * #36(81 条核对):卡上写着「直接打字或按 Esc,它就收起」,按 Esc 却不收 —— 输入框里的 Esc 被会话键盘导航
 * (document 上的监听)处理完就停止冒泡,卡的监听等不到。卡浮着时 Esc 只收卡;卡没浮着时 Esc 照旧归键盘导航。
 */

let container: HTMLDivElement;
let root: Root;
let navSaw: string[];
const nav = (event: KeyboardEvent) => {
  // 与会话键盘导航同一个位置、同一种处理:document 上接住,处理完停止冒泡。
  navSaw.push(event.key);
  event.preventDefault();
  event.stopPropagation();
};

beforeEach(() => {
  navSaw = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  document.addEventListener('keydown', nav);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.removeEventListener('keydown', nav);
});

function Dock({ cardShown, hideCard }: { cardShown: boolean; hideCard: () => void }) {
  const dockRef = useRef<HTMLDivElement>(null);
  useFloatingCardKeys(cardShown, hideCard, dockRef);
  return <div ref={dockRef}><div contentEditable data-testid="editor" tabIndex={0} /></div>;
}

function escapeInEditor(): void {
  const editor = container.querySelector('[data-testid="editor"]') as HTMLElement;
  editor.focus();
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

describe('the floating folder card and Escape', () => {
  it('puts the card away and keeps that Escape from the keyboard navigation', () => {
    const hideCard = vi.fn();
    act(() => root.render(<Dock cardShown hideCard={hideCard} />));
    escapeInEditor();
    expect(hideCard).toHaveBeenCalledTimes(1);
    expect(navSaw).toEqual([]);
  });

  it('leaves Escape to the keyboard navigation when no card floats', () => {
    const hideCard = vi.fn();
    act(() => root.render(<Dock cardShown={false} hideCard={hideCard} />));
    escapeInEditor();
    expect(hideCard).not.toHaveBeenCalled();
    expect(navSaw).toEqual(['Escape']);
  });
});
