// @vitest-environment jsdom
//
// spec agent-status「附属态」:后台运行中(回合已结束、只剩后台 / 定时)= 同一枚转圈字形、动画停。
// 转动在 CSS 里(.cli-spinner 字形条,合成器位移):这里判组件的契约 —— 永远不起计时器;整套字形都在条上;
// 看不见(窗口、文档、所在页面、视口)就把暂停开关打开,看得见就关上。真实的动画时钟在浏览器用例里判
// (tests/browser/running-motion.test.tsx)。
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLISpinner } from './cliSpinner';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';
import { PageShownContext } from '@renderer/app/recent-session-pages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FRAMES_1 = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(props: { variant?: '1' | '2'; animate?: boolean }): void {
  act(() => root.render(createElement(CLISpinner, props)));
}
const spinner = () => container.querySelector<HTMLElement>('.cli-spinner');
const paused = () => spinner()?.style.getPropertyValue('--chat-shimmer-viewport-paused') === 'paused';

describe('CLISpinner', () => {
  it.each(['1', '2'] as const)('variant %s: the strip carries every frame and no timer ever runs', (variant) => {
    render({ variant });
    const strip = container.querySelector('.cli-spinner__strip')!;
    expect(strip.children.length).toBe(variant === '1' ? 10 : 24);
    expect(spinner()!.style.getPropertyValue('--cli-spinner-frames')).toBe(String(strip.children.length));
    act(() => vi.advanceTimersByTime(5000));
    expect(vi.getTimerCount()).toBe(0);
    expect(paused()).toBe(false);
  });

  it('native minimize pauses it and restore resumes it, including on remount', () => {
    render({});
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    expect(paused()).toBe(true);
    render({ variant: '2' });
    expect(paused()).toBe(true);
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })));
    expect(paused()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses on document visibility changes and resumes when visible', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render({});
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(paused()).toBe(true);
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(paused()).toBe(false);
  });

  it('uses the retained page visibility and resumes on return', () => {
    const page = (shown: boolean) => createElement(PageShownContext.Provider, { value: shown }, createElement(CLISpinner));
    act(() => root.render(page(true)));
    expect(paused()).toBe(false);
    act(() => root.render(page(false)));
    expect(paused()).toBe(true);
    act(() => root.render(page(true)));
    expect(paused()).toBe(false);
  });

  it('uses the shared viewport observer to pause and restart offscreen motion', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false);
    doc.body.append(container);
    let intersect!: IntersectionObserverCallback;
    const unobserve = vi.fn();
    Object.defineProperty(doc.defaultView!, 'IntersectionObserver', { configurable: true, value: class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      unobserve = unobserve;
    } });
    render({});
    const target = spinner()!;
    const visible = (isIntersecting: boolean) => act(() => intersect([{ target, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    visible(false);
    expect(paused()).toBe(true);
    visible(true);
    expect(paused()).toBe(false);
    act(() => root.render(null));
    expect(unobserve).toHaveBeenCalledWith(target);
    document.body.append(container);
    iframe.remove();
  });

  it('follows its portal document rather than the hidden main document', () => {
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const portalDoc = iframe.contentDocument!;
    vi.spyOn(portalDoc, 'hidden', 'get').mockReturnValue(false);
    portalDoc.body.append(container);
    render({});
    expect(paused()).toBe(false);
    act(() => portalDoc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    expect(paused()).toBe(true);
    act(() => portalDoc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })));
    expect(paused()).toBe(false);
    act(() => root.render(null));
    document.body.append(container);
    iframe.remove();
  });

  it.each(['1', '2'] as const)('variant %s: animate=false draws one still glyph from the running set', (variant) => {
    render({ variant, animate: false });
    expect(container.querySelector('.cli-spinner')).toBeNull();
    expect(container.querySelector('[data-animate="false"]')!.textContent).toBe('⠋');
    expect(FRAMES_1).toContain(container.textContent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])('animate=%s: the glyph keeps the ink colour (owner 2026-09-26)', (animate) => {
    render({ variant: '2', animate });
    const glyph = container.firstElementChild as HTMLElement;
    expect(glyph.className).toContain('text-foreground/60');
    expect(glyph.className).not.toContain('agent-tone');
  });
});
