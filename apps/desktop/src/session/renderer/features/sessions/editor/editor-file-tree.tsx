import { safeFailureLine } from '../gugu-reason';
import { log } from '@renderer/utils/logger';
// 会话工作区的文件树 —— 一棵,不管会话在哪台机器上(#6264:别的机器上的会话同一棵树,数据经工作区后端来)。
// 动作照 VS Code 资源管理器:新建文件 / 新建文件夹(行内输入框)、重命名(行内,F2)、删除(Delete / ⌘⌫)、
// 复制内容 / 路径 / 相对路径、在访达中显示(只有这台电脑上的)、从访达拖进来;别的机器上的还有「下载…」「上传文件…」,
// 删除先放那台机器的回收站。按机器不同的那一半在 workspace-tree-backend。
import { detectPlatform } from '@tanstack/react-hotkeys';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link,
  Pencil,
  RefreshCw,
  Search,
  SquareMinus,
  Trash2,
} from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useEffect, useRef, useState } from 'react';
import { CompactedPathLabel } from '@renderer/features/sessions/editor/compacted-path-label';
import type { FilesStore } from '@renderer/features/sessions/editor/stores/files-store';
import {
  buildFileTreeVisibleRows,
  isChainExpanded,
  isExpandableFileTreeNode,
  isOpenableFileTreeNode,
  type RenderableFileNode,
  type TreeRow,
} from '@renderer/features/sessions/file-tree/tree-utils';
import { filePathKey, relativeToWorkspace } from '@renderer/features/sessions/stores/workspace-path';
import { useTabSelection } from '@renderer/features/sessions/session-tab-registry';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { workspaceBackend, workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import type {
  WorkspaceTransferRow,
  WorkspaceTreeBackend,
  WorkspaceTreeEntry,
  WorkspaceTreeScope,
} from '@renderer/features/sessions/workspace-backend/workspace-tree-backend';
import { clearDraggedWorkspaceFile, hasDraggedFiles, setDraggedWorkspaceFile } from '@renderer/lib/drag-files';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/lib/ui/context-menu';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { InlineAccentAction } from '@renderer/lib/ui/inline-accent-action';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { STATE_LAYERS } from '@renderer/lib/ui/state-layers';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { formatBytes } from '@renderer/utils/formatBytes';
import { cn } from '@renderer/utils/utils';
import type { FileTabResource } from './stores/file-tab-resource';

const MAX_COPY_FILE_BYTES = 10 * 1024 * 1024;
const ROW_HEIGHT = 28;

export type FileTreeOpenHandler = (path: string, preview: boolean) => void;

// 平台是稳定枚举，只在展示边界映射成本地化标签。
const PLATFORM = detectPlatform();
const REVEAL_LABEL_KEY =
  PLATFORM === 'mac' ? 'fileTree.revealFinder' : PLATFORM === 'windows' ? 'fileTree.revealExplorer' : 'fileTree.revealFileManager';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

type ResultLikeError = { message?: string; type?: string };

/** message / type 都是底层原始诊断，原样返回；两者皆无时才落到调用方给的本地化兜底。 */
function resultErrorMessage(error: ResultLikeError, unknownLabel: string): string {
  return error.message ?? error.type ?? unknownLabel;
}

/** 本地先挡掉一眼就不行的名字(落盘那一侧还会再核一次)。 */
export function localNameProblem(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed);
}

