import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { ResolvedTab, TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceBackend } from '../workspace-backend/workspace-backend';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { FILE_TREE_MIN_SIZE } from '@renderer/features/sessions/editor/file-tree-split';
import { EditorFileTree } from './editor-file-tree';
import { EditorProvider } from './editor-provider';
import { FileContentPreview } from './file-content-preview';
import { FileContentRenderer } from './file-content-renderer';
import { FileContentToolbar } from './file-content-toolbar';
import { FILE_CONTENT_TYPES } from './file-content-types';
import type { FileTabResource } from './stores/file-tab-resource';
import { RetainedTabContent, useRetainedTabs } from '@renderer/features/tabs/retained-tab-content';

/**
 * Mounts EditorProvider unconditionally so the Monaco instance persists across
 * tab switches. The Monaco host is overlaid and visibility-toggled rather than
 * unmounted, so cursor position and scroll survive kind transitions.
 */
export const TabContent = observer(function FileTabContent({ host, ctx }: TabContentProps) {
  return (
    <EditorProvider>
      <FileContent host={host} ctx={ctx} />
    </EditorProvider>
  );
});

function showsPreview(file: FileTabResource): boolean {
  const def = FILE_CONTENT_TYPES[file.contentType];
  return def ? !!def.Preview && (file.viewMode === 'preview' || !def.editable) : false;
}

/**
 * Renders the Monaco source and/or preview for the active file tab.
 *
 * 最近看过的预览挂着,切走只藏起来 —— 浏览到一半的 HTML 切回来还在原处,❌ 重新登记、重新加载、
 * 滚动归零。与其他页签共用保留上限:再早看过的释放,切回去重新加载。
 * 关掉页签或切回源码也释放。恢复出来还没看过的不挂:别一开会话就把每个页签的页面都加载一遍。
 *
 * 别的种类的页签在前面时(这一层被 PaneContent 藏着)版面照常摆:工具栏、文件树都在,藏着的
 * 预览尺寸不变,切回来页面不重排。工具栏对哪个文件都一样高,所以拿哪个开着的文件撑都行。
 */
const FileContent = observer(function FileContent({ host, ctx }: TabContentProps) {
  const [treeVisible, setTreeVisible] = useState(false);
  const fileTabs = host.resolvedTabs.filter(
    (t): t is ResolvedTab<FileTabResource> => t.kind === 'file'
  );
  const activeFile = fileTabs.find((t) => t.isActive)?.resource ?? null;
  const file = activeFile ?? fileTabs[0]?.resource ?? null;

  const activePreview = activeFile && showsPreview(activeFile) ? activeFile : null;
  const previewTabs = fileTabs.filter((t) => showsPreview(t.resource));
  const retained = useRetainedTabs(previewTabs.map((t) => t.tabId), previewTabs.filter((t) => t.isActive).map((t) => t.tabId));
  const previews = previewTabs.filter((t) => retained.has(t.tabId));

  if (!file) return null;
  const bufferUri = file.isExternal ? '' : file.bufferUri;

  const def = FILE_CONTENT_TYPES[file.contentType];
  // 源码层与预览层都只在文件这一种在前面时才可能 visible:子层写死的 visible 会透过 PaneContent 那层 hidden 画出来。
  const showSource =
    file === activeFile && def ? def.editable && (file.viewMode === 'source' || !def.Preview) : false;
  const canToggle = def ? def.editable && !!def.Preview : false;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <FileContentToolbar
        tab={file}
        canToggle={canToggle}
        treeVisible={treeVisible}
        onTreeVisibleChange={setTreeVisible}
      />
      {bufferUri ? <FileDeletedNotice bufferUri={bufferUri} projectId={(ctx as SessionTabContext).projectId} /> : null}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="file-tab-content" minSize="140px" className="relative min-w-0 overflow-hidden">
          <RetainedTabContent
            className="absolute inset-0"
            visible={showSource}
          >
            <FileContentRenderer />
          </RetainedTabContent>
          {previews.map((t) => {
            const visible = t.resource === activePreview;
            return (
              <RetainedTabContent
                key={t.tabId}
                className="absolute inset-0"
                visible={visible}
              >
                <FileContentPreview tab={t.resource} ctx={ctx as SessionTabContext} />
              </RetainedTabContent>
            );
          })}
        </ResizablePanel>
        {treeVisible ? (
          <>
            {/* 真把手,❌ 别退回一条 `border-l`:那根线看着就是分割线,owner 实机拿它当分割线拖过
                (「这个线还是无法拖拽」)—— 一个长得像控件却不响应的边框,就是「假控件」。
                宽度用 px 而不是百分比:文件树好不好用取决于「够不够放下文件名」,跟面板占屏幕多少无关,
                用百分比的话分栏一变就把它挤没。
                ⚠️ 两边的 minSize 之和必须**明显小于**工作区面板可能的宽度。第一版写的是 200+180,
                而面板窄到 370 时 200+180+1 已经超总宽 —— 两边同时顶在下限,把手在、却一格也拖不动
                (实测拖 60px 宽度纹丝不动)。「有把手」不等于「拖得动」,判据要量宽度真的变了。
                树的下限用 file-tree-split.ts 的 FILE_TREE_MIN_SIZE —— #4134 给草稿面板定的同一个
                数(「再窄就只剩缩进,看不见文件名」),两个界面同一条约束就该同一个常量。
                content 那侧的 140px 是**正文**的下限,是另一回事,不并进去。 */}
            <ResizableHandle />
            <ResizablePanel
              id="file-tab-tree"
             
              defaultSize="240px"
              minSize={FILE_TREE_MIN_SIZE}
              maxSize="480px"
              className="border-l border-border bg-background"
            >
              <EditorFileTree />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
});

/**
 * 盘上这份文件被删了:页签顶上一句话(正文留着,存一下就重新建出来)。会话在别的机器上时,「盘上」说成那台机器。
 * 盘上变了而你还有没存的修改,不再有话要说:盘上的改动并进缓冲区,两边都留(F91)。
 */
const FileDeletedNotice = observer(function FileDeletedNotice({ bufferUri, projectId }: { bufferUri: string; projectId: string }) {
  const { translate } = useSessionMessages();
  if (!modelRegistry.deletedOnDisk.has(bufferUri)) return null;
  const machine = workspaceBackend(projectId).machine;
  return (
    <p className="m-0 shrink-0 border-b border-border px-3 py-2 text-xs text-foreground-muted" data-testid="file-deleted-on-disk">
      {machine.kind === 'remote' ? translate('file.deletedOn', { device: machine.label() }) : translate('file.deletedOnDisk')}
    </p>
  );
});
