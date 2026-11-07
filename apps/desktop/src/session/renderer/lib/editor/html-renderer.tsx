import { observer } from 'mobx-react-lite';
import { useCallback } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame';
import { registerHtmlPreview } from '@/components/preview/html-preview-registration';
import { toExternalUrl } from '@shared/preview/preview-link-script';
import { resolveWorkspaceResourcePath } from './workspace-resource-path';
import { openBrowserUrlExternally } from '@renderer/features/browser/browser-toolbar-actions';
import {
  workspaceBackend,
  workspaceEvents,
  workspaceRpc,
} from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';

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
  const surface = useWorkspaceSurface();
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
      surface.openFile(target);
    },
    [filePath, workspacePath, pane, projectId, surface]
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