function isWithinPath(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** 行内输入框:新建(插在目标目录的第一行)或改名(就地)。`error` 每次是一个新对象:同一句错连着出两次,输入框也要重新可以回车。 */
type EditError = { message: string } | null;

type EditState =
  | { mode: 'file' | 'folder'; dir: string; error: EditError }
  | { mode: 'rename'; path: string; parent: string; name: string; error: EditError };

type DisplayRow = { kind: 'entry'; row: TreeRow<RenderableFileNode> } | { kind: 'create'; depth: number; mode: 'file' | 'folder' };

function entryOf(node: RenderableFileNode): WorkspaceTreeEntry {
  return {
    path: node.path,
    name: node.name,
    kind: isExpandableFileTreeNode(node) && node.type !== 'symlink' ? 'directory' : node.type === 'symlink' ? 'symlink' : 'file',
  };
}

/** 树里一个文件改名 / 删掉之后,开着它(或它底下)的页签:照 VS Code,改名就跟着换到新路径,删了就关掉;有没存的修改的不动。 */
function followMovedFiles(surface: ReturnType<typeof useWorkspaceSurface>, from: string, to: string | null): void {
  for (const { pane } of surface.paneLayout.groups) {
    for (const tab of pane.resolvedTabs) {
      if (tab.kind !== 'file') continue;
      const resource = tab.resource as FileTabResource;
      if (!isWithinPath(resource.path, from) || resource.isDirty) continue;
      void pane.closeTab(tab.tabId);
      if (to) pane.open('file', { path: to + resource.path.slice(from.length) }, { preview: false });
    }
  }
}

/** 树里需要的那几样(会话、工作区、后端)一次取齐。 */
function useTreeContext() {
  const surface = useWorkspaceSurface();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace();
  const backend = workspaceBackend(projectId);
  const scope: WorkspaceTreeScope = { projectId, workspaceId, rootPath: workspace.path, files: surface.editorView.files };
  const device = backend.machine.kind === 'remote' ? backend.machine.label() : null;
  return { surface, projectId, workspaceId, workspace, backend, tree: backend.tree, scope, device };
}

type TreeContext = ReturnType<typeof useTreeContext>;

/**
 * 删除:这台电脑上问一句就删;别的机器上先问一句「移到那台机器的回收站」,那台机器放不进回收站(没有 / 跨了盘 / Windows)
 * 再问一次「永久删除」(照 VS Code 本机「回收站失败,要永久删除吗」;远端 VS Code 一律只有永久删除,vscode#108731)。
 */
function confirmDelete(ctx: TreeContext, node: RenderableFileNode, translate: Translate): void {
  const entry = entryOf(node);
  const folder = entry.kind === 'directory';
  const title = translate(folder ? 'fileTree.deleteFolderTitle' : entry.kind === 'symlink' ? 'fileTree.deleteLinkTitle' : 'fileTree.deleteFileTitle');
  const parent = node.parentPath ?? ctx.workspace.path;
  const run = async (mode: 'trash' | 'permanent') => {
    const result = await ctx.tree.remove(ctx.scope, entry, mode);
    if (result.ok) {
      followMovedFiles(ctx.surface, node.path, null);
      ctx.scope.files?.removeNode(node.path);
      await ctx.scope.files?.registerDir(parent, true);
      toast({
        title:
          result.value.mode === 'trash' && ctx.device
            ? translate('remoteFiles.movedToTrash', { device: ctx.device })
            : translate(folder ? 'fileTree.folderDeleted' : entry.kind === 'symlink' ? 'fileTree.linkDeleted' : 'fileTree.fileDeleted'),
        tier: 'success',
      });
      return;
    }
    if (mode === 'trash' && result.failure.code === 'trash_unavailable') {
      showModal('confirmActionModal', {
        title: translate('remoteFiles.permanentTitle'),
        description: translate('remoteFiles.permanentDescription', { device: ctx.device ?? '', path: node.path }),
        confirmLabel: translate('remoteFiles.deletePermanently'),
        variant: 'destructive',
        onSuccess: () => void run('permanent'),
      });
      return;
    }
    await ctx.scope.files?.registerDir(parent, true);
    toast({ title: translate('fileTree.deleteFailed'), description: result.failure.message || translate('fileTree.deleteFailedDetail'), tier: 'error' });
  };
  if (ctx.tree.deleteMode === 'trash') {
    showModal('confirmActionModal', {
      title,
      description: translate(folder ? 'remoteFiles.trashFolderDescription' : 'remoteFiles.trashFileDescription', {
        path: node.path,
        device: ctx.device ?? '',
      }),
      confirmLabel: translate('remoteFiles.moveToTrash'),
      variant: 'destructive',
      onSuccess: () => void run('trash'),
    });
    return;
  }
  showModal('confirmActionModal', {
    title,
    // node.path 是真实路径（数据），只作为插值穿过外壳。
    description: translate(
      folder ? 'fileTree.deleteFolderDescription' : entry.kind === 'symlink' ? 'fileTree.deleteLinkDescription' : 'fileTree.deleteFileDescription',
      { path: node.path }
    ),
    confirmLabel: translate('task.delete'),
    variant: 'destructive',
    onSuccess: () => void run('permanent'),
  });
}

/** 新建 / 改名被拒的那一句(同名已有 / 名字不行单独说)。 */
function nameFailureText(failure: { code: string; message: string }, name: string, translate: Translate): string {
  if (failure.code === 'exists') return translate('fileTree.nameTaken', { name });
  if (failure.code === 'invalid_name') return translate('fileTree.invalidName');
  return failure.message || translate('fileTree.unknownError');
}

const FileTreeRow = observer(function FileTreeRow({
  row,
  style,
  ctx,
  selected,
  renaming,
  onSelect,
  onOpenFile,
  onNew,
  onRename,
  onRenameCommit,
  onRenameCancel,
  onUpload,
}: {
  row: TreeRow<RenderableFileNode>;
  style: React.CSSProperties;
  ctx: TreeContext;
  selected: boolean;
  renaming: Extract<EditState, { mode: 'rename' }> | null;
  onSelect: () => void;
  onOpenFile?: FileTreeOpenHandler;
  onNew: (mode: 'file' | 'folder') => void;
  onRename: () => void;
  onRenameCommit: (value: string) => void;
  onRenameCancel: () => void;
  onUpload: (dir: string) => void;
}) {
  const { translate } = useSessionMessages();
  const { surface, projectId, workspaceId, workspace, tree, scope } = ctx;
  const editorView = surface.editorView;
  const files = editorView.files;
  const { isActive, open: openFile } = useTabSelection('file', filePathKey(row.node.path));

  const node = row.node;
  const isExpanded = isChainExpanded(row.chain, editorView.expandedPaths);
  const isSelected = isActive || selected;
  const relNodePath = relativeToWorkspace(workspace.path, node.path);
  const fileStatus = workspace.gitWorktree.fileChanges?.find((c) => c.path === node.path)?.status;
  const paddingLeft = row.renderDepth * 12 + 4;
  const isExpandable = isExpandableFileTreeNode(node);
  const isOpenable = isOpenableFileTreeNode(node);
  const isSymlink = node.type === 'symlink';
  const targetDirPath = isExpandable ? node.path : (node.parentPath ?? workspace.path);
  const chainPath = row.chain.length > 1 ? row.chain.map((n) => n.name).join('/') : null;
  const isHidden = row.chain.some((n) => n.isHidden);

  const toggleExpand = () => {
    // Expansion drives registration; collapse only changes visibility and keeps loaded scopes warm.
    runInAction(() => {
      if (isChainExpanded(row.chain, editorView.expandedPaths)) {
        for (const segment of row.chain) editorView.expandedPaths.delete(segment.path);
      } else {
        for (const segment of row.chain) editorView.expandedPaths.add(segment.path);
      }
    });
  };

  const open = (preview: boolean) => {
    if (onOpenFile) onOpenFile(node.path, preview);
    else openFile({ path: node.path }, { preview });
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect();
    if (isExpandable) toggleExpand();
    else if (isOpenable) open(true);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isOpenable) open(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (renaming) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isExpandable) toggleExpand();
      else if (isOpenable) open(e.key === ' ');
    }
    if (isExpandable && e.key === 'ArrowRight' && !isExpanded) toggleExpand();
    if (isExpandable && e.key === 'ArrowLeft' && isExpanded) toggleExpand();
    // 与 VS Code 资源管理器同一组键:F2 改名,Delete / ⌘⌫ 删除。
    if (e.key === 'F2') {
      e.preventDefault();
      onRename();
    }
    if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      confirmDelete(ctx, node, translate);
    }
  };

  const copyFile = async () => {
    if (!isOpenable) return;
    try {
      const result = await workspaceRpc(projectId).files.readFile(projectId, workspaceId, node.path, MAX_COPY_FILE_BYTES);
      if (!result.success) {
        toast({
          title: safeFailureLine(resultErrorMessage(result.error, translate('fileTree.unknownError'))),
          variant: 'destructive',
        });
        return;
      }
      if (result.data.truncated || result.data.binary) {
        toast({
          title: translate(result.data.binary ? 'fileTree.cantShow' : 'fileTree.fileTooLarge'),
          variant: 'destructive',
        });
        return;
      }
      await rpc.app.clipboardWriteText(result.data.content);
      toast({ title: translate('fileTree.fileCopied') });
    } catch (error) {
      log.error({ error }, 'file tree copy failed');
      toast({
        title: safeFailureLine(String((error as Error)?.message ?? error)),
        variant: 'destructive',
      });
    }
  };

  const copyText = async (text: string, done: string) => {
    try {
      await rpc.app.clipboardWriteText(text);
      toast({ title: done });
    } catch (error) {
      log.error({ error }, 'file tree copy failed');
      toast({
        title: safeFailureLine(String((error as Error)?.message ?? error)),
        variant: 'destructive',
      });
    }
  };

  const copyPath = async () => {
    const result = await workspaceRpc(projectId).files.getAbsolutePath(projectId, workspaceId, node.path);
    if (!result.success) {
      toast({
        title: safeFailureLine(resultErrorMessage(result.error, translate('fileTree.unknownError'))),
        variant: 'destructive',
      });
      return;
    }
    await copyText(result.data.path, translate('fileTree.pathCopied'));
  };

  const revealInFileManager = async () => {
    try {
      const result = await workspaceRpc(projectId).files.getAbsolutePath(projectId, workspaceId, node.path);
      if (!result.success) throw new Error(resultErrorMessage(result.error, translate('fileTree.unknownError')));
      const revealed = await rpc.app.showItemInFolder(result.data.path);
      if (!revealed.success) throw new Error(revealed.error);
    } catch (error) {
      toast({
        title: translate('fileTree.showFailed'),
        description: error instanceof Error ? error.message : translate('fileTree.showFailedDetail'),
        variant: 'destructive',
      });
    }
  };

  const [isDropTarget, setIsDropTarget] = useState(false);

  const handleDragStart = (event: React.DragEvent) => {
    // Carry the path in the workspace environment so drop targets can inject it
    // without knowing which workspace rendered the file tree.
    setDraggedWorkspaceFile(event.dataTransfer, { workspaceId, targetPath: node.path });
  };

  const handleDragOver = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!isDropTarget) setIsDropTarget(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDropTarget(false);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDropTarget(false);
    // 拖放数据要在这一拍里读(后端同步取,异步传)。
    const importing = importInto(ctx, targetDirPath, (dir) => tree.importDropped(scope, dir, event.dataTransfer));
    void importing;
  };

  const importInto = async (_ctx: TreeContext, dir: string, run: (dir: string) => Promise<void>) => {
    const job = run(dir);
    // Expand and load the target directory so the dropped files show up right away.
    if (isExpandable && files) {
      runInAction(() => {
        for (const segment of row.chain) editorView.expandedPaths.add(segment.path);
      });
      if (!files.loadedPaths.has(node.path)) await files.registerDir(node.path);
    }
    await job;
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        style={{ ...style, paddingLeft }}
        className={cn(
          'flex h-7 cursor-pointer select-none items-center gap-2 rounded-md pr-2 hover:bg-row-hover',
          isSelected && `bg-background-2 hover:bg-background-2 active:bg-background-2 ${STATE_LAYERS}`,
          // 拖放目标必须把悬浮钉住:拖到一行上**必然**同时悬浮它,而基串的
          // `hover:bg-row-hover` 是 (0,2,0)、这条裸底色只有 (0,1,0) —— 不钉的话
          // 「这就是落点」的高亮恰好在需要它的那一刻消失。蓝只从 --live 走(design.md)。
          isDropTarget && 'bg-live-soft hover:bg-live-soft outline outline-1 outline-live/60',
          isHidden && 'opacity-60'
        )}
        tabIndex={0}
        draggable={!renaming}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onDragStart={handleDragStart}
        onDragEnd={clearDraggedWorkspaceFile}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={isExpandable ? isExpanded : undefined}
      >
        <span className="text-foreground-muted shrink-0">
          {isExpandable ? (
            isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : (
            <span className="inline-block w-3.5" />
          )}
        </span>

        <span className="shrink-0">
          {isSymlink ? (
            <Link className="text-foreground-muted h-3.5 w-3.5" />
          ) : node.type === 'directory' ? (
            isExpanded ? (
              <FolderOpen className="text-foreground-muted h-3.5 w-3.5" />
            ) : (
              <Folder className="text-foreground-muted h-3.5 w-3.5" />
            )
          ) : (
            <FileIcon filename={node.name} size={12} />
          )}
        </span>

        {renaming ? (
          <InlineNameInput initial={renaming.name} error={renaming.error} onConfirm={onRenameCommit} onCancel={onRenameCancel} />
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              fileStatus === 'added' && 'text-foreground-success',
              fileStatus === 'modified' && 'text-foreground-warning',
              fileStatus === 'deleted' && 'text-foreground-error line-through',
              // 原生 blue-500 → 中性:renamed 不是 live,不该抢那份蓝(design.md C-05)。
              fileStatus === 'renamed' && 'text-foreground-muted'
            )}
          >
            {chainPath !== null ? <CompactedPathLabel path={chainPath} /> : node.name}
          </span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onNew('file')}>
          <FilePlus2 className="size-4" />
          {translate('fileTree.newFile')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onNew('folder')}>
          <FolderPlus className="size-4" />
          {translate('fileTree.newFolder')}
        </ContextMenuItem>
        {(tree.download || tree.uploadFiles) && <ContextMenuSeparator />}
        {tree.download && (
          <ContextMenuItem onClick={() => void tree.download?.(scope, entryOf(node))}>
            <Download className="size-4" />
            {translate('fileTree.download')}
          </ContextMenuItem>
        )}
        {tree.uploadFiles && (
          <ContextMenuItem onClick={() => onUpload(targetDirPath)}>
            <ArrowUpToLine className="size-4" />
            {translate('fileTree.upload')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {isOpenable && (
          <ContextMenuItem onClick={() => void copyFile()}>
            <FileText className="size-4" />
            {translate('task.copy')}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => void copyPath()}>
          <Copy className="size-4" />
          {translate('task.copyPath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void copyText(relNodePath, translate('fileTree.relativePathCopied'))}>
          <Copy className="size-4" />
          {translate('task.copyRelativePath')}
        </ContextMenuItem>
        {tree.canReveal && (
          <ContextMenuItem onClick={() => void revealInFileManager()}>
            <FolderOpen className="size-4" />
            {translate(REVEAL_LABEL_KEY)}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onRename}>
          <Pencil className="size-4" />
          {translate('fileTree.rename')}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => confirmDelete(ctx, node, translate)}>
          <Trash2 className="size-4" />
          {translate('task.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** 行内输入框(新建 / 改名):回车确定、Esc 取消、点别处 = 确定(与 VS Code 资源管理器同一个手感)。 */
function InlineNameInput({
  initial,
  error,
  onConfirm,
  onCancel,
}: {
  initial: string;
  error: EditError;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // 改名时只选中名字那一段(不含扩展名),照 VS Code。
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  useEffect(() => {
    // 被拒了(同名已有 / 名字不行):输入框留着,人改一改再回车。
    done.current = false;
  }, [error]);

  const finish = (confirm: boolean) => {
    if (done.current) return;
    done.current = true;
    if (confirm) onConfirm(value);
    else onCancel();
  };

  return (
    <span className="relative flex min-w-0 flex-1">
      <input
        ref={ref}
        className={cn(
          'h-6 min-w-0 flex-1 rounded-sm border bg-transparent px-1 text-sm text-foreground outline-none',
          error ? 'border-border-destructive' : 'border-border'
        )}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setValue(event.target.value)}
        // 点别处 = 确定;上一次被拒了还没改好就点别处 = 作罢(VS Code 同一个处理)。
        onBlur={() => finish(!error)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') finish(true);
          if (event.key === 'Escape') finish(false);
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      {/* 照 VS Code:输入框下面贴一句为什么不行,输入框留着,改一改再回车。 */}
      {error ? (
        <span
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 max-w-full rounded-sm border border-border-destructive bg-background px-2 py-1 text-xs text-foreground-destructive"
        >
          {error.message}
        </span>
      ) : null}
    </span>
  );
}

/** 正在传的那几件:名字 · 已完成 / 总共 · 速度,句尾「取消」(真实进度,❌ 只转圈)。 */
const TransferRows = observer(function TransferRows({ transfers, device }: { transfers: readonly WorkspaceTransferRow[]; device: string }) {
  const { translate } = useSessionMessages();
  if (transfers.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-border px-3 py-2" data-testid="file-tree-transfers">
      {transfers.map((transfer) => (
        <p key={transfer.id} className="m-0 flex items-center gap-2 text-xs text-foreground-muted">
          <LoadingIndicator size="inline" />
          <span className="min-w-0 flex-1 truncate">
            {translate(transfer.kind === 'upload' ? 'remoteFiles.uploading' : 'remoteFiles.downloading', { name: transfer.name, device })}
            {transfer.total > 0
              ? ` · ${translate('remoteFiles.progress', {
                  done: formatBytes(transfer.done),
                  total: formatBytes(transfer.total),
                  speed: formatBytes(Math.round(transfer.bytesPerSecond)),
                })}`
              : null}{' '}
            <InlineAccentAction onClick={() => transfer.cancel()}>{translate('fileTree.cancel')}</InlineAccentAction>
          </span>
        </p>
      ))}
    </div>
  );
});

function HeaderButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export const EditorFileTree = observer(function EditorFileTree({
  onOpenFile,
  showHeader = false,
}: {
  onOpenFile?: FileTreeOpenHandler;
  /** 「文件」页签里:顶栏写着根目录,右边一排新建文件 / 新建文件夹 / 刷新 / 全部收起(照 VS Code 资源管理器的视图标题栏)。 */
  showHeader?: boolean;
}) {
  const { translate } = useSessionMessages();
  const ctx = useTreeContext();
  const { surface, workspace, tree, scope, device } = ctx;
  const editorView = surface.editorView;
  const files = editorView.files;
  const [isDragOverRoot, setIsDragOverRoot] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef<string | null>(null);
  const trimmedFilter = filterQuery.trim().toLowerCase();

  // @@@sessionpage filter: with a query, search every loaded scope (all loaded dirs
  // treated as expanded) and keep rows whose chain matches; without one, honor expandedPaths.
  const visibleRows = (
    files
      ? trimmedFilter
        ? buildFileTreeVisibleRows(files.rootNodes, new Set(files.loadedPaths), files.childrenById, files.loadedPaths).filter((row) =>
            row.chain.some((n) => n.name.toLowerCase().includes(trimmedFilter))
          )
        : buildFileTreeVisibleRows(files.rootNodes, editorView.expandedPaths, files.childrenById, files.loadedPaths)
      : []
  ) as TreeRow<RenderableFileNode>[];

  const display: DisplayRow[] = visibleRows.map((row) => ({ kind: 'entry', row }));
  if (editing && editing.mode !== 'rename') {
    if (editing.dir === workspace.path) display.unshift({ kind: 'create', depth: 0, mode: editing.mode });
    else {
      const at = display.findIndex((item) => item.kind === 'entry' && item.row.node.path === editing.dir);
      if (at >= 0) {
        const parent = display[at] as { kind: 'entry'; row: TreeRow<RenderableFileNode> };
        display.splice(at + 1, 0, { kind: 'create', depth: parent.row.renderDepth + 1, mode: editing.mode });
      }
    }
  }

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  /** 新建 / 上传落在哪:选中的是目录就是它,是文件就是它所在的目录,没选就是根目录(照 VS Code)。 */
  const targetDir = (from: string | null = selected): string => {
    if (!from || !files) return workspace.path;
    const node = files.nodes.get(from);
    if (!node) return workspace.path;
    return isExpandableFileTreeNode(node) ? node.path : (node.parentPath ?? workspace.path);
  };

  const expand = async (dir: string) => {
    if (!files || dir === workspace.path) return;
    runInAction(() => editorView.expandedPaths.add(dir));
    if (!files.loadedPaths.has(dir)) await files.registerDir(dir);
  };

  const startCreate = async (mode: 'file' | 'folder', from: string | null = selected) => {
    const dir = targetDir(from);
    setFilterQuery('');
    await expand(dir);
    setEditing({ mode, dir, error: null });
  };

  const commitCreate = async (edit: Extract<EditState, { mode: 'file' | 'folder' }>, raw: string) => {
    const name = raw.trim();
    if (!name) {
      setEditing(null);
      return;
    }
    if (localNameProblem(name)) {
      setEditing({ ...edit, error: { message: translate('fileTree.invalidName') } });
      return;
    }
    const result = await tree.create(scope, edit.dir, name, edit.mode);
    if (!result.ok) {
      setEditing({ ...edit, error: { message: nameFailureText(result.failure, name, translate) } });
      return;
    }
    setEditing(null);
    setSelected(result.value.path);
    await files?.registerDir(edit.dir, true);
    // 照 VS Code:新文件建好就打开,新文件夹建好就展开。
    if (edit.mode === 'file') {
      if (onOpenFile) onOpenFile(result.value.path, false);
      else surface.paneLayout.open('file', { path: result.value.path }, { preview: false });
    } else await expand(result.value.path);
  };

  const commitRename = async (edit: Extract<EditState, { mode: 'rename' }>, raw: string) => {
    const name = raw.trim();
    if (!name || name === edit.name) {
      setEditing(null);
      return;
    }
    if (localNameProblem(name)) {
      setEditing({ ...edit, error: { message: translate('fileTree.invalidName') } });
      return;
    }
    const result = await tree.rename(scope, edit.path, name);
    if (!result.ok) {
      setEditing({ ...edit, error: { message: nameFailureText(result.failure, name, translate) } });
      return;
    }
    setEditing(null);
    setSelected(result.value.path);
    followMovedFiles(surface, edit.path, result.value.path);
    await files?.registerDir(edit.parent, true);
  };

  const startUpload = (dir: string) => {
    uploadDir.current = dir;
    uploadInput.current?.click();
  };

  const handleRootDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOverRoot(false);
    if (!files) return;
    void tree.importDropped(scope, workspace.path, event.dataTransfer);
  };

  const handleRootDragOver = (event: React.DragEvent) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragOverRoot(true);
  };

  const handleRootDragLeave = (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOverRoot(false);
  };

  const header = showHeader ? (
    <div className={cn(panelHeaderBarClass, 'gap-1')}>
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-foreground" title={workspace.path || undefined}>
        {workspace.path || '/'}
      </span>
      <HeaderButton label={translate('fileTree.newFile')} disabled={!files || !workspace.path} onClick={() => void startCreate('file')}>
        <FilePlus2 className="size-3.5" />
      </HeaderButton>
      <HeaderButton label={translate('fileTree.newFolder')} disabled={!files || !workspace.path} onClick={() => void startCreate('folder')}>
        <FolderPlus className="size-3.5" />
      </HeaderButton>
      <HeaderButton label={translate('fileTree.refresh')} disabled={!files} onClick={() => void files?.resync()}>
        {files?.isLoading ? <LoadingIndicator size="inline" /> : <RefreshCw className="size-3.5" />}
      </HeaderButton>
      <HeaderButton
        label={translate('fileTree.collapseAll')}
        disabled={editorView.expandedPaths.size === 0}
        onClick={() => runInAction(() => editorView.expandedPaths.clear())}
      >
        <SquareMinus className="size-3.5" />
      </HeaderButton>
    </div>
  ) : null;

  const truncatedAt = tree.truncated?.(scope) ?? null;
  const footer = (
    <>
      {truncatedAt !== null && (
        <div className="shrink-0 px-3 pb-2 text-xs text-foreground-passive">{translate('fileTree.truncated', { count: truncatedAt })}</div>
      )}
      {tree.watchLimited?.(scope) && (
        <p className="m-0 shrink-0 px-3 pb-2 text-xs text-foreground-passive" data-testid="file-tree-watch-limited">
          {translate('remoteFiles.watchLimited', { device: device ?? '' })}{' '}
          <InlineAccentAction onClick={() => void files?.resync()}>{translate('fileTree.refreshNow')}</InlineAccentAction>
        </p>
      )}
      {tree.transfers && <TransferRows transfers={tree.transfers(scope)} device={device ?? ''} />}
      {tree.uploadFiles && (
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            event.target.value = '';
            const dir = uploadDir.current;
            if (!dir || picked.length === 0) return;
            void tree.uploadFiles?.(scope, dir, picked);
          }}
        />
      )}
    </>
  );

  let body: React.ReactNode;
  if (surface.unreachableLabel) {
    // 那台机器离线:树照样在,只是说「离线,上次在线 X」;回来之后自己接上。
    body = <EmptyState label={surface.unreachableLabel} />;
  } else if (files?.error) {
    body = (
      <EmptyState
        label={files.error}
        action={
          <Button size="xs" variant="outline" onClick={() => void files.resync()}>
            {translate('workspace.retry')}
          </Button>
        }
      />
    );
  } else if (!files || files.isLoading) {
    body = (
      <div className="flex h-full items-center justify-center">
        <LoadingIndicator ariaLabel={translate('task.loading')} label={translate('task.loading')} />
      </div>
    );
  } else if (display.length === 0 && !trimmedFilter) {
    body = <div className="text-foreground-muted flex h-full items-center justify-center text-xs">{translate('task.noFiles')}</div>;
  } else {
    body = (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-2 pt-2">
          <div className="flex items-center gap-1.5 rounded-md bg-[var(--em-surface-input)] px-2">
            <Search className="text-foreground-muted size-3.5 shrink-0" />
            <input
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder={translate('task.filterFilesPlaceholder')}
              className="placeholder:text-foreground-muted h-7 w-full bg-transparent text-xs outline-none"
            />
          </div>
        </div>
        {display.length === 0 ? (
          <div className="text-foreground-muted flex flex-1 items-center justify-center text-xs">{translate('task.noMatchingFiles')}</div>
        ) : null}
        <div ref={parentRef} className="flex-1 overflow-y-auto px-2 py-2" role="tree">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const shown = display[vItem.index]!;
              const style: React.CSSProperties = {
                position: 'absolute',
                top: vItem.start,
                left: 0,
                width: '100%',
                height: `${vItem.size}px`,
              };
              if (shown.kind === 'create') {
                const edit = editing as Extract<EditState, { mode: 'file' | 'folder' }>;
                return (
                  <div key="__create" style={{ ...style, paddingLeft: shown.depth * 12 + 4 }} className="flex h-7 items-center gap-2 pr-2">
                    <span className="inline-block w-3.5 shrink-0" />
                    <span className="shrink-0">
                      {shown.mode === 'folder' ? (
                        <Folder className="h-3.5 w-3.5 text-foreground-muted" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-foreground-muted" />
                      )}
                    </span>
                    <InlineNameInput
                      initial=""
                      error={edit.error}
                      onConfirm={(value) => void commitCreate(edit, value)}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                );
              }
              const { row } = shown;
              const renaming = editing?.mode === 'rename' && editing.path === row.node.path ? editing : null;
              return (
                <FileTreeRow
                  key={row.node.path}
                  row={row}
                  ctx={ctx}
                  selected={selected === row.node.path}
                  renaming={renaming}
                  onSelect={() => setSelected(row.node.path)}
                  onOpenFile={onOpenFile}
                  onNew={(mode) => void startCreate(mode, row.node.path)}
                  onRename={() =>
                    setEditing({
                      mode: 'rename',
                      path: row.node.path,
                      parent: row.node.parentPath ?? workspace.path,
                      name: row.node.name,
                      error: null,
                    })
                  }
                  onRenameCommit={(value) => renaming && void commitRename(renaming, value)}
                  onRenameCancel={() => setEditing(null)}
                  onUpload={startUpload}
                  style={style}
                />
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col overflow-hidden', isDragOverRoot && 'bg-background-1')}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      data-testid="editor-file-tree"
    >
      {header}
      <div className="min-h-0 flex-1">{body}</div>
      {footer}
    </div>
  );
});

export type { FilesStore, WorkspaceTreeBackend };
