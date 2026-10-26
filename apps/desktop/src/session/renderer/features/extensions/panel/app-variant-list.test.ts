import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppVariantList, appForkPrompt, type AppVariantRow } from './app-variant-list';

const variants: AppVariantRow[] = [
  { name: 'upstream', base: '1.0.0', dir: null },
  { name: 'timeline', base: '1.0.0', dir: '/work/board@timeline' },
];
const translate = ((key: string, values?: Record<string, unknown>) =>
  key + (values ? ` ${Object.values(values).join(' ')}` : '')) as never;

describe('App variants', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;
  const onSwitch = vi.fn();
  const onCopy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'navigator', 'MutationObserver'] as const) {
      vi.stubGlobal(key, dom.window[key]);
    }
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.querySelector('#root')!;
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });

  async function render(disabled = false, rows = variants) {
    await act(async () => root.render(React.createElement(AppVariantList, {
      active: 'timeline', variants: rows, disabled, translate, onSwitch, onCopy,
    })));
  }

  it('hides the list until there is a choice', async () => {
    await render(false, variants.slice(0, 1));
    expect(container.textContent).toBe('');
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('selects the active fork; choosing the original requests a switch', async () => {
    await render();
    const choices = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...choices].map((choice) => choice.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    await act(async () => choices[0]!.click());
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith('upstream');
  });

  it('copying a fork prompt does not switch variants', async () => {
    await render();
    const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'extensions.copyPrompt');
    expect(copy).toBeDefined();
    await act(async () => copy!.click());
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(variants[1]);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('disables switching while the host cannot change the App', async () => {
    await render(true);
    const choices = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...choices].every((choice) => choice.disabled)).toBe(true);
    await act(async () => choices[0]!.click());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('the update prompt names the exact source and commit and preserves the person\'s work', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const prompt = appForkPrompt({ id: 'board', name: 'Board' }, variants[1]!, { upstream: '1.2.0', behind: 2, commit });
    expect(prompt).toContain('/work/board@timeline');
    expect(prompt).toContain(commit);
    expect(prompt).toContain('guide apps-fork');
    expect(prompt).toContain('preserving the custom changes and existing data');
  });
});
