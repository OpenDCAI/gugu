import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 主进程 ↔ 渲染层的取块一问一答:测试里扮演渲染层(answer = 那台机器上的文件;不 answer = 渲染层没接 / 那台机器没应答)。
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ name: string; data: unknown }> = [];
  return {
    listeners,
    emitted,
    reset() {
      listeners.clear();
      emitted.length = 0;
    },
  };
});

vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../projects/utils', () => ({ resolveWorkspace: vi.fn(() => null) }));
vi.mock('@main/lib/events', () => ({
  events: {
    on: (channel: { name: string }, cb: (data: unknown) => void) => {
      const set = bus.listeners.get(channel.name) ?? new Set();
      set.add(cb);
      bus.listeners.set(channel.name, set);
      return () => set.delete(cb);
    },
    emit: (channel: { name: string }, data: unknown) => bus.emitted.push({ name: channel.name, data }),
  },
}));

import { remotePreviewReadChannel, remotePreviewReadResultChannel } from '@shared/events/appEvents';
import { REMOTE_CHUNK_TIMEOUT_MS, createDocumentPreview, createRemotePreview, handlePreviewRequest, releasePreview, setPreviewDocument } from './preview-protocol';
import { resolveWorkspace } from '../projects/utils';
import { previewDocumentHtml } from '@shared/preview/preview-link-script';

const ROOT = '/root/.config/咕咕/task-home';
const COPY = { unavailable: '没能打开 d22 上的这个网页。', outside: '这里只能打开 d22 上这条会话文件夹里的网页。' };

/** 渲染层:按路径从一份「那台机器上的文件」表里答每一问。 */
function answerFrom(files: Record<string, string>) {
  const timer = setInterval(() => {
    while (bus.emitted.length > 0) {
      const { name, data } = bus.emitted.shift()!;
      if (name !== remotePreviewReadChannel.name) continue;
      const request = data as { requestId: string; path: string; offset: number; length: number };
      const text = files[request.path];
      const reply =
        text === undefined
          ? { requestId: request.requestId, errorCode: 'not_found' }
          : {
              requestId: request.requestId,
              chunk: {
                size: Buffer.byteLength(text),
                etag: 'e1',
                data: Buffer.from(text).subarray(request.offset, request.offset + request.length).toString('base64'),
              },
            };
      for (const cb of bus.listeners.get(remotePreviewReadResultChannel.name) ?? []) cb(reply);
    }
  }, 1);
  return () => clearInterval(timer);
}

function register() {
  const created = createRemotePreview({ projectId: 'proj', workspaceId: 'ws', root: ROOT, surface: 'browser', failureCopy: COPY });
  if (!created) throw new Error('not registered');
  return created.previewId;
}

beforeEach(() => bus.reset());
afterEach(() => vi.useRealTimers());

describe('document-only group HTML transport', () => {
  it('serves and updates only the supplied document, then revokes access', async () => {
    vi.mocked(resolveWorkspace).mockClear();
    const preview = createDocumentPreview('<h1>group</h1>');
    const response = await handlePreviewRequest(new Request(preview.url), 'pane');
    expect(await response.text()).toBe(previewDocumentHtml('<h1>group</h1>', true));
    expect(response.headers.get('Content-Security-Policy')).toBeNull();
    setPreviewDocument(preview.previewId, '<h1>updated</h1>');
    const updated = await handlePreviewRequest(new Request(preview.url + '?r=1#target'), 'pane');
    expect(await updated.text()).toBe(previewDocumentHtml('<h1>updated</h1>', true));
    for (const path of ['/probe.css', '/etc/passwd', '/%2fetc%2fpasswd', '/C:/Users/private.txt', '/']) {
      expect((await handlePreviewRequest(new Request(new URL(path, preview.url)), 'pane')).status).toBe(404);
    }
    expect((await handlePreviewRequest(new Request(preview.url), 'browser')).status).toBe(404);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(bus.emitted).toEqual([]);
    releasePreview(preview.previewId);
    expect((await handlePreviewRequest(new Request(preview.url), 'pane')).status).toBe(404);
  });
});

describe('gugu-preview handler for a page on another machine (#6264)', () => {
  it('serves a page from a non-ASCII session folder (d22: /root/.config/咕咕/task-home)', async () => {
    const stop = answerFrom({ [`${ROOT}/demo-site/index.html`]: '<h1>咕咕</h1>' });
    const id = register();
    const response = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    stop();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<h1>咕咕</h1>');
    releasePreview(id);
  });

  it('never hangs: when nobody answers the read, it times out into a visible error page', async () => {
    vi.useFakeTimers();
    const id = register();
    const pending = handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    await vi.advanceTimersByTimeAsync(REMOTE_CHUNK_TIMEOUT_MS + 10);
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain(COPY.unavailable);
    releasePreview(id);
  });

  it('a missing file and a path the machine refuses both become pages with a plain sentence', async () => {
    const stop = answerFrom({});
    const id = register();
    const missing = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/nope.css`), 'browser');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain(COPY.unavailable);
    const escaping = await handlePreviewRequest(new Request(`gugu-preview://${id}/../../etc/passwd`), 'browser');
    expect(escaping.status).toBeGreaterThanOrEqual(400);
    stop();
    releasePreview(id);
  });

  it('an unknown or released preview, or the wrong surface, answers a page instead of hanging', async () => {
    const id = register();
    const wrongSurface = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'pane');
    expect(wrongSurface.status).toBe(404);
    releasePreview(id);
    const released = await handlePreviewRequest(new Request(`gugu-preview://${id}/demo-site/index.html`), 'browser');
    expect(released.status).toBe(404);
    expect(released.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(bus.emitted).toEqual([]);
  });

  // 「文件」页签里渲染的别的机器的 HTML 跑在这台电脑的渲染层里:明文 http/ws(localhost 只走这两种)一律不许,
  // ❌ 让它打到这台电脑自己的端口(2026-09-24 那一撞的另一条路)。
  it('a remote HTML preview in the file tab may not reach plain http/ws (this computer\'s localhost)', async () => {
    const created = createRemotePreview({
      projectId: 'proj',
      workspaceId: 'ws',
      root: ROOT,
      surface: 'pane',
      documentPath: `${ROOT}/a.html`,
      documentHtml: '<p>hi</p>',
      failureCopy: COPY,
    });
    if (!created) throw new Error('not registered');
    const response = await handlePreviewRequest(new Request(`gugu-preview://${created.previewId}/a.html`), 'pane');
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain('connect-src');
    expect(csp).not.toMatch(/\bhttp:|\bws:|localhost|\*/);
    releasePreview(created.previewId);
  });
});
