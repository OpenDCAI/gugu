import { Clock, FolderInput, History, SquarePen } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React from 'react';
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { localHomeSessions } from '@renderer/features/assistant/assistant-home-sessions';
import { isAssistantSession } from '@renderer/features/assistant/assistant-lineage';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  isCurrentView,
  useNavigate,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { SidebarPinnedSessionList } from './pinned-session-list';
import { ProjectsGroupLabel } from './projects-group-label';
import { SidebarScrollContext, type SidebarScrollTargets } from './sidebar-scroll-context';
import {
  SidebarContainer,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  sidebarRowContentInsetX,
} from './sidebar-primitives';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { SidebarSearchTrigger } from './sidebar-search-trigger';
import { SidebarSpace } from './sidebar-space';
import { SidebarListSwitch, useSidebarLayoutContextMenu } from './sidebar-list-switch';
import { openShellChatAction, shellChatActions, SidebarChatsSection } from './sidebar-chats-section';
import { publishSidebarChatView, useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { SidebarSessionsSection } from './sidebar-sessions-section';
import { SidebarVirtualList } from './sidebar-virtual-list';
import { SampleProjectSidebar } from './sample-project-row';
import { useSidebarDrop } from './use-sidebar-drop';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useNativeConversationChat } from '@/hooks/useNativeConversationChat';
import { screenLayout } from '@renderer/app/screen-layout';

