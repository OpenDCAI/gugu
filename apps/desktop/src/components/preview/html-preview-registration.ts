import { rpc } from '@/session/renderer/lib/ipc';
import type { HtmlPreviewRegistration } from './HtmlPreviewFrame';

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
