import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppVariantList, type AppVariantRow } from './app-variant-list';
import type { ResourceContext } from '@shared/resource-actions';

const contexts = vi.hoisted(() => [] as ResourceContext[]);
vi.mock('@/components/ResourceMenu', () => ({ ResourceMenu: ({ resource, children }: { resource: ResourceContext; children: React.ReactNode }) => { contexts.push(resource); return children; } }));

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

  beforeEach(() => {
    vi.clearAllMocks();
    contexts.length = 0;
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
      active: 'timeline', variants: rows, disabled, translate, onSwitch,
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

  it('disables switching while the host cannot change the App', async () => {
    await render(true);
    const choices = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect([...choices].map((choice) => choice.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    await act(async () => choices[0]!.click());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('keeps active-fork lag out of another, newer variant menu', async () => {
    await act(async () => root.render(React.createElement(AppVariantList, {
      active: 'timeline', variants: [...variants, { name: 'fresh', base: '2.0.0', dir: '/work/board@fresh' }], disabled: false, translate, onSwitch,
      resource: { kind: 'app', target: { kind: 'app-detail', extensionId: 'board', deviceId: 'device' }, facts: ['behind'] },
    })));
    expect(contexts.find(row => row.target.kind === 'app-detail' && row.target.variant === 'timeline')?.facts).toContain('behind');
    expect(contexts.find(row => row.target.kind === 'app-detail' && row.target.variant === 'fresh')?.facts).toEqual(['fork']);
  });
});
