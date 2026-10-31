/**
 * #6264 预览里别的机器上的一份文件:按块从那台机器取回来,拼成整份字节。纯逻辑(取一块的那一问注入,单测给假的)。
 *
 * 取一块走的是会话工作区既有的读文件动词(`taskpage.workspace.read`,SSH 直连优先、云端兜底)——
 * 路径关在会话目录里、符号链接逃逸、单块上限都由那台机器核(与「文件」页签同一道边界),这里 ❌ 另写一套。
 *
 *  · 超过上限 ⇒ `too_large`(协议答 413),❌ 截断照发 —— 半截样式表进了页面,渲染错乱而零提示;
 *  · 读到一半文件变了(agent 正在写)⇒ 从头再读,两次还在变就放弃,❌ 拼出两个版本各一半的正文;
 *  · 那台机器说读不了(不存在 / 在目录外 / 没权限)⇒ 带上它的原因码,协议答 404 / 403。
 */
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';

export type RemoteChunk = { size: number; etag: string | null; data: string };

export type ReadRemoteChunk = (request: { path: string; offset: number; length: number }) => Promise<RemoteChunk>;

export type RemotePreviewBytes =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'changing' | 'unreadable'; code?: string };

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function readRemotePreviewBytes(
  read: ReadRemoteChunk,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
  attempt = 0
): Promise<RemotePreviewBytes> {
  const aborted = { ok: false as const, reason: 'unreadable' as const, code: 'aborted' };
  if (signal?.aborted) return aborted;
  let first: RemoteChunk;
  try {
    first = await read({ path, offset: 0, length: REMOTE_WORKSPACE_CHUNK_BYTES });
  } catch (error) {
    return { ok: false, reason: 'unreadable', code: errorCode(error) };
  }
  if (signal?.aborted) return aborted;
  if (first.size > maxBytes) return { ok: false, reason: 'too_large' };
  const parts: Buffer[] = [Buffer.from(first.data, 'base64')];
  let offset = parts[0]!.length;
  while (offset < first.size) {
    if (signal?.aborted) return aborted;
    let chunk: RemoteChunk;
    try {
      chunk = await read({ path, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES });
    } catch (error) {
      return { ok: false, reason: 'unreadable', code: errorCode(error) };
    }
    if (signal?.aborted) return aborted;
    if (chunk.etag !== first.etag) {
      if (attempt >= 2) return { ok: false, reason: 'changing' };
      return readRemotePreviewBytes(read, path, maxBytes, signal, attempt + 1);
    }
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.length === 0) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  return { ok: true, bytes: new Uint8Array(Buffer.concat(parts)) };
}

/** 那台机器说读不了时,协议答什么:在目录外 = 围栏在起作用(403),其余当「没有这个文件」(404)。 */
export function remotePreviewFailureStatus(result: Extract<RemotePreviewBytes, { ok: false }>): number {
  if (result.reason === 'too_large') return 413;
  if (result.reason === 'changing') return 409;
  return result.code === 'outside_workspace' ? 403 : 404;
}

/**
 * #6264 别的机器上的网页在浏览器页签里整页加载:没写 `<meta charset>` 的页面,Chromium 不会替它猜成 UTF-8,
 * 中文成了乱码(实测)。字节本身是合法 UTF-8 的文本就标上 —— 不是合法 UTF-8(GBK 之类)就不标,交给页面自己的声明。
 */
export function withUtf8Charset(mimeType: string, bytes: Uint8Array): string {
  if (!mimeType.startsWith('text/') && mimeType !== 'image/svg+xml') return mimeType;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return `${mimeType}; charset=utf-8`;
  } catch {
    return mimeType;
  }
}
