/**
 * `gugu-preview://` —— 网页预览的文件供给。
 *
 * 以前预览走 `srcdoc`:文档没有自己的地址,于是相对资源得由渲染层手工内联(300 行),
 * 页内锚点会被当成跨文档导航把 iframe 整个导走(#6156 的白屏)。现在预览有了真地址,
 * 相对路径、锚点、`srcset`、CSS 里的 `url(...)`、音视频、`@import` 全部回到浏览器手里 ——
 * 这一条的价值不在于少写代码,在于**我们不再需要把浏览器已经实现好的 URL 解析重写一遍,
 * 也就不会每次只重写我们碰巧遇到过的那几种**。
 *
 * 形状照 `extensions/extension-protocol.ts`:一个 scheme、一个 handler、一道路径围栏。
 * 那一套已经在扩展上跑着,预览这一处此前是同一个仓里唯一还在手工内联的那种做法。
 *
 * 围栏本身是纯函数,住在 `@shared/preview/preview-url`,主进程与渲染层读同一份、单测直接打它。
 */

import { protocol, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { IFileSystem } from '@gugu/session-core/files';
import { REMOTE_WORKSPACE_MAX_FILE_BYTES } from '@gugu/session-core/session-record/contract';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { remotePreviewReadChannel, remotePreviewReadResultChannel } from '@shared/events/appEvents';
import {
  PREVIEW_SCHEME,
  previewRootFor,
  previewUrl,
  resolvePreviewRequest,
  type PreviewRoot,
} from '@shared/preview/preview-url';
import { remotePageRoot } from '@shared/preview/remote-page-url';
import { DOCUMENT_PREVIEW_CSP, previewDocumentHtml } from '@shared/preview/preview-link-script';
import { resolveWorkspace } from '../projects/utils';
import { readRemotePreviewBytes, remotePreviewFailureStatus, withUtf8Charset, type RemoteChunk } from './remote-preview-read';

/**
 * 字节从哪来:本机工作区的文件系统,或 #6264 别的机器上一条会话的工作目录
 * (经渲染层走会话工作区那条既有的读文件动词,见 `readRemoteChunk`)。
 */
type PreviewSource =
  | { kind: 'local'; projectId: string; workspaceId: string }
  | { kind: 'remote'; projectId: string; workspaceId: string };

/**
 * 在哪一处被加载:
 *  · `pane`    「文件」页签里的 HTML 预览(沙箱 iframe,渲染层默认会话)—— 注入链接拦截脚本;
 *  · `browser` 「浏览器」页签(#6264 别的机器上的网页):整页导航归浏览器自己,❌ 注入拦截脚本。
 * 两处的登记互不相通:浏览器分区里的 handler 只认 `browser` 登记,反之亦然。
 */
export type PreviewSurface = 'pane' | 'browser';

/**
 * 一次预览的登记。**id 就是这个页面的 origin**(`gugu-preview://<id>/`),所以两份预览之间
 * 天然互不同源:一份页面存的 localStorage、发的同源请求,都到不了另一份。
 */
interface PreviewRegistration {
  source: PreviewSource;
  surface: PreviewSurface;
  root: PreviewRoot;
  /** 被打开的那份文档的绝对路径 —— 只有它会被注入链接拦截脚本。浏览器页签没有这一份(整页可以导航到别处)。 */
  documentPath?: string;
  /**
   * 编辑器里这一刻的正文。**有它就发它,不读盘。**
   *
   * 预览一直渲染的是编辑器缓冲区而不是磁盘上那份 —— 改一个字、切到预览就能看见,不必先保存。
   * 换成协议供文件之后这条很容易被顺手丢掉(读盘最省事),而丢掉之后症状是「我明明改了,
   * 预览没变」,用户第一反应是预览坏了。所以文档本体由渲染层覆写,**它旁边的资源仍然读盘**:
   * 那些本来就只有磁盘一份。
   */
  documentHtml?: string;
  /**
   * #6264 取不到时整页显示的那一句(渲染层按界面语言写好交过来,主进程 ❌ 自己拼用户文案)。
   * 浏览器页签里一个失败的请求必须变成一页看得见的说明,❌ 白屏。
   */
  failureCopy?: PreviewFailureCopy;
}

/** 取不到时给人看的话:`outside` 在会话目录外;其余(读不到、超时、太大、登记已撤)一律 `unavailable`。 */
export type PreviewFailureCopy = { unavailable: string; outside: string };

/** 群正文没有文件系统根;类型和请求入口都禁止退回本地/远端文件读取。 */
type DocumentPreviewRegistration = {
  source: { kind: 'document' };
  surface: 'pane';
  documentHtml: string;
  failureCopy?: never;
};

const registry = new Map<string, PreviewRegistration | DocumentPreviewRegistration>();

export function createDocumentPreview(documentHtml: string): { url: string; previewId: string } {
  const previewId = newPreviewId();
  registry.set(previewId, { source: { kind: 'document' }, surface: 'pane', documentHtml });
  return { url: `${PREVIEW_SCHEME}://${previewId}/index.html`, previewId };
}

/**
 * 单份资源的上限。超了答 413 而不是截断后照发 —— 半截样式表或半截脚本进了页面,渲染错乱
 * 而界面上零提示,那正是最难查的一类故障(#5750 在内联那条路上踩过同一个坑)。
 */
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;

/**
 * 给一份文档登记一次预览,拿到它的地址。
 *
 * 每次打开都发一个新 id:上一次预览存下的东西不该被下一次读到,而 id 即 origin,换 id 就是换源。
 */
export function createPreview(
  projectId: string,
  workspaceId: string,
  documentPath: string,
  documentHtml?: string
): { url: string; previewId: string } | null {
  // 工作区根由主进程自己查,❌ 不收渲染层传来的那一份 —— 围栏的边界不该由被围的那一侧给。
  const env = resolveWorkspace(projectId, workspaceId);
  if (!env) return null;
  const root = previewRootFor(env.path, documentPath);
  const previewId = newPreviewId();
  const url = previewUrl(previewId, root, documentPath);
  if (!url) return null;
  registry.set(previewId, {
    source: { kind: 'local', projectId, workspaceId },
    surface: 'pane',
    root,
    documentPath,
    documentHtml,
  });
  return { url, previewId };
}

/**
 * #6264 别的机器上一条会话的工作目录登记一次预览。
 *
 * 根(会话工作目录)由渲染层给 —— 本机那条「围栏不由被围的一侧给」在这里由**那台机器**守:
 * 每一块字节都经读文件动词取,它按会话目录核路径与符号链接,根给错了也只会取不到,❌ 取到目录外的东西。
 * 这里的根只决定 URL 怎么排。
 *
 *  · `pane`:「文件」页签的 HTML 预览,带 `documentPath`(+ 编辑器正文),返回那份文档的地址;
 *  · `browser`:「浏览器」页签,不带文档 —— 页签按 `remote-page-url.ts` 自己把 `file:` 地址排进来。
 */
export function createRemotePreview(input: {
  /** 那台机器上的项目与工作区(渲染层按项目所在机器把读块请求路由过去)。 */
  projectId: string;
  workspaceId: string;
  root: string;
  surface: PreviewSurface;
  documentPath?: string;
  documentHtml?: string;
  failureCopy?: PreviewFailureCopy;
}): { previewId: string; url: string | null } | null {
  const root = remotePageRoot(input.root);
  if (!root) return null;
  const previewId = newPreviewId();
  let url: string | null = null;
  if (input.documentPath !== undefined) {
    url = previewUrl(previewId, root, input.documentPath);
    // 文档不在这条会话的工作目录里:那台机器一块也不会给,❌ 登记一个注定白屏的预览。
    if (!url) return null;
  }
  registry.set(previewId, {
    source: { kind: 'remote', projectId: input.projectId, workspaceId: input.workspaceId },
    surface: input.surface,
    root,
    documentPath: input.surface === 'pane' ? input.documentPath : undefined,
    documentHtml: input.surface === 'pane' ? input.documentHtml : undefined,
    failureCopy: input.failureCopy,
  });
  log.info('Remote preview registered', {
    previewId,
    surface: input.surface,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
  });
  return { previewId, url };
}

function newPreviewId(): string {
  return randomUUID().replace(/-/g, '');
}

/** 编辑器里的正文变了。下一次取这份文档就发新的。 */
export function setPreviewDocument(previewId: string, documentHtml: string): void {
  const registration = registry.get(previewId);
  if (registration) registration.documentHtml = documentHtml;
}

/** 关掉一个 tab 时撤掉它的登记 —— 登记留着就等于那份文件一直可被取。 */
export function releasePreview(previewId: string): void {
  const registration = registry.get(previewId);
  if (registration?.source.kind === 'remote') log.info('Remote preview released', { previewId });
  registry.delete(previewId);
}

/**
 * 装上 handler。与扩展那条一样,**每次请求都重新读登记**,不把它闭包进来:
 * 一次预览可以在文件被换掉之后仍然活着,闭包会让它继续供上一份。
 */
export function setupPreviewProtocol(): void {
  if (protocol.isProtocolHandled(PREVIEW_SCHEME)) return;
  protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request, 'pane'));
}