// 侧栏自上而下:布局 / 折叠 / 搜索 →「项目 | 对话」→ 三行入口 → 置顶 → 列表,两页同一副骨架。
// 三行入口的第一行都是「新建任务」;项目页另两行是会话历史、已安排,对话页是新建群聊、添加联系人。
// 合在一起时没有切换,入口留项目那三行,列表是 置顶 → 项目 → 会话 → 对话。
// No foot: 资源库 and 设置 are on the far-left rail (product spec, #7046) — they belong to the gugu shell.
export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const { translate } = useSessionMessages();

  // #5818 侧栏每一行 hover 要说「这一行是哪个 agent」:本机花名册整份读一次,之后靠 provisioned /
  // renamed 两条既有事件增量更新。要这张表的就是侧栏,所以由它点火;start() 幂等,收起再展开不重读。
  React.useEffect(() => {
    sessionAgentNames.start();
  }, []);

  // #6264 别的机器上的项目与本机项目混排在「项目」分区里(按 Zed):侧栏挂上就开始跟那些机器的会话列表。
  // start() 幂等;桥晚到 / 登出被拆,store 自己跟着走。
  React.useEffect(() => {
    remoteHostsStore.start();
  }, []);

  // behavior session-page「会话列表与状态」: 用不用二级分类是一个设置。组头渲染在 React 树里、
  // 键盘导航链住在 store 里,两处得读同一个真值,所以设置在这里镜像进 store。
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const stateGroupsEnabled = interfaceSettings?.showLeftSidebarStateGroups ?? false;
  React.useEffect(() => {
    sidebarStore.setStateGroupsEnabled(stateGroupsEnabled);
  }, [stateGroupsEnabled]);

  // #5818 「悬浮时这一行变成它是谁」的开关,同一条镜像路 —— 读在设置里,用在每一行上。
  // #7199 个人助理不住在任务区:它是谁(壳按库里的标记认出来,经助理那座桥发过来),交给 store 去藏它自己的会话。
  const assistantShell = useAssistantShell();
  const assistantAgentId = assistantShell?.assistant?.id ?? null;
  React.useEffect(() => {
    sidebarStore.setAssistantAgentId(assistantAgentId);
  }, [assistantAgentId]);
  // 住在这台电脑上:它自己那条会话在哪个项目里(它的工作目录),那一行项目也不单列。读本机会话列表,只在住这台时问。
  const assistantOnThisComputer = assistantShell?.home?.kind === 'computer' && assistantShell.home.thisDevice;
  React.useEffect(() => (assistantOnThisComputer ? localHomeSessions.use() : undefined), [assistantOnThisComputer]);
  const assistantHomeProjectId = assistantOnThisComputer
    ? localHomeSessions.sessions.find((session) => isAssistantSession(session, assistantAgentId))?.projectId ?? null
    : null;
  React.useEffect(() => {
    sidebarStore.setAssistantHomeProjectId(assistantHomeProjectId);
  }, [assistantHomeProjectId]);
  // Its project row is hidden, so expanding a row cannot load these sessions. Open the existing
  // local project for the session list even when the user has not visited the assistant App yet.
  const assistantHomeProject = assistantHomeProjectId ? appState.projects.projects.get(assistantHomeProjectId) : null;
  React.useEffect(() => {
    if (!assistantHomeProjectId || !assistantHomeProject) return;
    void appState.projects.ensureMounted(assistantHomeProjectId).catch((error) => {
      log.warn('[assistant] could not open task sessions in the assistant home', { error: String(error) });
    });
  }, [assistantHomeProjectId, assistantHomeProject]);

  const agentNameOnHoverEnabled = interfaceSettings?.showLeftSidebarAgentNameOnHover ?? true;
  React.useEffect(() => {
    sidebarStore.setAgentNameOnHoverEnabled(agentNameOnHoverEnabled);
  }, [agentNameOnHoverEnabled]);

  // 新建任务 always lands on the dedicated compose view (owner: 点「新建任务」直接进该界面;
  // 命名统一为「新建任务」, 不再出现「新建会话」).
  // Routing to 'project' instead made the button a no-op whenever the user was already
  // sitting on that project's home — which is the default landing view.
  const handleNewSession = () => {
    // behavior session-page「键盘导航」: New task is the first station on the chain, so clicking it
    // parks the cursor there — ↓ then walks down into Pinned/Projects from the top.
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'new-session' });
    navigate('new-session');
  };
  const isNewSessionCursor = sessionKeyboardNav.cursor?.kind === 'new-session';

  // 会话历史(spec session-page「会话历史」,#6083)取代了从前的「导入会话」弹窗:咕咕自己的会话(活跃 / 已归档)
  // 在任何宿主上都列得出,所以入口常驻;本机引擎那一档由面板按宿主有没有接本机来源自行决定。

  const { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop } = useSidebarDrop();

  // 用 state 而不是 ref 存这两个节点:虚拟列表要在它们挂载后才拿得到 scrollElement,
  // ref 的赋值不触发重渲染,子组件会永远读到 null。
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
  const merged = sidebarStore.listLayout === 'merged';
  const page = sidebarStore.listPage;
  const showProjects = merged || page === 'projects';
  const showChats = merged || page === 'chats';
  // 两页各记各的滚动位置(同一个滚动容器,切页时存下离开那页的、恢复要去那页的)。
  const scrollTopByPage = React.useRef({ projects: 0, chats: 0 });
  const shownPage = React.useRef(page);
  React.useLayoutEffect(() => {
    if (!scroller || shownPage.current === page) return;
    scrollTopByPage.current[shownPage.current] = scroller.scrollTop;
    shownPage.current = page;
    scroller.scrollTop = scrollTopByPage.current[page];
  }, [page, scroller]);
  const layoutMenu = useSidebarLayoutContextMenu();
  // 两枚页签上的未读数由壳发过来(还没发过 = 先不挂数);「项目」那枚是所有项目群的未读之和。
  const chatSignals = useSidebarChatSignals();
  const chatsUnread = chatSignals?.chatsUnread ?? 0;
  const projectsUnread = chatSignals ? [...chatSignals.groupUnread.values()].reduce((sum, count) => sum + count, 0) : 0;
  // 壳画的对话列表要知道:正看着哪条对话(那一行高亮)。
  const focusedChatId =
    useNativeConversationChat(currentView === 'session'
      ? (appState.navigation.viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId
      : currentView === 'screen' ? screenLayout.recentSession?.sessionId : undefined) ?? (currentView === 'chat'
      ? ((appState.navigation.viewParamsStore.chat as { chatId?: string } | undefined)?.chatId ?? null)
      : null);
  // 拼在一屏的几组:壳画的「对话」也把同一组的几行并在一处(同「项目」这边)。
  const joinedGroups = sidebarStore.joinedGroups;
  React.useEffect(
    () => publishSidebarChatView({ focusedChatId, groups: joinedGroups }),
    [focusedChatId, joinedGroups]
  );
  const [scrollContent, setScrollContent] = React.useState<HTMLDivElement | null>(null);
  const scrollTargets = React.useMemo<SidebarScrollTargets>(
    () => ({ scroller, content: scrollContent }),
    [scroller, scrollContent]
  );

  return (
    <div
      data-region="left-sidebar"
      className={cn(
        'relative flex h-full flex-col bg-background-tertiary text-foreground-tertiary-muted transition-colors',
        isLeftOpen && 'border-r border-border',
        isDragOver && 'bg-background-2 ring-2 ring-inset ring-border-2'
      )}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={layoutMenu.onContextMenu}
    >
      {layoutMenu.menu}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-background-tertiary/80 backdrop-blur-sm">
          <FolderInput className="size-8 text-foreground" />
          <span className="text-xs font-medium text-foreground">
            {translate('sidebar.dropToAddProject')}
          </span>
        </div>
      )}
      <SidebarSpace><SidebarSearchTrigger /></SidebarSpace>
      <SidebarContainer className="min-h-0 w-full flex-1 border-r-0">
        <SidebarContent className="flex flex-col">
          {/* mb-2:固定的动作区与下面滚动的分区之间要有一道呼吸。原先 mb-0 让「已安排」与
              「项目」标题之间的距离与行距一模一样,三个分区因此读不出是三个分区。 */}
          <SidebarGroup className="mb-2 flex shrink-0 flex-col">
            <SidebarMenu>
              {!merged && <SidebarListSwitch projectsUnread={projectsUnread} chatsUnread={chatsUnread} />}
              {/* 新建任务是一个视图(compose 页),与「已安排」「设置」同理:正在看它时带 active
                  底色。以前写死 isActive={false},落地页上只剩键盘光标那圈 ring 孤零零地画着,
                  读起来像一个描边样式的按钮,与旁边几行不是一套。
                  两个 view id 都要算:`home` 与 `new-session` 渲染的是**同一个** NewSessionPage
                  (app/home-view.tsx),而应用落地在 `home` —— 只认 `new-task` 的话,最常见的
                  那一屏(刚打开、正对着这个 composer)反而不高亮,实测就是这样。 */}
              <SidebarMenuButton
                isActive={
                  isCurrentView(currentView, 'new-session') || isCurrentView(currentView, 'home')
                }
                data-nav-cursor={isNewSessionCursor || undefined}
                onClick={handleNewSession}
                aria-label={translate('sidebar.newTask')}
                className={cn(
                  'w-full justify-between',
                  // 同 sidebar-primitives 的键盘光标:环换成悬浮档铺一层(spec「任何情况都无环」)。
                  isNewSessionCursor && 'state-hover-layer'
                )}
              >
                <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                  <SquarePen className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="truncate">{translate('sidebar.newTask')}</span>
                </span>
              </SidebarMenuButton>
              {showProjects ? (
                <>
                  <SidebarMenuButton
                    isActive={isCurrentView(currentView, 'session-history')}
                    onClick={() => navigate('session-history')}
                    aria-label={translate('sidebar.sessionHistory')}
                    className="w-full justify-between"
                    data-testid="sidebar-session-history"
                  >
                    <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                      <History className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
                      <span className="truncate">{translate('sidebar.sessionHistory')}</span>
                    </span>
                  </SidebarMenuButton>
                  <SidebarMenuButton
                    isActive={isCurrentView(currentView, 'automations')}
                    onClick={() => navigate('automations')}
                    aria-label={translate('sidebar.scheduled')}
                    className="w-full justify-between"
                  >
                    <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                      <Clock className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
                      <span className="truncate">{translate('sidebar.scheduled')}</span>
                    </span>
                  </SidebarMenuButton>
                </>
              ) : (
                shellChatActions.map(({ action, icon: Icon, label }) => (
                  <SidebarMenuButton
                    key={action}
                    onClick={() => openShellChatAction(action)}
                    aria-label={translate(label)}
                    className="w-full justify-between"
                  >
                    <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                      <Icon className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
                      <span className="truncate">{translate(label)}</span>
                    </span>
                  </SidebarMenuButton>
                ))
              )}
            </SidebarMenu>
          </SidebarGroup>
          {/* @@@sidebar-single-scroller — 置顶 / 项目 / 任务三区共用这一个滚动容器(见
              sidebar-scroll-context)。它必须是**块级**的:做成 flex 列的话,里面的内容层会被
              flex 收缩到容器高度,scrollHeight 跟着塌回去,滚动条就再也不出现了。 */}
          <div
            ref={setScroller}
            data-region="sidebar-scroll"
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            <div ref={setScrollContent}>
              <SidebarScrollContext.Provider value={scrollTargets}>
                {showProjects && (
                  <>
                    <SidebarPinnedSessionList />
                    {/* 与上面同理:项目区与任务区之间同样要有那一道呼吸,且是同一个数。 */}
                    <SidebarGroup className="mb-2 flex flex-col">
                      <ProjectsGroupLabel />
                      {!sidebarStore.projectsCollapsed && (
                        <SidebarGroupContent className="flex flex-col">
                          {/* 项目组的留白落在虚拟列表自己身上(SidebarVirtualList 里),所以这一层
                              显式让开,不叠第二份。留白的数值只有一个出处:sidebarGroupInsetX。 */}
                          <SidebarMenu className="flex flex-col px-0">
                            <SidebarVirtualList />
                            <SampleProjectSidebar />
                          </SidebarMenu>
                        </SidebarGroupContent>
                      )}
                    </SidebarGroup>
                    <SidebarSessionsSection />
                  </>
                )}
                {showChats && <SidebarChatsSection merged={merged} unread={chatsUnread} />}
              </SidebarScrollContext.Provider>
            </div>
          </div>
        </SidebarContent>
      </SidebarContainer>
    </div>
  );
});
