import { Archive, Pin, PinOff } from '@/lib/icons'
import React from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { AgentStatusGlyph } from '@renderer/lib/components/agent-status-indicator';
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import {
  SidebarMenuAction,
  SidebarMenuRow,
  sidebarDropTargetClass,
  sidebarRowActionsSlotClass,
  sidebarRowHoverActionsClass,
  sidebarRowRestActionsClass,
} from './sidebar-primitives';
import { sidebarRowInsetPx } from './sidebar-row-metrics';
import { SidebarTwistyLane } from './sidebar-twisty';
import type { SidebarJoin } from '@/lib/sidebarJoinedGroups';
import { SidebarSessionTitle } from './sidebar-session-title';
import { SidebarScheduleHoverMark, SidebarScheduleMark } from './sidebar-schedule-badge';
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';

// 侧栏一行会话的**外观**。本机会话(sidebar-session-item)与别的机器上的会话
// (#6264,sidebar-remote-conversation-item)共用这一份 —— 行长得一模一样,只有数据来源和动作落点不同。
// ❌ 给远端另抄一份行:两份迟早分叉(行高、浮层底色、命中区这些都是 owner 逐条实机校过的)。

export type SessionRowQuickActions = {
  isPinned: boolean;
  onSetPinned: (pinned: boolean) => void;
  archiveLabel: string;
  onArchive: () => void;
};

export type SessionRowShellProps = {
  rowRef?: React.Ref<HTMLDivElement>;
  sessionId: string;
  /** 'tree' nests under a project; 'section' rows (Pinned / Tasks) sit flush left. */
  rowVariant: 'tree' | 'section';
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  needsAttention: boolean;
  onToggle?: () => void;
  title: string;
  /** 跑这条会话的 harness;拿不到就整个不渲染(不留占位方块)。 */
  harness: { id: string; name: string } | null;
  /** 标题前的小图标(fork 谱系 / 扩展发起),hover 才出文字。 */
  badges?: React.ReactNode;
  /** The canonical presentation; this shell never derives running state. */
  presentation: AgentStatusPresentation | null;
  /**
   * #6206 没有状态源(终端腿 + 这一家 hooks 为 none)的会话:宿主不陈述任何一态 ⇒ 行上如实说「状态不可用」。
   * 只在 status 为 null 时由调用方给:provider 阻塞等确定事实写出的状态照常优先。
   */
  statusUnavailable?: boolean;
  lastInteractedAt: string | null | undefined;
  /**
   * 它给自己排的定时(#7221)。行尾那一格:没有别的状态标志时(空闲)盖掉那个时间,有就让位(owner 10-19 C)。
   * null / 缺席 = 没有。
   */
  schedule?: SessionpageScheduleDigest | null;
  doneUnread: boolean;
  isActive: boolean;
  isCursor: boolean;
  isPendingArchive: boolean;
  /** 另一条会话正拖在这一行上、松手就挂到它下面:这一行罩上落点那层(同这屏分块的落点)。 */
  isNestTarget?: boolean;
  /** 行尾 hover 浮出的「置顶 / 归档」;null = 这一行此刻做不了(机器离线),整层不出。 */
  quickActions: SessionRowQuickActions | null;
  /** 点不开的行灰掉(机器离线 / 记录读不了);`disabledReason` 放进 title。 */
  disabled?: boolean;
  disabledReason?: string;
  /** ⌘ / Ctrl 点 = 并排打开(spec session-page「一屏几块」);键盘 Enter 不带它。 */
  onOpen: (options?: { beside?: boolean }) => void;
  /** 行上额外的属性(拖成 @、身份卡指针事件……),原样挂到行上。 */
  rowProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  /** 挂在行后面、同一个右键触发区里的东西(身份卡)。 */
  after?: React.ReactNode;
  /** 右键菜单的条目;没有就不出菜单。 */
  menu?: React.ReactNode;
  /** 拼在一屏的一组里:这一行是框的哪一段(spec session-page「拼在一屏的几块是一组」)。 */
  join?: SidebarJoin;
};

const quickActionButtonClass =
  'flex size-6 items-center justify-center rounded-sm bg-transparent text-foreground-tertiary-passive transition-colors hover:text-foreground active:text-foreground focus-visible:text-foreground';