/**
 * #6264 浏览器页签的分区也装一份(协议 handler 按会话装,默认会话那一份到不了浏览器分区)。
 * 这一份只认 `browser` 登记:网页页签取不到「文件」页签那些预览,反之亦然。
 */
export function setupBrowserPreviewProtocol(ses: Pick<Session, 'protocol'>): void {
  if (ses.protocol.isProtocolHandled(PREVIEW_SCHEME)) return;
  ses.protocol.handle(PREVIEW_SCHEME, (request) => handlePreviewRequest(request, 'browser'));
}

/**
 * 一次请求的总入口:**永远有一个响应**。handler 里任何一处抛出、任何一处没等到(那台机器没应答、渲染层没接),
 * 都变成一页说明,❌ 让页签一直转、dom-ready 永远不来。每一问记一行(id、路径、来源、结果、耗时)。
 */
export async function handlePreviewRequest(request: Request, surface: PreviewSurface): Promise<Response> {
  const started = Date.now();
  let url: URL | null = null;
  let response: Response;
  try {
    const parsed = new URL(request.url);
    url = parsed;
    response = await withDeadline(servePreviewRequest(parsed, surface), PREVIEW_REQUEST_DEADLINE_MS, () =>
      failurePage(registry.get(parsed.hostname)?.failureCopy, 'unavailable', 504, 'timeout')
    );
  } catch (error) {
    log.error('Preview request failed', { url: request.url, error: String(error) });
    response = failurePage(url ? registry.get(url.hostname)?.failureCopy : undefined, 'unavailable', 500, 'error');
  }
  const registration = url ? registry.get(url.hostname) : undefined;
  if (registration?.source.kind === 'remote' || response.status >= 400) {
    const fields = {
      previewId: url?.hostname,
      path: url ? safeDecode(url.pathname) : request.url,
      source: registration?.source.kind ?? 'unknown',
      surface,
      status: response.status,
      ms: Date.now() - started,
    };
    if (response.status >= 400) log.warn('Preview request', fields);
    else log.info('Preview request', fields);
  }
  return response;
}

