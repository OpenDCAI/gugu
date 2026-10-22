import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_MAX_ZOOM } from './pinch-zoom';
import { DOCUMENT_PREVIEW_CSP, PREVIEW_LINK_SCRIPT, previewDocumentHtml } from './preview-link-script';

type Listener = (event: unknown) => void;

/** 在一份假文档上跑注入脚本,拿到它挂上的监听器。 */
function runInFakeDocument(script: string) {
  const listeners = new Map<string, Listener>();
  const document = {
    documentElement: { style: { zoom: '' } },
    getElementById: vi.fn(),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  const postMessage = vi.fn();
  const scrollTo = vi.fn();
  runInNewContext(script, { document, parent: { postMessage }, window: { scrollTo } });
  const wheel = (event: { ctrlKey: boolean; deltaY: number }) => {
    const preventDefault = vi.fn();
    listeners.get('wheel')?.({ ...event, preventDefault });
    return preventDefault;
  };
  const click = (href: string) => {
    const preventDefault = vi.fn();
    listeners.get('click')?.({
      target: { closest: () => ({ getAttribute: () => href }) },
      preventDefault,
    });
    return preventDefault;
  };
  return { document, wheel, click, postMessage, scrollTo };
}

describe('shared preview anchors', () => {
  it('scrolls to an existing target without navigating or opening a host link', () => {
    const { document, click, postMessage } = runInFakeDocument(PREVIEW_LINK_SCRIPT);
    const scrollIntoView = vi.fn();
    document.getElementById.mockReturnValue({ scrollIntoView });

    expect(click('#target')).toHaveBeenCalledOnce();
    expect(document.getElementById).toHaveBeenCalledWith('target');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('leaves the document alone without throwing when the target is missing', () => {
    const { document, click, postMessage, scrollTo } = runInFakeDocument(PREVIEW_LINK_SCRIPT);
    document.getElementById.mockReturnValue(null);

    expect(() => click('#target')).not.toThrow();
    expect(postMessage).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('shared preview pinch zoom', () => {
  const script = PREVIEW_LINK_SCRIPT;
  it('zooms the document on a pinch and keeps the page from handling it', () => {
    const { document, wheel } = runInFakeDocument(script);
    const preventDefault = wheel({ ctrlKey: true, deltaY: -100 });

    expect(preventDefault).toHaveBeenCalled();
    expect(Number(document.documentElement.style.zoom)).toBeGreaterThan(1);
  });

  it('leaves plain scrolling alone', () => {
    const { document, wheel } = runInFakeDocument(script);
    const preventDefault = wheel({ ctrlKey: false, deltaY: -100 });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(document.documentElement.style.zoom).toBe('');
  });

  it('stops at the same upper limit as the PDF viewer', () => {
    const { document, wheel } = runInFakeDocument(script);
    for (let i = 0; i < 50; i += 1) wheel({ ctrlKey: true, deltaY: -100 });

    expect(Number(document.documentElement.style.zoom)).toBe(DOCUMENT_MAX_ZOOM);
  });
});

it('prepares the same document policy before untrusted markup for protocol and Blob transports', () => {
  const html = '<base href="file:///private/"><script>window.fixture = true</script>';
  const rendered = previewDocumentHtml(html, true);
  expect(rendered).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  expect(rendered.indexOf(DOCUMENT_PREVIEW_CSP)).toBeLessThan(rendered.indexOf(html));
  expect(DOCUMENT_PREVIEW_CSP).toContain("base-uri 'none'");
  expect(DOCUMENT_PREVIEW_CSP).not.toMatch(/\bfile:|gugu-app:|\bhttp:|\bws:/);
  expect(rendered).toContain(PREVIEW_LINK_SCRIPT);
  expect(previewDocumentHtml(html)).toBe(html + '\n<script>' + PREVIEW_LINK_SCRIPT + '</script>');
});
