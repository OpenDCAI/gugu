import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { mirrorDocument } from './aux-document';
import { ANIMATION_WINDOW_SEEN_EVENT, isAnimationWindowVisible } from '@gugu/session-shared/animation-visibility';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('子窗口的文档跟主窗长得一样(#7052 单独成窗)', () => {
  it('mirrors theme changes without copying native visibility from the opener', async () => {
    const mainWindow = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true }).window;
    const childWindow = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true }).window;
    const main = mainWindow.document, child = childWindow.document;
    isAnimationWindowVisible(main);
    mainWindow.dispatchEvent(new mainWindow.CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
    const stop = mirrorDocument(main, child);
    try {
      expect(isAnimationWindowVisible(main)).toBe(false);
      expect(isAnimationWindowVisible(child)).toBe(true);
      main.documentElement.dataset.theme = 'dark';
      main.documentElement.style.setProperty('--accent', 'red');
      await flush();
      expect(child.documentElement.dataset.theme).toBe('dark');
      expect(child.documentElement.style.getPropertyValue('--accent')).toBe('red');
      expect(isAnimationWindowVisible(child)).toBe(true);
      childWindow.dispatchEvent(new childWindow.CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
      mainWindow.dispatchEvent(new mainWindow.CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
      await flush();
      expect(isAnimationWindowVisible(main)).toBe(true);
      expect(isAnimationWindowVisible(child)).toBe(false);
      childWindow.dispatchEvent(new childWindow.CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
      expect(isAnimationWindowVisible(child)).toBe(true);
    } finally {
      stop();
      mainWindow.close();
      childWindow.close();
    }
  });

  it('样式按先后抄过去,之后加的、删的、改的都跟着;<html> 上的主题标记也跟着', async () => {
    const main = new JSDOM('<!doctype html><html data-theme="light" class="emlight"><head><style id="a">.a{}</style><link rel="stylesheet" href="/b.css"><meta name="x"></head><body></body></html>').window.document;
    const child = new JSDOM('<!doctype html><html><head></head><body></body></html>').window.document;
    const stop = mirrorDocument(main, child);

    expect([...child.head.children].map((node) => node.nodeName)).toEqual(['STYLE', 'LINK']);
    expect(child.documentElement.getAttribute('data-theme')).toBe('light');

    const late = main.createElement('style');
    late.textContent = '.late{}';
    main.head.insertBefore(late, main.head.querySelector('link'));
    main.documentElement.setAttribute('data-theme', 'dark');
    main.documentElement.classList.replace('emlight', 'emdark');
    await flush();
    expect([...child.head.children].map((node) => node.textContent)).toEqual(['.a{}', '.late{}', '']);
    expect(child.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(child.documentElement.className).toBe('emdark');

    main.querySelector('#a')!.textContent = '.a{color:red}';
    main.head.querySelector('link')!.remove();
    await flush();
    expect([...child.head.children].map((node) => node.textContent)).toEqual(['.a{color:red}', '.late{}']);

    stop();
    main.head.appendChild(main.createElement('style'));
    await flush();
    expect(child.head.children).toHaveLength(2);
  });
});