/** 一次请求最久等多久(每一块另有自己的超时;这一道兜住「哪一处都没超时却也没回来」)。 */
export const PREVIEW_REQUEST_DEADLINE_MS = 90_000;

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * 取不到时的那一页:一句人话(登记时渲染层给的),原因码只进日志与响应头。没有登记(已撤 / 从没有过)时退回英文一句 ——
 * 那时没有人给过文案,而白屏比一句英文更糟。
 */
function failurePage(
  copy: PreviewFailureCopy | undefined,
  kind: keyof PreviewFailureCopy,
  status: number,
  reason: string
): Response {
  const text = copy?.[kind] ?? 'This page is not available right now. Open it again from the session.';
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(text)}</title>` +
      '<body style="font:13px system-ui,sans-serif;color:#666;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:0 24px;text-align:center">' +
      `<p>${escapeHtml(text)}</p></body>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Gugu-Preview-Failure': reason,
      },
    }
  );
}

async function servePreviewRequest(url: URL, surface: PreviewSurface): Promise<Response> {
  const registration = registry.get(url.hostname);
  if (!registration || registration.surface !== surface) {
    return failurePage(undefined, 'unavailable', 404, 'unknown_preview');
  }

  if (!('root' in registration)) {
    return url.pathname === '/index.html'
      ? htmlResponse(registration.documentHtml, registration)
      : notFound('document only');
  }

  const resolved = resolvePreviewRequest(registration.root, url.pathname);
  if (!resolved) {
    // 越界是围栏在起作用,不是「文件没找到」—— 说清楚,否则下次查起来只看到一个 404。
    log.warn('Preview request outside its root', { pathname: url.pathname });
    return registration.source.kind === 'remote'
      ? failurePage(registration.failureCopy, 'outside', 403, 'outside_root')
      : new Response('forbidden', { status: 403 });
  }

  const isDocument = resolved === registration.documentPath;

  // 文档本体优先发编辑器里那一份 —— 用户改了没保存也要看得见(见 documentHtml 的注释)。
  if (isDocument && registration.documentHtml !== undefined) {
    return htmlResponse(registration.documentHtml, registration);
  }

  const read = await readPreviewBytes(registration, resolved);
  if (!read.ok) return read.response;

  const mimeType = mimeTypeFor(resolved);
  if (isDocument && mimeType === 'text/html') {
    return htmlResponse(new TextDecoder().decode(read.bytes), registration);
  }

  return new Response(bodyOf(read.bytes), {
    status: 200,
    headers: {
      'Content-Type': registration.source.kind === 'remote' ? withUtf8Charset(mimeType, read.bytes) : mimeType,
      // 预览页跑在沙箱里(不透明源),它取自己旁边的模块脚本与字体会带 `Origin: null`,
      // 不放行就会被 CORS 拦掉 —— 而那些字节本来就是它自己那一份,拦它没有任何意义。
      'Access-Control-Allow-Origin': '*',
      // 编辑器里改一个字就要看见新的,缓存住等于「我明明改了,预览没变」。
      'Cache-Control': 'no-store',
    },
  });
}

