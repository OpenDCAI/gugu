import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Search } from '@/lib/icons'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { StandaloneBrowserPane } from '@renderer/features/browser/browser-pane';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import { appsOnScreen, takeAppOffScreen } from '@renderer/app/screen-layout-actions';
import { appPlacementStore } from '@renderer/features/extensions/app-placement-store';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import {
  getProjectStore,
  mountedProjectData
} from '@renderer/features/projects/stores/project-selectors';
import {
  FILE_TREE_DRAFT_DEFAULT_SIZE,
  FILE_TREE_DRAFT_HOST_MIN_SIZE,
  FILE_TREE_DRAFT_MAX_SIZE,
  FILE_TREE_MIN_SIZE
} from '@renderer/features/sessions/editor/file-tree-split';
import { OpenWithSystemButton } from '@renderer/features/sessions/editor/file-content-types';
import { FilesStore } from '@renderer/features/sessions/editor/stores/files-store';
import { openPathWithFailureToast } from '@renderer/features/sessions/stores/open-file-in-file-editor';
import { resolveWorkspacePath } from '@renderer/features/sessions/stores/workspace-path';
import { BinaryRenderer } from '@renderer/lib/editor/binary-renderer';
import { DocumentFileRenderer } from '@renderer/lib/editor/document-file-renderer';
import { getFileKind, isOfficeKind } from '@renderer/lib/editor/fileKind';
import {
  buildFileTreeVisibleRows,
  isExpandableFileTreeNode,
  isOpenableFileTreeNode
} from '@renderer/features/sessions/file-tree/tree-utils';
import { TerminalPtyContent } from '@renderer/features/sessions/terminals/terminal-pty-content';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { rpc } from '@renderer/lib/ipc';
import { PtySession } from '@renderer/lib/pty/pty-session';
import { Button } from '@renderer/lib/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { basenameFromAnyPath } from '@shared/path-name';
import { UnavailableTabPlaceholder } from '@renderer/features/tabs/unavailable-tab';
import { DraftTabStrip } from './draft-tab-strip';
import { WorkspacePanelActionList } from './pane-empty-state';
import { useSessionShellContext } from './session-shell-context';
import {
  type DraftTab,
  draftToolsBlockedOnMachine,
  draftWorkspaceEntries,
  isBuiltinDraftTab
} from './workspace-panel-entries';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { panelHeaderBarClass } from '@renderer/lib/ui/panel-header-bar';
import { cn } from '@renderer/utils/utils';

