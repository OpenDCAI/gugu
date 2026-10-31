import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
} from '@renderer/features/sessions/session-view-context';
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame';
import { registerHtmlPreview } from '@/components/preview/html-preview-registration';
import { ModelStatusOverlay } from '@renderer/lib/monaco/model-status-overlay';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { useModelStatus } from '@renderer/lib/monaco/use-model';
import { toExternalUrl } from '@shared/preview/preview-link-script';
import { resolveWorkspaceResourcePath } from './workspace-resource-path';
import { openBrowserUrlExternally } from '@renderer/features/browser/browser-toolbar-actions';
import {
  workspaceBackend,
  workspaceEvents,
  workspaceRpc,
} from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';

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
  return <HtmlContentRenderer filePath={tab.path} rawContent={content} scrollPosition={tab.htmlPreviewScroll} />;
});

interface HtmlContentRendererProps {
  filePath: string;
  rawContent: string;
  scrollPosition?: { x: number; y: number };
}

/**
 * 会话工作区里的一份 HTML:登记走预览协议(别的机器上的,字节经那台机器取),页面里要离开预览的点击开这条会话的浏览器 / 文件页签。
 * 工作区变化交给登记表核实际取过的资源;本机与别的机器同一条,不按目录猜依赖。
 */
export const HtmlContentRenderer = observer(function HtmlContentRenderer({
  filePath,
  rawContent,
  scrollPosition,
}: HtmlContentRendererProps) {
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspacePath = useWorkspace().path;
  const { pane } = usePaneContext();
  const subscribeChanges = useCallback(
    (changed: (paths?: readonly string[]) => void) =>
      workspaceEvents.on(fileChangesChannel, ({ workspaceId: changedWorkspace, update }) => {
        if (changedWorkspace !== workspaceId) return;
        changed(update.kind === 'resync' ? undefined : update.changes.map((change) => change.path));
      }),
    [workspaceId]
  );

  const register = useCallback(
    (documentHtml: string): Promise<HtmlPreviewRegistration> => registerHtmlPreview(documentHtml, (content) =>
      workspaceRpc(projectId).files.createPreview(projectId, workspaceId, filePath, content)),
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
      subscribeChanges={subscribeChanges}
      scrollPosition={scrollPosition}
    />
  );
});
