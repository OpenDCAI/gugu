/**
 * A document in a chat's folder, previewed with its folder: the answer to one request its page makes for a file beside it.
 *
 * The page's address is the document's path in the folder (`<origin>/<path>`), so `shots/a.png` — or a `<video>`'s byte
 * range — asks for the file beside it, and the fence is the one every preview has (`resolvePreviewRequest`, rooted at the
 * document's own folder). The file is found by its path in that chat's folder as the signed-in person
 * (`AppFiles.besideDocument`) and read through the one file resolver. Who carries the request differs — the desktop's
 * `gugu-preview://` handler in main, the phone's WebView client asking this page — and the answer is the same: this one.
 */
import type { BesideDocument } from '../extensions/app-files-core';
import { previewDocumentHtml } from './preview-link-script';

/** A request's answer, platform-neutral: the desktop makes it a `Response`, the phone hands it to its WebView client. */
export interface PreviewAnswer {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
  /** The machine that keeps the file is off: the page around the preview says which one, and reads again when it is back. */
  offline?: { machine: string; deviceId: string };
}

/**
 * What the person sees when a file cannot be had: copy the window wrote in its language (`{machine}` is filled in here),
 * and the theme's colours for a picture drawn in a file's place — an image in the page cannot read the window's CSS.
 */
export type ChatFolderPreviewCopy = {
  unavailable: string;
  outside: string;
  offline: string;
  palette: { surface: string; border: string; text: string };
};

/** One answer to a `Range` at most this long: a video plays while its next piece is asked for. */
export const BESIDE_RANGE_BYTES = 4 * 1024 * 1024;
/** A whole file (no `Range`) past this is refused rather than cut: half a stylesheet breaks a page with no word said. */
export const BESIDE_MAX_BYTES = 256 * 1024 * 1024;
/** One read of the resolver's (`FILE_CHUNK_BYTES`). */
const READ_BYTES = 512 * 1024;

/**
 * The page's policy: the group document's (no local file, no plain http, no form posts, no `<base>`) plus its own origin
 * — the files beside it, each answer fenced to the document's folder. `origin` is how the platform names that origin.
 */
export function chatFolderPreviewCsp(origin: string): string {
  return [
    `default-src 'self' ${origin} data: blob: https: 'unsafe-inline' 'unsafe-eval'`,
    `connect-src 'self' ${origin} https: wss:`,
    `form-action 'none'`,
    `base-uri 'none'`,
  ].join('; ');
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` over a file of `size`; one range only (what media elements ask). */
export function byteRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size === 0) return 'unsatisfiable';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    return suffix === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function headers(contentType: string, length: number, csp?: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    // The page runs sandboxed (an opaque origin): its own module scripts and fonts come with `Origin: null`.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...(csp ? { 'Content-Security-Policy': csp } : {}),
  };
}

function text(status: number, message: string, reason: string): PreviewAnswer {
  const body = new TextEncoder().encode(message);
  return { status, headers: { ...headers('text/plain; charset=utf-8', body.byteLength), 'X-Gugu-Preview-Failure': reason }, body };
}

/** The page itself (the document, or another page beside it): its link script, under the folder's policy. */
export function chatFolderDocument(html: string, csp: string): PreviewAnswer {
  const body = new TextEncoder().encode(previewDocumentHtml(html));
  return { status: 200, headers: headers('text/html; charset=utf-8', body.byteLength, csp), body };
}

/** A request the fence turned away: above the document's folder. */
export function outsideAnswer(copy: ChatFolderPreviewCopy): PreviewAnswer {
  return text(403, copy.outside, 'outside_root');
}

/** A file that could not be read (the resolver or the network failed): said, never a blank. */
export function unavailableAnswer(copy: ChatFolderPreviewCopy, reason: string): PreviewAnswer {
  return text(404, copy.unavailable, reason);
}

/**
 * The answer for one file beside the document: found (`BesideDocument`) or not (null). A picture whose machine is off is
 * drawn where it would be, saying so; anything else that machine keeps answers 503 with the same words.
 */
export async function answerBesideDocument(
  found: BesideDocument | null,
  request: { path: string; range?: string | null; copy: ChatFolderPreviewCopy; csp: string }
): Promise<PreviewAnswer> {
  if (!found) return text(404, request.copy.unavailable, 'not_found');
  if (found.kind === 'offline') {
    const said = request.copy.offline.replace('{machine}', found.machine || '?');
    const offline = { machine: found.machine, deviceId: found.deviceId };
    if (!PICTURE.test(request.path)) return { ...text(503, said, 'holder_offline'), offline };
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">' +
        `<rect x="0.5" y="0.5" width="319" height="119" rx="8" fill="${escapeXml(request.copy.palette.surface)}" stroke="${escapeXml(request.copy.palette.border)}" stroke-dasharray="4 3"/>` +
        `<text x="160" y="64" text-anchor="middle" font-family="sans-serif" font-size="14" fill="${escapeXml(request.copy.palette.text)}">${escapeXml(said)}</text></svg>`,
    );
    return { status: 200, headers: { ...headers('image/svg+xml', svg.byteLength), 'X-Gugu-Preview-Failure': 'holder_offline' }, body: svg, offline };
  }
  if (found.kind === 'text') {
    if (found.contentType.startsWith('text/html')) return chatFolderDocument(found.text, request.csp);
    const body = new TextEncoder().encode(found.text);
    return { status: 200, headers: headers(found.contentType, body.byteLength), body };
  }
  const { file } = found;
  const size = file.revision.size_bytes;
  const contentType = file.revision.content_type;
  const wanted = byteRange(request.range, size);
  if (wanted === 'unsatisfiable') {
    return { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Access-Control-Allow-Origin': '*' }, body: null };
  }
  if (!wanted && size > BESIDE_MAX_BYTES) return text(413, request.copy.unavailable, 'too_large');
  const start = wanted?.start ?? 0;
  const end = wanted ? Math.min(wanted.end, start + BESIDE_RANGE_BYTES - 1) : size - 1;
  const body = new Uint8Array(end - start + 1);
  for (let offset = start; offset <= end; ) {
    const piece = await file.read(offset, Math.min(READ_BYTES, end - offset + 1));
    if (piece.byteLength === 0) break;
    body.set(piece, offset - start);
    offset += piece.byteLength;
  }
  if (contentType.startsWith('text/html')) return chatFolderDocument(new TextDecoder().decode(body), request.csp);
  const answered = headers(contentType, body.byteLength);
  return wanted
    ? { status: 206, headers: { ...answered, 'Content-Range': `bytes ${start}-${end}/${size}` }, body }
    : { status: 200, headers: answered, body };
}
