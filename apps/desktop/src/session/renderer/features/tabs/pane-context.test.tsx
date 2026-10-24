import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { PaneProvider } from './pane-context';
import type { Pane } from './pane-layout-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: undefined }) }));

function stubPane(paneId: string) {
  const pane = {
    setNextTabActive: vi.fn(),
    setPreviousTabActive: vi.fn(),
    setTabActiveIndex: vi.fn(),
    closeActiveTab: vi.fn(),
  };
  return { group: { paneId, pane } as unknown as Pane, pane };
}

let root: Root;
let dom: JSDOM;

describe('PaneProvider: tab shortcuts listen on the document, so only the page on screen answers', () => {
  beforeEach(() => {
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('one ⌘W closes the active tab of the shown page only, not of a hidden retained page', () => {
    const hidden = stubPane('hidden-pane');
    const shown = stubPane('shown-pane');
    act(() =>
      root.render(
        <>
          <CommandShortcutBinder />
          <PageShownContext.Provider value={false}>
            <PaneProvider group={hidden.group} isFocusedPane>
              <div />
            </PaneProvider>
          </PageShownContext.Provider>
          <PageShownContext.Provider value>
            <PaneProvider group={shown.group} isFocusedPane>
              <div />
            </PaneProvider>
          </PageShownContext.Provider>
        </>
      )
    );
    // "Mod" is Meta on macOS and Control elsewhere; send both, exactly one of them is ⌘W / Ctrl+W here.
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      act(() => {
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true, ...mod }));
      });
    }
    expect(shown.pane.closeActiveTab).toHaveBeenCalledTimes(1);
    expect(hidden.pane.closeActiveTab).not.toHaveBeenCalled();
  });
});