/** 取一份资源的字节:本机读盘,别的机器经渲染层按块取。失败时直接给出该答的那个响应。 */
async function readPreviewBytes(
  registration: PreviewRegistration,
  resolved: string
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  const source = registration.source;
  if (source.kind === 'remote') {
    const result = await readRemotePreviewBytes(
      (chunk) => readRemoteChunk(source.projectId, source.workspaceId, chunk),
      resolved,
      REMOTE_PREVIEW_MAX_BYTES
    );
    if (result.ok) return result;
    log.warn('Remote preview resource unavailable', { reason: result.reason, code: result.code });
    const status = remotePreviewFailureStatus(result);
    return {
      ok: false,
      response: failurePage(
        registration.failureCopy,
        status === 403 ? 'outside' : 'unavailable',
        status,
        result.code ?? result.reason
      ),
    };
  }

  const fileSystem = workspaceFileSystem(source);
  if (!fileSystem) return { ok: false, response: notFound('workspace is gone') };

  const result = await fileSystem.readBytes(resolved, { maxBytes: MAX_PREVIEW_BYTES });
  if (!result.success) return { ok: false, response: notFound('unreadable') };
  if (result.data.truncated) {
    log.warn('Preview resource too large to serve', {
      totalSize: result.data.totalSize,
      limit: MAX_PREVIEW_BYTES,
    });
    return { ok: false, response: new Response('too large', { status: 413 }) };
  }
  return { ok: true, bytes: result.data.bytes };
}