// 行是 draggable(拖成 @),按钮在行里:按下后指针挪过浏览器的拖拽阈值(几个像素)就成了拖这一行,
// click 被吞掉。取消 mousedown 的默认动作 = 从这枚按钮上不发起原生拖拽,click 照常到。
const quickActionMouseDown = (e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

export function SessionRowShell({
  rowRef,
  sessionId,
  rowVariant,
  depth,
  hasChildren,
  expanded,
  needsAttention,
  onToggle,
  title,
  harness,
  badges,
  presentation,
  statusUnavailable = false,
  lastInteractedAt,
  schedule = null,
  doneUnread,
  isActive,
  isCursor,
  isPendingArchive,
  isNestTarget = false,
  quickActions,
  disabled = false,
  disabledReason,
  onOpen,
  rowProps,
  after,
  menu,
  join,
}: SessionRowShellProps) {
  const { translate } = useSessionMessages();

  // @@@sidebar-ink-tiers (owner 2026-09-05,以 Codex 实测为准) — Codex 是三档墨色:
  // 列表正文 #191C1F > 菜单键/项目行 #3B3E40 > 区段标题 #A8A9A9。会话标题是最深那一档,
  // 所以这里单独抬到 text-foreground(皮肤下 = --text-primary #171717,与 #191C1F 基本重合);
  // 行本身仍是中间档 -rest(#3C3C3C),对应 Codex 的菜单键。
  // @@@done-unread 「做完未读」= idle + 未 seen,是正交属性不是状态(spec agent-status):只用字重与
  // 时间墨色表达,❌ 不画点。seen=0 只由回合结束那条边写出,所以这里不会把出生 / 退出的 idle 加粗。
  // 点不开的行(#6264 机器离线)退到被动墨色 —— 列着、看得见,但一眼读得出「此刻点不动」。
  // 这一行的状态画成什么:与聊天、手机同一个 presentAgentStatus(#6448 owner 定表)。
  // 行尾那一格画的是定时那枚钟吗(owner 10-19 C:空闲时盖掉时间,别的状态的标志优先)。与下面那条状态链同一个次序。
  const scheduleAtRest =
    schedule != null &&
    presentation?.tone !== 'error' &&
    presentation?.tone !== 'needs_user' &&
    !needsAttention &&
    !statusUnavailable &&
    presentation?.tone !== 'running' && presentation?.tone !== 'parked';
  const titleClass = cn(
    'text-left',
    disabled ? 'text-foreground-passive' : 'text-foreground',
    doneUnread && 'font-medium',
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          ref={rowRef}
          className={cn(
            'group/row flex h-8 items-center justify-between gap-1 pr-1',
            isNestTarget && sidebarDropTargetClass
          )}
          data-nest-target={isNestTarget || undefined}
          style={{ paddingInlineStart: `${sidebarRowInsetPx(rowVariant, depth)}px` }}
          isActive={isActive}
          isCursor={isCursor}
          isPendingArchive={isPendingArchive}
          data-session-id={sessionId}
          data-depth={depth}
          data-join={join?.pos}
          data-join-on={join?.onScreen || undefined}
          data-needs-attention={needsAttention || undefined}
          data-agent-tone={presentation?.tone}
          data-disabled={disabled || undefined}
          aria-disabled={disabled || undefined}
          title={disabled ? disabledReason : undefined}
          tabIndex={0}
          role="treeitem"
          {...rowProps}
          onClick={(event) => onOpen({ beside: event.metaKey || event.ctrlKey })}
          onKeyDown={(e) => {
            // Arrow keys are owned by the session navigation listener, which walks the whole chain.
            // The per-row nextElementSibling walk that used to live here could never work: the row
            // is wrapped by ContextMenuTrigger (so it has no sibling) and the list is virtualised
            // (so off-screen rows have no node to focus).
            if (e.key === 'Enter') onOpen();
          }}
        >
          {/* 折叠箭头的车道 —— 与项目行同一个原语、同一条车道,两条纪律都写在 sidebar-twisty.tsx。 */}
          <SidebarTwistyLane
            expanded={expanded}
            label={translate(expanded ? 'sidebar.collapseChildSessions' : 'sidebar.expandChildSessions')}
            onToggle={hasChildren ? () => onToggle?.() : undefined}
          />
          <SidebarMenuAction
            aria-label={translate('sidebar.openConversation', { title })}
            className="gap-1.5 overflow-hidden"
            allowNativeDrag
          >
            {harness ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className={cn('flex shrink-0 items-center', disabled && 'opacity-60')}>
                      <AgentIcon id={harness.id} size={14} />
                    </span>
                  }
                />
                <TooltipContent className="whitespace-nowrap">{harness.name}</TooltipContent>
              </Tooltip>
            ) : null}
            {badges}
            <SidebarSessionTitle title={title} className={titleClass} />
          </SidebarMenuAction>
          {/* @@@5642 这两个按钮在 Tab 序里(没有 tabIndex=-1),所以「只在 hover 时显形」= 键盘用户会停在一个
              看不见的「归档」上、Enter 直接归档。守住它的是**焦点**那一条:Tab 到哪一枚,哪一枚当场现形,
              按不到看不见的按钮。❌ 别改成 tabIndex=-1 了事:归档没有快捷键,那会让键盘上没有归档入口。
              ❌ 也别再把「这一行是键盘光标 / 被选中」加回判据(#5818):点一行就会把键盘光标同步过去,
              那等于让选中的那一行从此常驻两枚钮。显隐的完整配方与两层为什么必须一起改,见
              sidebar-primitives 的 sidebarRowActionsSlotClass。 */}
          {/* Only the visible time/status or action layer reserves width; the shared title observer follows it. */}
          <span data-row-hover-actions className={sidebarRowActionsSlotClass}>
            {/* 命中区(owner 实机:「可点击区域覆盖的不对」):
              · 行高 32px 内直接容纳 24px 按钮,不再用上下 padding 把内容区压成 20px 后靠溢出显示;
              · TooltipTrigger 通过 render 复用唯一按钮,避免外层 trigger button 包住可见 button 后分裂命中区;
              · 只让 opacity 参与过渡。原来连 translate 一起过渡 → hover 后的 120ms 里整层还在左移 4px,
                这段时间点下去落在图标最终位置右边 4px,手感就是「点不到」。位移改为 hover 即到位。
              · 目标 20px → 24px(size-6),与项目行/任务区的同类按钮(SidebarItemMiniButton w-6 h-6)一致;
                两个目标之间 2px → 4px,别让「置顶」和「归档」贴在一起互相抢点击。 */}
            {quickActions ? (
              <span className={sidebarRowHoverActionsClass}>
                {/* 静止时那枚钟在下面那一格(pointer-events-none、一 hover 就淡出),悬停读不到;所以 hover 层里把它接过来,
                    排在置顶 / 归档左边,是它自己的目标:指针停在它上面出 tooltip(下次时间、标题、条数),不和两枚钮抢。 */}
                {scheduleAtRest && schedule ? <SidebarScheduleHoverMark digest={schedule} /> : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={translate(quickActions.isPinned ? 'task.unpinTask' : 'task.pinTask')}
                        className={quickActionButtonClass}
                        onMouseDown={quickActionMouseDown}
                        onClick={(e) => {
                          e.stopPropagation();
                          quickActions.onSetPinned(!quickActions.isPinned);
                        }}
                      >
                        {quickActions.isPinned ? (
                          <PinOff className="size-3.5" />
                        ) : (
                          <Pin className="size-3.5" />
                        )}
                      </button>
                    }
                  />
                  <TooltipContent>
                    {translate(quickActions.isPinned ? 'task.unpin' : 'task.pinTask')}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={quickActions.archiveLabel}
                        className={quickActionButtonClass}
                        onMouseDown={quickActionMouseDown}
                        onClick={(e) => {
                          e.stopPropagation();
                          quickActions.onArchive();
                        }}
                      >
                        <Archive className="size-3.5" />
                      </button>
                    }
                  />
                  <TooltipContent>{quickActions.archiveLabel}</TooltipContent>
                </Tooltip>
              </span>
            ) : null}
            <span className={sidebarRowRestActionsClass}>
              {/* 自己的「需要你」先于子树汇总:否则一条出错的会话只显示「树里有事」那颗黄点,红点永远轮不到。 */}
              {presentation?.tone === 'error' || presentation?.tone === 'needs_user' ? (
                <span className="flex size-5 items-center justify-center">
                  <AgentStatusGlyph presentation={presentation} label={translate(`agentStatus.${presentation.label}`)} variant="2" />
                </span>
              ) : needsAttention ? (
                <span className="flex size-5 items-center justify-center">
                  <span
                    className="size-2 rounded-full bg-[var(--agent-tone-needs-user)]"
                    aria-label={translate('sidebar.sessionTreeNeedsAttention')}
                    title={translate('sidebar.sessionTreeNeedsAttention')}
                  />
                </span>
              ) : statusUnavailable ? (
                <span className="flex size-5 items-center justify-center">
                  <span
                    className="size-2 rounded-full border border-foreground-passive"
                    aria-label={translate('sidebar.statusUnavailable')}
                    title={translate('sidebar.statusUnavailable')}
                    data-status-unavailable
                  />
                </span>
              ) : presentation && (presentation.tone === 'running' || presentation.tone === 'parked') ? (
                <span className="flex size-5 items-center justify-center">
                  <AgentStatusGlyph presentation={presentation} label={translate(`agentStatus.${presentation.label}`)} variant="2" />
                </span>
              ) : scheduleAtRest && schedule ? (
                <SidebarScheduleMark digest={schedule} emphasized={doneUnread} />
              ) : lastInteractedAt ? (
                <RelativeTime
                  value={lastInteractedAt}
                  className={cn(
                    'font-sans text-xs tabular-nums',
                    doneUnread ? 'text-foreground-muted' : 'text-foreground-passive',
                  )}
                  compact
                />
              ) : null}
            </span>
          </span>
        </SidebarMenuRow>
        {after}
      </ContextMenuTrigger>
      {menu ? <ContextMenuContent>{menu}</ContextMenuContent> : null}
    </ContextMenu>
  );
}
