import { registerPlugin } from '@capacitor/core';
import { platform } from '@/platform';
import { events, rpc } from '@/session/renderer/lib/ipc';
import { previewHolderOfflineChannel } from '@/session/shared/events/appEvents';
import { resolvePreviewRequest, type PreviewRoot } from '@/session/shared/preview/preview-url';
import {
  answerBesideDocument,
  chatFolderDocument,
  chatFolderPreviewCsp,
  outsideAnswer,
  unavailableAnswer,
  type ChatFolderPreviewCopy,
  type PreviewAnswer,
} from '@/session/shared/preview/chat-folder-preview';
import type { BesideDocument } from '@/session/shared/extensions/app-files-core';
import type { HtmlPreviewRegistration } from './HtmlPreviewFrame';
import { registerHtmlPreview } from './html-preview-registration';

/** The machine keeping a file the page asked for is off: which one (the page around the preview says so). */
export type BesideOffline = { machine: string; deviceId: string };

/**
 * A chat folder's HTML document, previewed with its folder (chat-folder-preview.ts): its page's relative URLs show the
 * files beside it. The desktop's `gugu-preview://` handler answers in main; the phone's WebView client asks this page,
 * which answers the same way. The web target has neither, and gives the document alone.
 */
export function chatFolderPreview(itemId: string, copy: ChatFolderPreviewCopy, onOffline: (holder: BesideOffline) => void): ((html: string) => Promise<HtmlPreviewRegistration>) | undefined {
  if (platform.kind === 'capacitor') return (html) => phonePreview(itemId, html, copy, onOffline);
  if (platform.kind !== 'electron') return undefined;
  return async (html) => {
    let previewId: string | null = null;
    const off = events.on(previewHolderOfflineChannel, (holder) => {
      if (holder.previewId === previewId) onOffline({ machine: holder.machine, deviceId: holder.deviceId });
    });
    const registration = await registerHtmlPreview(html, async (content) => {
      const created = await rpc.workspace.files.createChatFolderPreview(itemId, content, copy);
      if (created.success) previewId = created.data.previewId;
      return created;
    });
    if (!registration.ok) {
      off();
      return registration;
    }
    return { ...registration, release: () => { off(); registration.release(); } };
  };
}

// ── the phone: https://<previewId>.preview.gugu.invalid/<path>, answered here for the WebView client ──

const PHONE_DOMAIN = '.preview.gugu.invalid';

interface PreviewOriginsPlugin {
  answer(options: { requestId: string; status: number; headers: Record<string, string>; body: string | null }): Promise<void>;
}
const origins = registerPlugin<PreviewOriginsPlugin>('GuguPreviewOrigins');

interface PhonePreview {
  chatId: string;
  root: PreviewRoot;
  documentPath: string;
  html: string;
  copy: ChatFolderPreviewCopy;
  csp: string;
  onOffline: (holder: BesideOffline) => void;
  beside: Map<string, Promise<BesideDocument | null>>;
}
const phonePreviews = new Map<string, PhonePreview>();
let listening = false;

async function phonePreview(itemId: string, html: string, copy: ChatFolderPreviewCopy, onOffline: (holder: BesideOffline) => void): Promise<HtmlPreviewRegistration> {
  const { chatDocumentPlace } = await import('../appSlot/phoneAppHost');
  const place = await chatDocumentPlace(itemId);
  if (!place) return { ok: false, message: copy.unavailable };
  if (!listening) {
    listening = true;
    window.addEventListener('guguPreviewRequest', (event) => void answerPhone(event as unknown as PhoneRequest));
  }
  const segments = place.path.split('/').filter(Boolean);
  const previewId = crypto.randomUUID().replace(/-/g, '');
  const origin = `https://${previewId}${PHONE_DOMAIN}`;
  const documentPath = '/' + segments.join('/');
  phonePreviews.set(previewId, {
    chatId: place.chatId,
    root: { kind: 'workspace', prefix: '/', segments: segments.slice(0, -1) },
    documentPath,
    html,
    copy,
    csp: chatFolderPreviewCsp(origin),
    onOffline,
    beside: new Map(),
  });
  const url = `${origin}/${encodeURIComponent(segments.at(-1) ?? '')}`;
  let revision = 0;
  return {
    ok: true,
    url: `${url}?r=0`,
    update: async (next) => {
      const preview = phonePreviews.get(previewId);
      if (preview) preview.html = next;
      return `${url}?r=${++revision}`;
    },
    release: () => {
      const preview = phonePreviews.get(previewId);
      phonePreviews.delete(previewId);
      for (const pending of preview?.beside.values() ?? []) void pending.then((found) => (found?.kind === 'file' ? found.file.dispose() : undefined)).catch(() => undefined);
    },
  };
}

/** What the WebView client asks (GuguPreviewOrigins.java): one request of a preview origin. */
type PhoneRequest = { requestId: string; previewId: string; resource: string; range: string | null };

async function answerPhone(request: PhoneRequest): Promise<void> {
  const answer = await answerFor(request).catch((): PreviewAnswer => ({ status: 500, headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode('error') }));
  let body: string | null = null;
  if (answer.body) {
    let binary = '';
    for (let i = 0; i < answer.body.length; i += 0x8000) binary += String.fromCharCode(...answer.body.subarray(i, i + 0x8000));
    body = btoa(binary);
  }
  await origins.answer({ requestId: request.requestId, status: answer.status, headers: answer.headers, body });
}

async function answerFor(request: PhoneRequest): Promise<PreviewAnswer> {
  const preview = phonePreviews.get(request.previewId);
  if (!preview) return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode('unknown preview') };
  const resolved = resolvePreviewRequest(preview.root, request.resource);
  if (!resolved) return outsideAnswer(preview.copy);
  if (resolved === preview.documentPath) return chatFolderDocument(preview.html, preview.csp);
  const path = resolved.replace(/^\/+/, '');
  let pending = preview.beside.get(path);
  if (!pending) {
    const { besideChatDocument } = await import('../appSlot/phoneAppHost');
    pending = besideChatDocument(preview.chatId, path);
    preview.beside.set(path, pending);
  }
  try {
    const found = await pending;
    if (found?.kind !== 'file') preview.beside.delete(path);
    // The whole file, never a piece: the WebView applies a range to an intercepted response itself (GuguPreviewOrigins.java).
    const answer = await answerBesideDocument(found, { path, range: null, copy: preview.copy, csp: preview.csp });
    if (answer.offline) preview.onOffline(answer.offline);
    return answer;
  } catch {
    preview.beside.delete(path);
    return unavailableAnswer(preview.copy, 'unreadable');
  }
}
