import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_MAX_ZOOM } from './pinch-zoom';
import { PREVIEW_LINK_SCRIPT, SRCDOC_PREVIEW_LINK_SCRIPT } from './preview-link-script';

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

/**
 * #6456: 预览是沙箱 iframe,里面的 wheel 宿主接不到,双指捏合只能由注入脚本自己接。
 * 有地址(文件标签)和 srcdoc(聊天里的 HTML 附件)两段脚本,两边都要能缩放。
 */
describe.each([
  ['PREVIEW_LINK_SCRIPT', PREVIEW_LINK_SCRIPT],
  ['SRCDOC_PREVIEW_LINK_SCRIPT', SRCDOC_PREVIEW_LINK_SCRIPT],
])('%s pinch zoom', (_name, script) => {
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
