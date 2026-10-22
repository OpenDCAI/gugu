import { rpc } from '@/session/renderer/lib/ipc';
import type { HtmlPreviewRegistration } from './HtmlPreviewFrame';
import { previewDocumentHtml } from '@/session/shared/preview/preview-link-script';

/** 地址、更新与撤销来自同一次登记,frame 不再依赖桌面 RPC。 */
export function createProtocolPreview({ url, previewId }: { url: string; previewId: string }): HtmlPreviewRegistration {
  let revision = 0;
  return {
    ok: true,
    url: `${url}?r=0`,
    update: async (html) => {
      const result = await rpc.workspace.files.setPreviewDocument(previewId, html);
      if (!result.success) throw new Error('Preview unavailable');
      return `${url}?r=${++revision}`;
    },
    release: () => { void rpc.workspace.files.releasePreview(previewId); },
  };
}

/** 手机和网页没有本机协议 handler,只在当前页面持有正文 Blob。 */
export function createBlobPreview(html: string): HtmlPreviewRegistration {
  let url = URL.createObjectURL(new Blob([previewDocumentHtml(html, true)], { type: 'text/html' }));
  return {
    ok: true,
    url,
    update: async (content) => {
      URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([previewDocumentHtml(content, true)], { type: 'text/html' }));
      return url;
    },
    release: () => URL.revokeObjectURL(url),
  };
}

export async function registerDocumentPreview(html: string): Promise<HtmlPreviewRegistration> {
  if (!window.electronAPI) return createBlobPreview(html);
  const result = await rpc.workspace.files.createDocumentPreview(html);
  if (result.success) return createProtocolPreview(result.data);
  return { ok: false, message: 'message' in result.error ? result.error.message : 'Preview unavailable' };
}
