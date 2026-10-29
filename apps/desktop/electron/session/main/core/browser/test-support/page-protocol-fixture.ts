import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { vi } from 'vitest';
import { trackPageNavigation } from '../page-navigation-tracker';

export function page(urls = ['https://example.test/'], activeIndex = urls.length - 1, options: { loading?: boolean } = {}) {
  const entries = urls.map(url => ({ url }));
  let attached = false, destroyed = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    sendCommand: vi.fn(async (_method: string, _params?: object, _session?: string): Promise<unknown> => ({ ok: true })),
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    getURL: vi.fn(() => entries[activeIndex]?.url ?? ''),
    isLoading: vi.fn(() => options.loading ?? false),
    navigationHistory: {
      getAllEntries: vi.fn(() => entries),
      getActiveIndex: vi.fn(() => activeIndex),
      removeEntryAtIndex: vi.fn((index: number) => {
        if (index === activeIndex) return false;
        entries.splice(index, 1);
        if (index < activeIndex) activeIndex -= 1;
        return true;
      }),
    },
    isDestroyed: () => destroyed,
    close: vi.fn(), loadURL: vi.fn(), focus: vi.fn(),
  });
  trackPageNavigation(contents as unknown as WebContents);
  return { contents: contents as unknown as WebContents, debuggerApi, entries,
    destroy: () => { destroyed = true; contents.emit('destroyed'); } };
}
