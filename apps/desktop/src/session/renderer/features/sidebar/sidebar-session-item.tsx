import { platform } from '@/platform';
import { messageForUser } from '@/lib/userFacingError';
import { safeFailureLine } from '../sessions/gugu-reason';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { dissolveScreenGroup, isScreenView, showSessionBeside, takeSessionOutOfGroup } from '@renderer/app/screen-layout-actions';
import { AlertTriangle, Archive, Copy, LayoutGrid, Pencil, Pin, PinOff, Scissors, Sparkles, SquareMinus } from '@/lib/icons'
import { GitFork } from '@/lib/icons'
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { spawnedByExtensionLabel as spawnedByExtensionLabelFor } from '@renderer/features/extensions/spawned-by-extension-label';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { when } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useRef } from 'react';
import { formatSessionTitleForDisplay } from '@renderer/features/sessions/session-title-utils';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { moveSessionUnder } from '@renderer/features/sessions/set-session-parent-flow';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { focusedSessionId } from '@renderer/features/sessions/pane-selectors';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import {
  asProvisioned,
  getSessionPageStore,
  getSessionView,
} from '@renderer/features/sessions/stores/session-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { log } from '@renderer/utils/logger';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { ContextMenuItem, ContextMenuSeparator } from '@renderer/lib/ui/context-menu';
import { hasStatusSource } from '@shared/core/sessions/initial-agent-status';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { clearDraggedScreenContent, setDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { SessionRowShell } from './sidebar-session-row';
import { useSessionDropTarget } from './use-session-drop-target';
import { ProjectBadge } from './remote-host-chip';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { SidebarIdentityCard, sidebarIdentityCard, useSidebarIdentityCardTrigger } from './sidebar-identity-card';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import type { SidebarJoin } from '@/lib/sidebarJoinedGroups';
import { mountedSessionPresentation, type RemoteSidebarSession } from './sidebar-store';
import { sessionPresentation, sessionReading } from '@/mobile/agent-watch/watch-status';
import { useShownAgentStatus } from '@/components/chat/useAgentsOnCloudComputer';
import { withMountedSession } from './with-mounted-session';
import { useSessionSchedules } from '@renderer/features/automations/use-session-schedules';
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';
import { sessionScheduleDigest } from '@shared/core/automations/session-schedule';

// @@@sessionpage otty-state — sidebar CONVERSATION row, hanging directly under its project (spec
// session-page: conversations ARE the sessions; tasks are an invisible workspace container). A
// session-family attention dot is the row-level state that survives root-based grouping. Clicking
// navigates to the owning task and opens THIS conversation's tab (same mechanism as the
// OS-notification focus path).
//
// behavior session-page「会话列表与状态」: 行首挂 harness 身份图标(owner 2026-09-05 拍,推翻此前
// 那句「会话行不显示 provider 图标」)。标的是**跑这条会话的 harness**(Claude Code / Codex /
// …),不是模型 —— 一眼看出这条会话归谁跑。图标随 agent 元数据来,拿不到就整个不渲染:不留占位
// 方块,也就不会在元数据还没到时先撑出一列、到了再塌回去。
export type SidebarSessionItemProps = {
  projectId: string;
  sessionId: string;
  /** 'tree' nests under a project; 'section' rows (Pinned / Tasks) sit flush left. */
  rowVariant?: 'tree' | 'section';
  depth?: number;
  /** 父会话所在的项目(挂在父会话下的行才有),用来判断这一行要不要挂机器标记。 */
  parentProjectId?: string;
  hasChildren?: boolean;
  expanded?: boolean;
  needsAttention?: boolean;
  onToggle?: () => void;
  /** 拼在一屏的一组里:这一行是框的哪一段。 */
  join?: SidebarJoin;
};

/** 侧栏里的一条会话(#6264 别的机器上的会话也是这一行:同一张会话表、点开同一个任务视图)。 */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  projectId,
  sessionId,
  rowVariant = 'tree',
  depth = 0,
  parentProjectId,
  hasChildren = false,
  expanded = false,
  needsAttention = false,
  onToggle,
  join,
}: SidebarSessionItemProps) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  const { data: agents } = useAgents();
  const { translate } = useSessionMessages();
  const shownStatus = useShownAgentStatus();
  const assistantName = useAssistantShell()?.assistant?.display_name ?? null;
  // 这一行是谁 —— 指针停在行上,右侧弹出身份卡(#6092;任务名 / 设备 / 文件夹,点一行复制「标签：值」)。
  // 它取代了 #5818 那次「标题就地翻成 agent 名」。会话 ID 不在卡上,在下面右键菜单的「复制会话 ID」。
  // 设置里关掉 = 用户不要这个行为 → 连倒计时都不起。名字是会话的 title(任务只有一个名字)。
  const identityCardEnabled = sidebarStore.agentNameOnHoverEnabled;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const rowAnchor = useCallback(() => rowRef.current, []);
  const identityCard = useSidebarIdentityCardTrigger(sessionId, identityCardEnabled);
  const identityCardOpen = identityCardEnabled && sidebarIdentityCard.activeSessionId === sessionId;
  const agentBinding = sessionAgentBindings.bindingFor(sessionId);
  const nestDrop = useSessionDropTarget();

  // 挂着的会话读它自己的 store;别的机器上还没挂的读会话目录那一行(列出不挂载,见 sidebar-store)。
  const session = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const listed = sidebarStore.remoteSession(projectId, sessionId);
  const machine = machineRegistry.machineOf(projectId);
  // 它给自己排的定时,一台机器一个来源:本机的问本机(automation:* 事件驱动);别的机器上的(挂没挂着都一样)读那台机器
  // 推来的会话目录里那一格 —— 与置顶、未读同一条腿,❌ 再为挂着的那几条各开一条跨网问答。
  const localSchedules = useSessionSchedules(null, sessionId, machine === null);
  if (!session && !listed) return null;
  const schedule =
    machine === null
      ? sessionScheduleDigest(localSchedules)
      : (listed ?? sidebarStore.remoteSession(projectId, sessionId))?.summary.schedule;
  const row = session ? rowOfStore(session, schedule) : rowOfListing(listed!);
  const agentUserId = agentBinding?.agentUserId ?? listed?.summary.agent?.userId;
  const presentation = shownStatus.presentation(agentUserId, session
    ? mountedSessionPresentation(session, agentUserId)
    : sessionPresentation(listed!.summary, listed!.live, agentUserId));
  const sessionIsActive =
    currentView === 'session' && params.sessionId === sessionId && params.projectId === projectId;
  const sessionView = getSessionView(projectId, sessionId);
  // Active = this conversation's tab is the focused pane's active tab — kind differs by
  // conversation type ('conversation' for PTY, 'acp-chat' for ACP), so check both.
  const focusedPane = sessionIsActive ? sessionView?.paneLayout.focusedPane : undefined;
  const activeConvId = focusedPane ? focusedSessionId(focusedPane) : undefined;
  const isActive = activeConvId === sessionId;

  const providerId = row.providerId;
  const harness = agents?.find((agent) => agent.id === providerId);
  // #6206:没有状态源(终端腿 + 这一家 hooks 为 none)的会话,宿主不陈述任何一态 ⇒ 行上如实说「状态不可用」。
  // 只在 status 为 null 时出现:provider 阻塞等确定事实写出的状态照常优先。
  const statusUnavailable =
    !agentUserId && row.status === null &&
    harness !== undefined &&
    !hasStatusSource({ runtime: row.runtime, hooksKind: harness.capabilities.hooks.kind });
  const title = formatSessionTitleForDisplay(providerId, row.title);

  // spec session-fork-share: fork 自谁 = 父会话此刻的名字,从父会话自己的 store 读(❌ 存一份副本);
  // 父会话没挂上就不写名字。名字可能很长 → tooltip 里截断,否则在窄侧栏竖成一条。
  const forkParent = row.forkedFromSessionId
    ? sessionRegistry.get(row.forkedFromSessionId)?.sessions.get(row.forkedFromSessionId)
    : undefined;
  const forkedFromTitle = forkParent
    ? formatSessionTitleForDisplay(forkParent.data.providerId, forkParent.data.title)
    : undefined;
  const forkedFromLabel =
    forkedFromTitle && forkedFromTitle.length > 20
      ? `${forkedFromTitle.slice(0, 20)}…`
      : forkedFromTitle;

  const launchedByAssistant = sidebarStore.launchedByAssistant(projectId, sessionId);
  const spawnedByExtensionId = row.spawnedByExtensionId;
  const spawnedByExtensionLabel = spawnedByExtensionLabelFor({
    extensionId: spawnedByExtensionId,
    installedName: spawnedByExtensionId
      ? installedExtensionsStore.appName(spawnedByExtensionId)
      : undefined,
    manifestsLoaded: installedExtensionsStore.isLoaded,
  });

  const openSession = ({ beside = false }: { beside?: boolean } = {}) => {
    // behavior session-page「键盘导航」: the highlight is the cursor, so a click moves the cursor too —
    // pressing ↓ right after clicking must continue from the row you just clicked.
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'conversation', projectId, sessionId });
    // ⌘ 点 = 并排放在正看着那块的右边(spec session-page「一屏几块」);只在看这屏的视图上才有「正看着那块」。
    if (beside && isScreenView(appState.navigation.currentViewId)) {
      // The block is placed only once the task can open: one that never gets ready leaves nothing behind.
      openSessionInSessionWhenReady({ projectId, sessionId, onReady: () => showSessionBeside({ projectId, sessionId }) });
      return;
    }
    navigate('session', { projectId, sessionId: sessionId });
    openSessionInSessionWhenReady({ projectId, sessionId });
  };

  const cursor = sessionKeyboardNav.cursor;
  const isCursor = cursor?.kind === 'conversation' && cursor.sessionId === sessionId;
  const isPendingArchive = sessionKeyboardNav.pendingArchiveSessionId === sessionId;

  // spec session-graph:标签写「归档任务」——用户心智里会话列表的这一行就是一项任务(owner 2026-09-11)——
  // 而动的是**这条会话**:行尾 hover 那个按钮与右键那一格是同一个动作、同一条确认、同一条主进程链路。
  // 带走多少条由确认框里那个勾选说,❌ 不挂在菜单标签上(owner 2026-09-09)。确认、范围与失败处理都在
  // archive-session-flow 里,与会话页 ⋯ 菜单、命令面板同一条。
  const archiveLabel = translate('task.archiveTaskTitle');
  const requestArchive = () => withMountedSession(projectId, sessionId, () => requestArchiveSession({ projectId, sessionId }));

  const isPinned = row.isPinned;
  // 右键给不给「从这一组拿出来 / 拆开这一组」= 这一行在不在框里。
  const grouped = join !== undefined;
  const setPinned = (pinned: boolean) => {
    withMountedSession(projectId, sessionId, (_session, manager) => void manager.setSessionPinned(sessionId, pinned));
  };

  // spec session-fork-share:「任意会话可 fork」—— pty 与 ACP 两种 runtime 都摆这个入口,
  // 各走各的分叉动作(pty `--fork-session`,ACP `session/fork`)。仍然 provider-gated:
  // 这一家没有分叉能力,分叉就无从谈起。
  const canFork =
    agents?.find((agent) => agent.id === providerId)?.capabilities.sessions.fork === 'supported';

  // #7334 会话 ID 平时不摆出来(身份卡只给名字),要的人从右键主动拿。复制**完整** ID:菜单里没有显示宽度
  // 的顾虑,截断的 ID 拿去寻址什么也找不到。菜单点完就收,失败原因去敏后显示并记录。
  const copySessionId = async () => {
    try {
      await platform.writeClipboardText(sessionId);
      toast({ title: translate('sidebar.sessionIdCopied') });
    } catch (error) {
      log.error({ error, sessionId }, 'sidebar copy session id failed');
      toast({ title: translate('task.copyFailed'), description: safeFailureLine(String((error as Error)?.message ?? error)), variant: 'destructive' });
    }
  };

  const handleFork = () => {
    // The fork's own task reuses the source task's workspace, which exists only once the source
    // task is provisioned — navigate first, fork when ready, then open the fork in its own task.
    navigate('session', { projectId, sessionId: sessionId });
    when(
      () =>
        Boolean(asProvisioned(getSessionPageStore(projectId, sessionId)) && sessionRegistry.get(sessionId)),
      () => {
        void sessionRegistry
          .get(sessionId)
          ?.forkSession(sessionId)
          .then((created) => {
            // #6269 分叉住在自己的新任务里 —— 去那项任务打开,❌ 在来源任务里开。
            navigate('session', { projectId, sessionId: created.id });
            openSessionInSessionWhenReady({
              projectId,
              sessionId: created.id,
            });
          })
          .catch((error: unknown) => {
            toast({
              title: translate('sidebar.forkFailed'),
              description: messageForUser(error),
              variant: 'destructive',
            });
          });
      },
      {
        timeout: 15_000,
        onError: () => {
          toast({
            title: translate('sidebar.forkFailed'),
            description: translate('sidebar.workspaceNotReady'),
            variant: 'destructive',
          });
        },
      }
    );
  };


  // 另一条会话拖到这一行上 = 挂到这一条下面(spec session-page「把会话拖成 child」)。挂不上的不给落点:
  // 它自己、已经挂在这里的、以及这一行就在它下面的(挂上去成环)。
  const nestHere = nestDrop.bind(
    (dragged) =>
      dragged.sessionId !== sessionId &&
      sidebarStore.parentOf(dragged.sessionId) !== sessionId &&
      !sidebarStore.isWithin(sessionId, dragged.sessionId),
    (child) => moveSessionUnder(child, { projectId, sessionId, title }, sidebarStore.parentOf(child.sessionId))
  );

  // @@@done-unread 「做完未读」= idle + 未 seen —— 表达方式见 sidebar-session-row。
  const doneUnread = agentUserId ? presentation?.emphasis === true : row.status === 'idle' && !row.seen;

  // owner 10-28:会话列表里不标机器(机器只在悬停卡里写)。只剩一样:挂在父会话下、与父会话不在同一个项目行的 child 标它的项目。
  const projectLabel =
    parentProjectId !== undefined ? sidebarStore.nestedProjectLabel(projectId, parentProjectId) : null;
  const badge = projectLabel ? <ProjectBadge label={projectLabel} /> : null;

  const badges = (
    <>
      {badge}
      {row.statusSourceFault !== null ? (
        // spec hook-status-derivation「打断边:会话在场文件」:声明了的状态来源读不出 —— 任务照常,只是按 Esc
        // 打断后状态可能不更新。与 fork / 助理那两条同一个形状:前缀小图标,hover 出原因。
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex shrink-0 items-center text-[var(--warn)]" data-testid="sidebar-status-source-fault">
                <AlertTriangle className="size-3" />
              </span>
            }
          />
          <TooltipContent className="max-w-80 whitespace-normal">
            {translate('sidebar.statusSourceFault')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {row.forkedFromSessionId !== undefined ? (
        // spec session-fork-share: fork 会话挂一个 fork 图标(前缀,避开右侧 hover 浮出的
        // 置顶/归档动作),hover 才弹出「fork 自 ×」谱系 —— 不占行宽,不论从哪个入口 fork。
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex shrink-0 items-center text-foreground-tertiary-passive" data-testid="sidebar-forked-from">
                <GitFork className="size-3" />
              </span>
            }
          />
          <TooltipContent className="whitespace-nowrap">
            {translate('sidebar.forkedFrom', { source: forkedFromLabel ?? '' })}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {launchedByAssistant ? (
        // #7199 个人助理派出来的任务(它自己的会话不在任务区):与上面两条同一个形状,hover 出「助理 X 发起」。
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex shrink-0 items-center text-foreground-tertiary-passive" data-testid="sidebar-launched-by-assistant">
                <Sparkles className="size-3" />
              </span>
            }
          />
          <TooltipContent className="whitespace-nowrap">
            {translate('sidebar.launchedByAssistant', { name: assistantName ?? '' })}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {spawnedByExtensionLabel ? (
        // behavior tab-extensions「agent 的可见与可控」:扩展起的会话,会话图上要能
        // 表示「由这个扩展发起」;扩展卸载后标记留存,显示为「由已卸载的扩展 X 发起」。
        // 形状照 fork 那条来 —— 前缀小图标 + hover 才出文字,不占这 28px 行的宽度。
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex shrink-0 items-center text-foreground-tertiary-passive">
                <LayoutGrid className="size-3" />
              </span>
            }
          />
          <TooltipContent className="whitespace-nowrap">{spawnedByExtensionLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );

  return (
    <SessionRowShell
      rowRef={rowRef}
      sessionId={sessionId}
      rowVariant={rowVariant}
      depth={depth}
      hasChildren={hasChildren}
      expanded={expanded}
      needsAttention={needsAttention}
      onToggle={onToggle}
      title={title}
      harness={harness ? { id: providerId, name: harness.name } : null}
      badges={badges}
      presentation={presentation}
      statusUnavailable={statusUnavailable}
      lastInteractedAt={row.lastInteractedAt}
      schedule={row.schedule ?? null}
      doneUnread={doneUnread}
      isActive={isActive}
      isCursor={isCursor}
      isPendingArchive={isPendingArchive}
      isNestTarget={nestDrop.over}
      join={join}
      quickActions={{ isPinned, onSetPinned: setPinned, archiveLabel, onArchive: requestArchive }}
      onOpen={openSession}
      rowProps={{
        // 这一行可以拖进 composer 变成一枚 @ 提及(behavior session-page「把会话拖成 @」)。
        // ⚠️ 因此这里**不能**再 `onMouseDown preventDefault` —— 它原本只为「点这一行不抢焦点」
        // 而设,但拦掉 mousedown 的默认动作同时也拦掉了浏览器发起原生拖拽(headless Chromium
        // 实测:拦了就连 dragstart 都不发)。行内那枚标题按钮同理,见 allowNativeDrag。
        draggable: true,
        onDragStart: (e) => {
          // 拖起来就不是在看这张卡了。
          identityCard.dismiss();
          // 带上项目:落在一块的边上时,分出来的那块要开这条会话的页(spec session-page「一屏几块」)。
          setDraggedScreenContent(e.dataTransfer, { kind: 'session', sessionId, title, projectId }, e.currentTarget);
        },
        onDragEnd: clearDraggedScreenContent,
        ...nestHere,
        onPointerEnter: identityCard.onPointerEnter,
        onPointerLeave: identityCard.onPointerLeave,
        onPointerDown: identityCard.onPointerDown,
        onContextMenu: identityCard.dismiss,
      }}
      after={
        identityCardOpen ? (
          <SidebarIdentityCard
            projectId={projectId}
            sessionId={sessionId}
            title={title}
            anchor={rowAnchor}
            onDismiss={identityCard.dismiss}
          />
        ) : null
      }
      menu={
        <>
    {/* spec session-page「拼在一屏的几块是一组」:框里一行 = 拿它出来 / 整组拆开(照 Arc「Separate from Split View」)。 */}
    {grouped ? (
      <>
        <ContextMenuItem onClick={() => takeSessionOutOfGroup(sessionId)}>
          <SquareMinus className="size-4" />
          {translate('sidebar.leaveGroup')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => dissolveScreenGroup(sessionId)}>
          <Scissors className="size-4" />
          {translate('sidebar.dissolveGroup')}
        </ContextMenuItem>
        <ContextMenuSeparator />
      </>
    ) : null}
    {isPinned ? (
      <ContextMenuItem onClick={() => setPinned(false)}>
        <PinOff className="size-4" />
        {translate('task.unpin')}
      </ContextMenuItem>
    ) : (
      <ContextMenuItem onClick={() => setPinned(true)}>
        <Pin className="size-4" />
        {translate('task.pin')}
      </ContextMenuItem>
    )}
    {canFork && (
      <ContextMenuItem onClick={handleFork}>
        <GitFork className="size-4" />
        {translate('sidebar.forkSession')}
      </ContextMenuItem>
    )}
    {/* behavior session-page「键盘导航」: 键盘能做的、菜单也要能做 —— 只给快捷键等于让用鼠标的人
        看不见重命名。删除是这条规则的例外(owner 2026-09-05 把它从这份菜单里拿掉了):它在
        会话页 ⋯ 菜单里仍然可见可点,不是只剩快捷键。 */}
    <ContextMenuItem
      onClick={() => {
        commandRegistry.dispatch('session.rename', { projectId, sessionId });
      }}
    >
      <Pencil className="size-4" />
      {translate('task.renameSession')}
    </ContextMenuItem>
    <ContextMenuItem onClick={() => void copySessionId()}>
      <Copy className="size-4" />
      {translate('sidebar.copySessionId')}
    </ContextMenuItem>
    {/* owner 2026-09-05:会话列表这一行不再提供删除 ——「正常我用 agent 也不删除会话」。
        右键这一格换成归档,与行尾 hover 浮出的归档按钮是同一个动作、同一条确认路径。
        删除仍在会话页 ⋯ 菜单与键盘两次删除上,只是不再摆在会话列表的手边。 */}
    <ContextMenuItem onClick={requestArchive}>
      <Archive className="size-4" />
      {archiveLabel}
    </ContextMenuItem>
        </>
      }
    />
  );
});

type SessionInRegistry = NonNullable<ReturnType<NonNullable<ReturnType<typeof sessionRegistry.get>>['sessions']['get']>>;

/** 一行要画的东西:挂着的会话与会话目录里的一行,两种来路同一个形状。 */
type SidebarRowData = {
  providerId: string;
  title: string;
  status: SessionInRegistry['status'];
  detail: SessionInRegistry['detail'];
  seen: boolean;
  runtime: 'acp' | 'pty';
  isPinned: boolean;
  lastInteractedAt: string | null | undefined;
  /** fork 来源会话:目录里没有,点开(挂上)之后才显示。 */
  forkedFromSessionId: string | undefined;
  spawnedByExtensionId: string | null | undefined;
  /** 声明了的状态来源读不出(spec hook-status-derivation「打断边:会话在场文件」):一句原因。 */
  statusSourceFault: string | null;
  /** 它给自己排的定时;null = 没有,undefined = 不知道(老宿主的目录行),两种都不画。 */
  schedule: SessionpageScheduleDigest | null | undefined;
};

function rowOfStore(session: SessionInRegistry, schedule: SessionpageScheduleDigest | null | undefined): SidebarRowData {
  return {
    providerId: session.data.providerId,
    title: session.data.title,
    status: session.status,
    detail: session.detail,
    seen: session.seen,
    runtime: session.data.runtime ?? 'pty',
    isPinned: session.data.isPinned === true,
    lastInteractedAt: session.data.lastInteractedAt,
    forkedFromSessionId: session.data.forkedFrom?.sessionId,
    spawnedByExtensionId: session.data.spawnedByExtensionId,
    statusSourceFault: session.statusSourceFault,
    schedule,
  };
}

/** Metadata plus identity-free task readings; identified agents use presence above. */
function rowOfListing({ summary }: RemoteSidebarSession): SidebarRowData {
  const reading = summary.agent?.userId ? null : sessionReading(summary);
  return {
    providerId: summary.harness,
    title: summary.title,
    status: (reading?.status ?? null) as SessionInRegistry['status'],
    detail: (reading?.detail ?? null) as SessionInRegistry['detail'],
    seen: summary.unseen !== true,
    runtime: summary.runtime === 'acp' ? 'acp' : 'pty',
    isPinned: summary.isPinned === true,
    lastInteractedAt: summary.lastInteractedAt,
    forkedFromSessionId: undefined,
    spawnedByExtensionId: summary.spawnedByExtensionId,
    // 会话级标注只随本机写入者的状态输出到达;目录里另一台机器的行没有(与 providerBlocker 一样)。
    statusSourceFault: null,
    schedule: summary.schedule,
  };
}