// tab 名只登记 catalog key，文案在渲染时按当前语言取 —— 存成品字符串会在切语言后停在旧语言上。
export const DraftWorkspacePanel = observer(function DraftWorkspacePanel({
  projectId,
  visible,
  remoteDeviceId = null
}: {
  projectId: string | undefined;
  visible: boolean;
  /** 新建框选的是别的机器(#6264):这几格跑在这台电脑上,够不着那台机器 —— 灰着说原因。 */
  remoteDeviceId?: string | null;
}) {
  const { translate } = useSessionMessages();
  const project = projectId ? mountedProjectData(getProjectStore(projectId)) : null;
  const workspaceId = project?.repositoryWorkspaceId ?? undefined;
  const workspacePath = project?.path;
  const canOpenTerminal = Boolean(workspacePath);
  // ❌ 曾经带 `hasExplicitProject &&`：隐式 task-home 一样有工作目录(它本身就是 git 仓库),
  // 按「有没有显式项目」一刀切，等于凭一个与能力无关的事实关掉一个能用的功能(owner 2026-08-21)。
  const canOpenFiles = Boolean(projectId && workspaceId && workspacePath);
  const blocked = remoteDeviceId
    ? draftToolsBlockedOnMachine(
        remoteHostsStore.device(remoteDeviceId)?.directTerminal === true,
        translate,
        remoteHostsStore.device(remoteDeviceId) ?? null
      )
    : {};
  const { setDraftTabCount } = useSessionShellContext();
  const [tabs, setTabs] = useState<DraftTab[]>([]);
  // 报给外壳:面板空不空由它按「有没有内容」决定收起,❌ 这里不再自己关面板。
  useEffect(() => {
    setDraftTabCount(tabs.length);
  }, [setDraftTabCount, tabs.length]);
  const [activeTab, setActiveTab] = useState<DraftTab | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // 开着的文件页签跟随**能力**关闭,而不是跟随「有没有显式项目」—— 工作目录没了才该收,
  // 换个项目形态不该把人正在看的文件踢掉。
  useEffect(() => {
    if (canOpenFiles) return;
    setTabs((current) => current.filter((tab) => tab !== 'files'));
    setActiveTab((current) => (current === 'files' ? null : current));
  }, [canOpenFiles]);

  // 换到别的机器:这台电脑上已经开着的终端 / 浏览器 / 文件页签收起来(它们看的不是那台机器)。
  const blockedKey = Object.keys(blocked).join(',');
  useEffect(() => {
    if (!blockedKey) return;
    const shut = (tab: DraftTab) => blockedKey.split(',').includes(tab);
    setTabs((current) => current.filter((tab) => !shut(tab)));
    setActiveTab((current) => (current && shut(current) ? null : current));
  }, [blockedKey]);

  const openTab = (tab: DraftTab) => {
    // 一个 App 只有一份(behavior tab-extensions,#7052):放到草稿这里 = 从它摆着的那条会话里拿走。
    if (!isBuiltinDraftTab(tab)) {
      appPlacementStore.take(tab);
      takeAppOffScreen(tab);
    }
    setTabs((current) => (current.includes(tab) ? current : [...current, tab]));
    setActiveTab(tab);
  };

  const closeTab = (tab: DraftTab) => {
    const next = tabs.filter((candidate) => candidate !== tab);
    setTabs(next);
    setActiveTab((currentActive) =>
      currentActive === tab ? next[next.length - 1] ?? null : currentActive
    );
    if (tab === 'files') setSelectedFilePath(null);
  };

  // Read live off the store (this component is an observer) so an extension installed
  // or upgraded while a draft is open shows up, and under its current title. Enabled
  // ones only, for the strip and the entry list alike: the panel lists what is in use, the「App」page lists what is
  // installed (#5265; owner 10-20 for the entry list).
  const extensionContributions = installedExtensionsStore.enabledTabContributions;
  // This panel keeps its own tab list and hears no registry event, so it applies the rules itself: a tab of an App the
  // user just disabled closes, the same as the engine-backed panel does through closeKind, and so does one placed in a
  // session, a screen block or its own window since — an App has one copy (#7052). Uninstalled stays a placeholder.
  const disabledIds = installedExtensionsStore.disabled;
  const placedKinds = [...appPlacementStore.placements.keys(), ...appsOnScreen()].join(',');
  useEffect(() => {
    const placed = placedKinds.split(',');
    for (const tab of tabs) {
      if (isBuiltinDraftTab(tab)) continue;
      const parsed = parseExtensionTabKind(tab);
      if (!parsed) continue;
      if (disabledIds.includes(parsed.extensionId) || placed.includes(tab)) closeTab(tab);
    }
  }, [disabledIds, placedKinds, tabs]);
  const emptyStateEntries = draftWorkspaceEntries({
    canOpenTerminal,
    canOpenFiles,
    blocked,
    extensions: extensionContributions,
    translate,
    onOpen: openTab
  });

  return (
    <aside
      aria-label={translate('task.workspacePanel')}
      data-testid={visible ? 'new-session-right-panel' : undefined}
      // 收起用 inert 而不是 hidden:分栏(lib/layout/side-panel-split.tsx)收起时面板带着内容滑出去,
      // hidden 会让内容在第一帧就没了、只剩一块空底往外滑。inert 同时把它移出焦点序与无障碍树。
      inert={!visible}
      // 宽度与那条分隔线都归分栏组(lib/layout/side-panel-split.tsx,与会话页同一个)。
      // ❌ 别在这里写宽度或 border-l:写回来就等于同一个数两个出处，面板也不再跟着把手走。
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      {tabs.length > 0 ? (
        <DraftTabStrip
          tabs={tabs}
          activeTab={activeTab}
          selectedFileName={selectedFilePath ? basenameFromAnyPath(selectedFilePath) : null}
          extensions={extensionContributions}
          canOpenTerminal={canOpenTerminal}
          canOpenFiles={canOpenFiles}
          blocked={blocked}
          onSelect={setActiveTab}
          onClose={closeTab}
          onOpen={openTab}
        />
      ) : null}

      {/* bg-tab-face 与活动页签同一个 token —— 这是「连体」成立的**前提**,不是装饰:两边一旦不同色,
          页签底下就会出现一条色阶断层,耳朵也就无从谈起(与 <PaneContent> 同一条)。没有页签条时不上色,
          空态那一屏跟着面板的底走。 */}
      <div className={cn('relative min-h-0 flex-1', tabs.length > 0 && 'bg-tab-face')}>
        {tabs.includes('terminal') && projectId && workspacePath ? (
          <div className="absolute inset-0" hidden={activeTab !== 'terminal'}>
            <DraftTerminalPane
              projectId={projectId}
              workspaceId={workspaceId ?? projectId}
              cwd={workspacePath}
            />
          </div>
        ) : null}
        {tabs.includes('browser') && projectId ? (
          <div className="absolute inset-0" hidden={activeTab !== 'browser'}>
            <DraftBrowserPane projectId={projectId} workspaceId={workspaceId ?? projectId} />
          </div>
        ) : null}
        {tabs.includes('files') && projectId && workspaceId && workspacePath ? (
          <div className="absolute inset-0" hidden={activeTab !== 'files'}>
            <DraftFilesPane
              projectId={projectId}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              onSelectedPathChange={setSelectedFilePath}
            />
          </div>
        ) : null}
        {tabs.map((tab) => {
          if (isBuiltinDraftTab(tab)) return null;
          const parsed = parseExtensionTabKind(tab);
          if (!parsed) return null;
          // Uninstalled while this tab was open: the tab stays (the user did not close
          // it) but the extension stops drawing. This panel keeps its own tab list and
          // never asks the registry, so it has to check the inventory itself — the
          // engine-backed panel gets the same outcome through provider withdrawal.
          const stillInstalled = extensionContributions.some((entry) => entry.kind === tab);
          return (
            <div key={tab} className="absolute inset-0" hidden={activeTab !== tab}>
              {stillInstalled ? (
                // 同一张常驻页(整个 app 一张,一个 App 只有一份),此刻落在草稿这里。草稿先于会话存在,所以页的
                // context 里没有会话 —— 这不是缺值而是一个真实状态,❌ 给 App 一个假的会话 id。
                // 只在这一枚在前面时认领:页住在根层,不看它时放手不等于关掉它。
                activeTab === tab ? <ExtensionSharedSlot tabKind={tab} tabId={`draft:${tab}`} /> : null
              ) : (
                <UnavailableTabPlaceholder kind={tab} onClose={() => closeTab(tab)} />
              )}
            </div>
          );
        })}
        {activeTab === null ? <WorkspacePanelActionList entries={emptyStateEntries} /> : null}
      </div>
    </aside>
  );
});