/**
 * 别的机器上的一份资源最多取这么大 —— 与「文件」页签打开那台机器上的文件同一个硬上限。
 * 每一块都是一次跨网往返,本机那条 256MB 在这里不是一个该默认花掉的量。
 */
const REMOTE_PREVIEW_MAX_BYTES = REMOTE_WORKSPACE_MAX_FILE_BYTES;

/** 一块多久没回话就算这一块取不到(远程 SSH 的机器首次接上设备连接要握手,留足那一次)。 */
export const REMOTE_CHUNK_TIMEOUT_MS = 20_000;

/**
 * 问渲染层要一块:渲染层手里有到那台机器的连接(会话页宿主协议,远程 SSH 走 SSH、远程隧道走咕咕云),
 * 主进程这边 ❌ 另开一条到那台机器的通道。
 */
function readRemoteChunk(
  projectId: string,
  workspaceId: string,
  chunk: { path: string; offset: number; length: number }
): Promise<RemoteChunk> {
  const requestId = randomUUID();
  return new Promise<RemoteChunk>((resolve, reject) => {
    const off = events.on(remotePreviewReadResultChannel, (result) => {
      if (result.requestId !== requestId) return;
      clearTimeout(timer);
      off();
      if (result.chunk) resolve(result.chunk);
      else reject(Object.assign(new Error('remote read failed'), { code: result.errorCode ?? 'unreadable' }));
    });
    const timer = setTimeout(() => {
      off();
      reject(Object.assign(new Error('remote read timed out'), { code: 'timeout' }));
    }, REMOTE_CHUNK_TIMEOUT_MS);
    timer.unref?.();
    events.emit(remotePreviewReadChannel, { requestId, projectId, workspaceId, ...chunk });
  });
}

/**
 * 被打开的那一份文档。链接拦截只注给它 —— 页内锚点与相对资源现在归浏览器管,这段脚本
 * 只剩一件事:把「要离开这个预览」的点击交还给宿主(外链开浏览器面板、本机文件开新 tab)。
 */
function htmlResponse(html: string, registration: PreviewRegistration | DocumentPreviewRegistration): Response {
  return new Response(previewDocumentHtml(html, registration.source.kind === 'document'), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(registration.source.kind === 'document'
        ? { 'Content-Security-Policy': DOCUMENT_PREVIEW_CSP }
        : isRemotePanePreview(registration) ? { 'Content-Security-Policy': REMOTE_PANE_PREVIEW_CSP } : {}),
    },
  });
}

/**
 * #6264「文件」页签里渲染别的机器上的 HTML:这个 iframe 跑在**这台电脑**的渲染层里,页面里的
 * `http://localhost:8000` 请求会打到这台电脑自己的端口(不是那台机器)。这里没有浏览器页签那条转发,
 * 所以明文 http / ws 一律不许(localhost 只可能走这两种);要跑那台机器上的服务,在浏览器页签里开(那边经 SSH 转)。
 */
export const REMOTE_PANE_PREVIEW_CSP = [
  `default-src 'self' ${PREVIEW_SCHEME}: data: blob: https: 'unsafe-inline' 'unsafe-eval'`,
  `connect-src 'self' ${PREVIEW_SCHEME}: data: blob: https: wss:`,
  `form-action 'none'`,
].join('; ');

function isRemotePanePreview(registration: PreviewRegistration | DocumentPreviewRegistration): boolean {
  return registration.source.kind === 'remote' && registration.surface === 'pane';
}

function workspaceFileSystem(source: Extract<PreviewSource, { kind: 'local' }>): IFileSystem | null {
  const env = resolveWorkspace(source.projectId, source.workspaceId);
  return env?.fileSystem ?? null;
}

function notFound(reason: string): Response {
  return new Response(reason, { status: 404 });
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/**
 * 认得出来的按类型发,认不出来的发 `application/octet-stream`。
 * ❌ 不猜:类型猜错会让浏览器按错的方式解析,比不认识更难查。
 */
const MIME_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  wasm: 'application/wasm',
  xml: 'application/xml',
};

function mimeTypeFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
