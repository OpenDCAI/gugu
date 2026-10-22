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
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  };
  runInNewContext(script, { document, parent: { postMessage: vi.fn() }, window: {} });
  const wheel = (event: { ctrlKey: boolean; deltaY: number }) => {
    const preventDefault = vi.fn();
    listeners.get('wheel')?.({ ...event, preventDefault });
    return preventDefault;
  };
  return { document, wheel };
}

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
