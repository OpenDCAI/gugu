import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
} from '@renderer/features/sessions/session-view-context';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { ModelStatusOverlay } from '@renderer/lib/monaco/model-status-overlay';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { useModelStatus } from '@renderer/lib/monaco/use-model';
import { PREVIEW_LINK_MESSAGE_TYPE, toExternalUrl } from '@shared/preview/preview-link-script';
import { resolveWorkspaceResourcePath } from './workspace-resource-path';
import { openBrowserUrlExternally } from '@renderer/features/browser/browser-toolbar-actions';
import {
  workspaceBackend,
  workspaceEvents,
  workspaceRpc,
} from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { touchesPageAssets } from './page-assets';

interface HtmlRendererProps {
  tab: FileTabResource;
}

/**
 * 把一份 HTML 渲染在沙箱 iframe 里。源码/预览的切换在上层容器 FileContent 里。
 *
 * 预览由 `gugu-preview://` 供给(#6156),**不再把整页字符串塞进 `srcdoc`**。差别不是实现口味:
 * `srcdoc` 的文档没有自己的地址,于是相对资源得由渲染层逐类手工内联(CSS / JS / img / srcset /
 * CSS 里的 url(...)),而音视频、iframe、`@import` 内联不了只能在预览上方挂一条「没能内联」的
 * 提示;页内锚点更糟 —— `#x` 按宿主页的地址解析,点一下就把 iframe 整个导走,预览变白。
 *
 * 给了它一个真地址之后,上面每一样都回到浏览器自己手里,这个文件因此从 220 行掉到 100 行出头,
 * 连带删掉 300 行内联器与 200 行单测。⇒ 少写的代码不是目标,**不必再把浏览器已经实现好的
 * URL 解析重写一遍**才是。
 */
export const HtmlRenderer = observer(function HtmlRenderer({ tab }: HtmlRendererProps) {
  const uri = tab.bufferUri;
  const status = useModelStatus(uri);

  // Touch bufferVersions so this observer re-renders when the model is first
  // populated — otherwise the preview can stick on stale content.
  void modelRegistry.bufferVersions.get(uri);
  const content = status === 'ready' ? (modelRegistry.getText(uri) ?? '') : '';

  // A file that could not be read is not an empty page — say which one it is,
  // the way the CSV and SVG previews do.
  if (status !== 'ready') {
    return (
      <div className="relative h-full w-full bg-background-secondary-1">
        <ModelStatusOverlay status={status} />
      </div>
    );
  }
  return <HtmlContentRenderer filePath={tab.path} rawContent={content} />;
});

interface HtmlContentRendererProps {
  filePath: string;
  rawContent: string;
}

/**
 * 会话工作区里的一份 HTML:登记走预览协议(别的机器上的,字节经那台机器取),页面里要离开预览的点击开这条会话的浏览器 / 文件页签。
 * 页面引用的文件(同目录的样式、脚本、图片)在盘上变了就重载一次 —— agent 改完 CSS 页面自己跟着变(本机与别的机器同一条)。
 */
export const HtmlContentRenderer = observer(function HtmlContentRenderer({
  filePath,
  rawContent,
}: HtmlContentRendererProps) {
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspacePath = useWorkspace().path;
  const { pane } = usePaneContext();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(
    () =>
      workspaceEvents.on(fileChangesChannel, ({ workspaceId: changedWorkspace, update }) => {
        if (changedWorkspace !== workspaceId) return;
        if (update.kind === 'resync' || touchesPageAssets(filePath, update.changes.map((change) => change.path))) {
          setReloadKey((n) => n + 1);
        }
      }),
    [workspaceId, filePath]
  );

  const register = useCallback(
    async (documentHtml: string): Promise<HtmlPreviewRegistration> => {
      const result = await workspaceRpc(projectId).files.createPreview(projectId, workspaceId, filePath, documentHtml);
      if (result.success) return { ok: true, ...result.data };
      return { ok: false, message: 'message' in result.error ? result.error.message : 'Preview unavailable' };
    },
    [projectId, workspaceId, filePath]
  );

  const onLink = useCallback(
    (href: string) => {
      // 外链走浏览器面板 —— 沙箱 iframe 自己导航不了,不接就是点了没反应(#5814)。
      const externalUrl = toExternalUrl(href);
      if (externalUrl) {
        // 会话所在的机器没有浏览器格(只经云端连着的机器):开这台电脑的系统浏览器。
        if (workspaceBackend(projectId).browser.available) pane.open('browser', { initialUrl: externalUrl });
        else openBrowserUrlExternally(externalUrl);
        return;
      }
      const target = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: filePath,
        resourcePath: href,
      });
      if (!target) return;
      // 任何本机文件都开 —— 标签页自己会挑渲染器(图片/PDF/CSV/文本)。
      pane.open('file', { path: target, preview: false });
    },
    [filePath, workspacePath, pane, projectId]
  );

  return (
    <HtmlPreviewFrame
      fileName={filePath.split('/').pop() ?? filePath}
      rawContent={rawContent}
      register={register}
      onLink={onLink}
      reloadKey={reloadKey}
    />
  );
});

/** 登记一次预览的结果:拿到地址,或一句「起不来」的原因(画在预览位置上)。 */
export type HtmlPreviewRegistration =
  | { ok: true; url: string; previewId: string }
  | { ok: false; message: string };

