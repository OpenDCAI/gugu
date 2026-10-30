import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame';
import { PREVIEW_RESTORE_MESSAGE_TYPE, PREVIEW_SCROLL_MESSAGE_TYPE, previewDocumentHtml } from '@shared/preview/preview-link-script';
import '@/styles/tokens.css';
import '@renderer/index.css';

it('keeps scroll across a real opaque-sandbox document reload without exposing an empty surface', async () => {
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;height:400px;position:relative';
  document.body.append(container);
  const root = createRoot(container);
  const urls: string[] = [];
  const scrolls: Array<{ source: MessageEventSource | null; y: number }> = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === PREVIEW_SCROLL_MESSAGE_TYPE) scrolls.push({ source: event.source, y: event.data.y });
  };
  window.addEventListener('message', onMessage);
  const makeUrl = (content: string) => {
    const url = URL.createObjectURL(new Blob([previewDocumentHtml(`<body style="height:3500px">${content}</body>`)], { type: 'text/html' }));
    urls.push(url); return url;
  };
  const register = async (content: string): Promise<HtmlPreviewRegistration> => ({
    ok: true, url: makeUrl(content), update: async next => makeUrl(next), release: () => {},
  });
  const draw = async (rawContent: string) => act(async () => root.render(<HtmlPreviewFrame fileName="long.html" rawContent={rawContent} register={register} onLink={() => {}} />));
  try {
    await draw('first');
    const first = container.querySelector('iframe')!;
    const firstUrl = first.src;
    await vi.waitFor(() => expect(first.contentWindow).toBeTruthy());
    // The page is opaque, so exercise the real child message path instead of reading its DOM.
    await vi.waitFor(() => {
      first.contentWindow!.postMessage({ type: PREVIEW_RESTORE_MESSAGE_TYPE, x: 0, y: 1000 }, '*');
      expect(scrolls.some(event => event.source === first.contentWindow && event.y === 1000)).toBe(true);
    });
    scrolls.length = 0;
    await draw('second');
    expect(getComputedStyle(first).visibility).toBe('visible');
    await vi.waitFor(() => {
      expect(container.querySelectorAll('iframe')).toHaveLength(1);
      expect(container.querySelector('iframe')?.src).not.toBe(firstUrl);
    });
    const second = container.querySelector('iframe')!;
    expect(getComputedStyle(second).visibility).toBe('visible');
    expect(second.getAttribute('sandbox')).toBe('allow-scripts');
    await vi.waitFor(() => expect(scrolls.some(event => event.source === second.contentWindow && event.y === 1000)).toBe(true));
  } finally {
    act(() => root.unmount()); container.remove(); window.removeEventListener('message', onMessage);
    urls.forEach(url => URL.revokeObjectURL(url));
  }
});
