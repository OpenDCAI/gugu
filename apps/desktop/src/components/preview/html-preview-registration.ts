import { rpc } from '@/session/renderer/lib/ipc';
import type { HtmlPreviewRegistration } from './HtmlPreviewFrame';
import { previewDocumentHtml } from '@/session/shared/preview/preview-link-script';
import { platform } from '@/platform';

/** 平台只决定如何供给正文。调用方可提供文件登记,默认是没有目录权限的群正文。 */
export async function registerHtmlPreview(
  html: string,
  register: (html: string) => ReturnType<typeof rpc.workspace.files.createPreview> = (content) => rpc.workspace.files.createDocumentPreview(content),
): Promise<HtmlPreviewRegistration> {
  if (platform.kind !== 'electron') {
    // 网页/手机只供正文;Blob URL 不提供目录资源,与原群预览的能力范围一致。
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
  const result = await register(html);
  if (!result.success) return { ok: false, message: 'message' in result.error ? result.error.message : 'Preview unavailable' };
  const { url, previewId } = result.data;
  let revision = 0;
  return {
    ok: true,
    url: `${url}?r=0`,
    update: async (html) => {
      await rpc.workspace.files.setPreviewDocument(previewId, html);
      return `${url}?r=${++revision}`;
    },
    release: () => { void rpc.workspace.files.releasePreview(previewId); },
  };
}