interface HtmlPreviewFrameProps {
  fileName: string;
  rawContent: string;
  /**
   * 登记这份文档的预览(带登记那一刻的正文)。**它的身份变了才重新登记** —— 调用方用 useCallback
   * 按「哪个文件」记住它;正文变了不重登记,只推新正文(见下)。
   */
  register: (documentHtml: string) => Promise<HtmlPreviewRegistration>;
  /** 页面里要离开这个预览的点击(注入脚本 postMessage 过来的 href)。 */
  onLink: (href: string) => void;
  /**
   * 变了就重载一次(#6264 别的机器上:同一目录里存了别的文件 / agent 一轮干完改了东西 —— 旁边的样式、脚本
   * 只有磁盘那一份,文档正文没变也要重取)。不给 = 只跟着正文走。
   */
  reloadKey?: number;
}

/**
 * 预览本体:本机与 #6264 别的机器上的「文件」页签共用 —— 两边只差「登记走哪条」「链接开到哪」,
 * 这两样由调用方注入;地址、沙箱、改字即见、链接拦截只写这一份。
 */
export function HtmlPreviewFrame({ fileName, rawContent, register, onLink, reloadKey }: HtmlPreviewFrameProps) {
  const [preview, setPreview] = useState<{ url: string; previewId: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // 登记时带的是**登记那一刻**的正文,所以这里要一份不随 effect 依赖走的引用。
  const rawContentRef = useRef(rawContent);
  rawContentRef.current = rawContent;
  /** 登记时已经发过去的那一份 —— 用它把「第一次加载」和「改了字」分开,别白重载一次。 */
  const registeredContentRef = useRef<string | null>(null);
  /** 登记没起来之后,`reloadKey` 再变(那台机器回来了 / 文件变了)就重新登记一次。 */
  const [attempt, setAttempt] = useState(0);

  // 登记表在主进程里(本机与别的机器上的预览同一张,`gugu-preview://` 按登记取字节),所以撤登记 /
  // 推新正文直接问主进程,❌ 按机器分。
  // 一个 tab 一次登记。正文改了不重开登记,只把新正文推过去(见下一个 effect)——
  // 重开会换掉 id,而 id 就是这个页面的 origin,换源等于把它存的东西清空。
  useEffect(() => {
    let cancelled = false;
    let registered: string | null = null;
    setPreview(null);
    setFailed(null);
    void (async () => {
      const result = await register(rawContentRef.current);
      if (cancelled) {
        if (result.ok) void rpc.workspace.files.releasePreview(result.previewId);
        return;
      }
      if (!result.ok) {
        // 预览起不来要说是哪一条起不来,❌ 别画一张白页让人以为文件是空的。
        setFailed(result.message);
        return;
      }
      registered = result.previewId;
      registeredContentRef.current = rawContentRef.current;
      setPreview({ url: result.url, previewId: result.previewId });
    })();
    return () => {
      cancelled = true;
      if (registered) void rpc.workspace.files.releasePreview(registered);
    };
  }, [register, attempt]);

  // 预览看的是**编辑器缓冲区**,不是磁盘那一份:改一个字、切到预览就该看见,不必先保存。
  // 正文推过去之后给 iframe 换一个 cache-busting 的查询串把它逼着重取 —— 查询串不参与
  // 路径解析,所以页面里的相对资源与锚点一个都不受影响。
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!preview) return;
    // 登记时那一份已经发过去了,这里不重复推一遍 —— 否则每次打开预览都要白加载两次。
    if (registeredContentRef.current === rawContent) return;
    let cancelled = false;
    void rpc.workspace.files.setPreviewDocument(preview.previewId, rawContent).then(() => {
      if (cancelled) return;
      registeredContentRef.current = rawContent;
      setRevision((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [preview, rawContent]);

  const seenReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (seenReloadKey.current === reloadKey) return;
    seenReloadKey.current = reloadKey;
    // 上次没登记上(别的机器上的页面:那台机器一时没应答):重新登记,❌ 一直停在那句失败上。
    if (failed) setAttempt((n) => n + 1);
    else setRevision((n) => n + 1);
  }, [reloadKey, failed]);

  // 页面里要离开这个预览的点击由注入脚本 postMessage 过来,交给调用方决定开到哪去。
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; href?: string } | null;
      if (!data || data.type !== PREVIEW_LINK_MESSAGE_TYPE || typeof data.href !== 'string') return;
      onLink(data.href);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onLink]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background-secondary-1 px-6 text-center text-xs text-foreground-passive">
        {failed}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background-secondary-1">
      {preview ? (
        <iframe
          ref={iframeRef}
          title={fileName}
          src={`${preview.url}?r=${revision}`}
          // allow-scripts:让页面自己的脚本与那段链接拦截跑起来。
          // 仍然不给 allow-same-origin —— 这一条与地址是两回事:**地址决定 URL 怎么解析,
          // 源决定它能读到什么**。有了地址,锚点和相对路径已经对了;不给同源,它就读不到自己
          // 这个 origin 下的存储、也发不出同源请求。两样都要。
          sandbox="allow-scripts"
          className="w-full min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className="flex h-full items-center justify-center">
          <LoadingIndicator ariaLabel={translateSessionMessage('task.loading')} />
        </div>
      )}
    </div>
  );
}