/**
 * 「+」菜单与空态清单**同吃一份** draftWorkspaceEntries。
 *
 * ❌ 曾经在这里手写第二份:两处各按 hasExplicitProject 分支、各自决定删哪几项,于是它们必然漂移
 * —— #2374 的成因就是「草稿面板自己内联拼一份入口列表」。同一份数据两处画,是这个文件唯一
 * 不会再漂的形态。够不着的项照样渲染(disabled + 原因),不从菜单里删。
 */
function DraftBrowserPane({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const [browserId, setBrowserId] = useState<string | null>(null);

  useEffect(() => {
    const session = browserSessionStore.createSession({
      projectId,
      workspaceId,
      sessionId: 'new-session-draft'
    });
    setBrowserId(session.browserId);
    return () => {
      browserSessionStore.removeSession(session.browserId);
    };
  }, [projectId, workspaceId]);

  return browserId ? <StandaloneBrowserPane browserId={browserId} visible /> : null;
}

const DraftTerminalPane = observer(function DraftTerminalPane({
  projectId,
  workspaceId,
  cwd
}: {
  projectId: string;
  workspaceId: string;
  cwd: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const session = useMemo(() => {
    const ptySessionId = makePtySessionId(projectId, 'draft', crypto.randomUUID());
    return new PtySession(ptySessionId, async () => {
      const result = await rpc.pty.createScratch({ ptySessionId, cwd });
      if (result.success) return;
      setError(result.error.message);
      return false;
    });
  }, [cwd, projectId]);

  useEffect(
    () => () => {
      void rpc.pty.kill(session.ptySessionId);
      session.destroy();
    },
    [session]
  );

  return (
    <div className="relative h-full">
      <TerminalPtyContent
        className="h-full"
        activeSession={session}
        allPtySessionIds={[session.ptySessionId]}
        autoFocus
        emptyState={null}
        workspaceId={workspaceId}
      />
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-foreground-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
});

/** PDF / Office / 已知二进制之外的文件,草稿面板照旧按文本读出来摆在 <pre> 里。 */
function isTextualDraftFile(path: string): boolean {
  const kind = getFileKind(path);
  return kind !== 'binary' && kind !== 'pdf' && !isOfficeKind(kind);
}

/**
 * 新建任务时右侧「文件」页签的内容区。PDF 与 Word / PPT / Excel 用会话页同一个只读阅读器,画不出来的二进制给
 * 「用系统默认程序打开」(#7191,规格 task-renderer:「工作区内外都开在查看面板里只读预览」—— 这个面板也是查看面板)。
 * ❌ 曾经一律当文本读进 <pre>:Office 文件在这里是一片空白,PDF 是乱码。
 */
function DraftFileBody({
  path,
  projectId,
  workspaceId,
  workspacePath,
  text
}: {
  path: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  text: string;
}) {
  const kind = getFileKind(path);
  const absolutePath = resolveWorkspacePath(workspacePath, path);
  // 文件树里的都在这个工作区里:说出是哪个,home 外的工作区(外接盘…)也能交给系统程序(#7191)。
  const workspace = { projectId, workspaceId };
  if (kind === 'pdf' || isOfficeKind(kind)) {
    return (
      <DocumentFileRenderer
        key={path}
        file={{ path }}
        kind={kind}
        projectId={projectId}
        workspaceId={workspaceId}
        openAction={<OpenWithSystemButton absolutePath={absolutePath} workspace={workspace} />}
        onOpenExternally={() => void openPathWithFailureToast(absolutePath, workspace)}
      />
    );
  }
  if (kind === 'binary') {
    return <BinaryRenderer file={{ path }} action={<OpenWithSystemButton absolutePath={absolutePath} workspace={workspace} />} />;
  }
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-3 text-xs leading-5 text-foreground">{text}</pre>
  );
}

const DraftFilesPane = observer(function DraftFilesPane({
  projectId,
  workspaceId,
  workspacePath,
  onSelectedPathChange
}: {
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  onSelectedPathChange: (path: string | null) => void;
}) {
  const { translate } = useSessionMessages();
  const files = useMemo(
    () => new FilesStore(projectId, workspaceId, workspacePath),
    [projectId, workspaceId, workspacePath]
  );
  const expandedPaths = useMemo(() => observable.set<string>(), []);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [treeVisible, setTreeVisible] = useState(true);
  const [filterQuery, setFilterQuery] = useState('');
  const fileTreeToggleLabel = translate(treeVisible ? 'task.hideFileTree' : 'task.showFileTree');
  // 收起文件树会换掉分栏成员，按成员各存一份布局，免得展开时读回一份对不上的。
  const panelIds = useMemo(
    () =>
      treeVisible ? ['draft-workspace-content', 'draft-workspace-tree'] : ['draft-workspace-content'],
    [treeVisible]
  );
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'draft-workspace-tree-split',
    storage: localStorage,
    panelIds
  });

  useEffect(() => {
    let disposed = false;
    let acquired = false;

    void rpc.projects.acquireProjectWorkspace(projectId, workspaceId).then(async (result) => {
      if (!result.success) {
        if (!disposed) setActivationError(result.error.message);
        return;
      }
      acquired = true;
      if (disposed) {
        void rpc.projects.releaseProjectWorkspace(projectId, workspaceId);
        return;
      }
      await files.start();
    });

    return () => {
      disposed = true;
      files.dispose();
      if (acquired) void rpc.projects.releaseProjectWorkspace(projectId, workspaceId);
    };
  }, [files, projectId, workspaceId]);

  const rows = buildFileTreeVisibleRows(
    files.rootNodes,
    expandedPaths,
    files.childrenById,
    files.loadedPaths
  );
  const trimmedFilter = filterQuery.trim().toLowerCase();
  const visibleRows = trimmedFilter
    ? rows.filter((row) =>
        row.chain.some((node) => node.name.toLowerCase().includes(trimmedFilter))
      )
    : rows;

  const openNode = async (path: string) => {
    setSelectedPath(path);
    onSelectedPathChange(path);
    setReadError(null);
    // 文档与二进制不当文本读:它们由 DraftFileBody 自己取字节或只给下一步(#7191)。
    if (!isTextualDraftFile(path)) {
      setContent('');
      return;
    }
    const result = await rpc.workspace.files.readFile(projectId, workspaceId, path, 1024 * 1024);
    if (!result.success) {
      setContent('');
      // 底层错误原文是诊断数据；只有主进程没给 message 时才落到本地化外壳。
      setReadError(
        'message' in result.error ? result.error.message : translate('task.readFileFailed')
      );
      return;
    }
    setContent(result.data.content);
  };

  if (activationError || files.error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-foreground-destructive">
        {activationError ?? files.error}
      </div>
    );
  }

  if (files.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-foreground-muted">
        {translate('task.loading')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={cn(panelHeaderBarClass, 'gap-1')}>
        <span
          className="min-w-0 flex-1 truncate px-1 text-xs text-foreground"
          title={selectedPath ?? '/'}
        >
          {selectedPath ?? '/'}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={fileTreeToggleLabel}
          title={fileTreeToggleLabel}
          onClick={() => setTreeVisible((visible) => !visible)}
        >
          {treeVisible ? (
            <PanelRightClose className="size-3.5" />
          ) : (
            <PanelRightOpen className="size-3.5" />
          )}
        </Button>
        {selectedPath ? (
          <OpenInMenu path={selectedPath} className="bg-transparent" borderless />
        ) : null}
      </div>
      <ResizablePanelGroup
        id="draft-workspace-tree-split"
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="draft-workspace-content"
          minSize={FILE_TREE_DRAFT_HOST_MIN_SIZE}
          className="flex min-w-0 flex-col overflow-hidden"
        >
          {selectedPath ? (
            <DraftFileBody
              path={selectedPath}
              projectId={projectId}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              text={readError ?? content}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <FolderOpen className="size-6 text-foreground-muted" />
              <h2 className="text-sm font-medium text-foreground">{translate('task.openFile')}</h2>
              <p className="text-xs text-foreground-muted">{translate('task.openFileHint')}</p>
            </div>
          )}
        </ResizablePanel>
        {treeVisible ? (
          <>
            <ResizableHandle />
            <ResizablePanel
              id="draft-workspace-tree"
              defaultSize={FILE_TREE_DRAFT_DEFAULT_SIZE}
              minSize={FILE_TREE_MIN_SIZE}
              maxSize={FILE_TREE_DRAFT_MAX_SIZE}
              groupResizeBehavior="preserve-pixel-size"
              className="flex min-w-0 flex-col overflow-hidden bg-background"
            >
              <div className="px-2 pt-2">
                <div className="flex items-center gap-1.5 rounded-md bg-[var(--em-surface-input)] px-2">
                  <Search className="size-3.5 shrink-0 text-foreground-muted" />
                  <input
                    value={filterQuery}
                    onChange={(event) => setFilterQuery(event.target.value)}
                    placeholder={translate('task.filterFilesPlaceholder')}
                    className="h-7 w-full bg-transparent text-xs outline-none placeholder:text-foreground-muted"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" role="tree">
                {visibleRows.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-foreground-muted">
                    {translate(trimmedFilter ? 'task.noMatchingFiles' : 'task.noFiles')}
                  </div>
                ) : null}
                {visibleRows.map((row) => {
                  const node = row.node;
                  const expandable = isExpandableFileTreeNode(node);
                  const expanded = row.chain.every((segment) => expandedPaths.has(segment.path));
                  return (
                    <button
                      key={node.path}
                      type="button"
                      role="treeitem"
                      aria-selected={selectedPath === node.path}
                      aria-expanded={expandable ? expanded : undefined}
                      className="flex h-7 w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-xs text-foreground-muted hover:bg-row-hover active:bg-row-press hover:text-foreground aria-selected:bg-row-selected aria-selected:text-foreground"
                      style={{ paddingLeft: `${6 + row.renderDepth * 12}px` }}
                      onClick={() => {
                        if (expandable) {
                          if (expanded) {
                            for (const segment of row.chain) expandedPaths.delete(segment.path);
                          } else {
                            for (const segment of row.chain) expandedPaths.add(segment.path);
                            void files.registerDir(row.chain[row.chain.length - 1].path);
                          }
                          files.reconcileVisibleScopes(expandedPaths);
                          return;
                        }
                        if (isOpenableFileTreeNode(node)) void openNode(node.path);
                      }}
                    >
                      {expandable ? (
                        expanded ? (
                          <ChevronDown className="size-3" />
                        ) : (
                          <ChevronRight className="size-3" />
                        )
                      ) : (
                        <span className="w-3" />
                      )}
                      {expandable ? (
                        expanded ? (
                          <FolderOpen className="size-3.5" />
                        ) : (
                          <Folder className="size-3.5" />
                        )
                      ) : (
                        <FileText className="size-3.5" />
                      )}
                      <span className="truncate">
                        {row.chain.map((segment) => segment.name).join('/')}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
});
