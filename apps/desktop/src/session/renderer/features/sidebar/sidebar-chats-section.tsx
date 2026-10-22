import { Plus, UserPlus, Users } from '@/lib/icons';
import { UI_EVENTS } from '@/lib/uiEvents';
import { observer } from 'mobx-react-lite';
import { useRef, type MouseEvent } from 'react';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { useSidebarScrollTargets } from './sidebar-scroll-context';
import { SidebarGroup, sidebarGroupHeaderClass, sidebarHeaderIconButtonClass } from './sidebar-primitives';

// gugu-dev#181「对话」:人、用户群和它们的话题。行是聊天列表那一行原样搬过来(壳那棵树画进这一格),
// 新建群聊、添加联系人的弹窗也是聊天列表那一套 —— 会话页只转达这两个动作,❌ 在这边另写一份。

export type ShellChatAction = 'create-group' | 'add-contact';

export function openShellChatAction(action: ShellChatAction): void {
  window.dispatchEvent(new Event(action === 'create-group' ? UI_EVENTS.openCreateGroup : UI_EVENTS.openAddContact));
}

export const shellChatActions = [
  { action: 'create-group', icon: Users, label: 'sidebar.newGroupChat' },
  { action: 'add-contact', icon: UserPlus, label: 'sidebar.addContact' },
] as const;

/**
 * 「对话」分区。合在一起时它排在项目下面,分区头贴在列表底边:对话那段滚在下面看不见时,头带着未读总数停在底边,
 * 点一下跳过去(gugu-dev#181 ⑮)。是不是贴着看分区头前面那个不贴的哨兵:哨兵在可视区下面 = 头是贴上去的。
 */
export const SidebarChatsSection = observer(function SidebarChatsSection({
  merged,
  unread,
}: {
  merged: boolean;
  unread: number;
}) {
  const { translate } = useSessionMessages();
  const { scroller } = useSidebarScrollTargets();
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const jumpWhenStuck = (event: MouseEvent) => {
    if (!merged || !scroller || !sentinel.current || !header.current) return;
    const natural = sentinel.current.getBoundingClientRect().top;
    if (natural <= scroller.getBoundingClientRect().bottom - header.current.offsetHeight) return;
    event.preventDefault();
    event.stopPropagation();
    if (sidebarStore.chatsCollapsed) sidebarStore.toggleChatsCollapsed();
    scroller.scrollBy({ top: natural - scroller.getBoundingClientRect().top, behavior: 'smooth' });
  };
  const collapsed = sidebarStore.chatsCollapsed;

  return (
    <SidebarGroup className="mb-0 flex flex-col" data-sidebar-chats="">
      <div ref={sentinel} aria-hidden="true" />
      <div
        ref={header}
        onClickCapture={jumpWhenStuck}
        className={cn(sidebarGroupHeaderClass, merged && 'sticky bottom-0 z-10 bg-background-tertiary')}
      >
        <span className="flex items-center gap-1.5">
          <SidebarGroupToggle
            label={translate('sidebar.chats')}
            count={0}
            collapsed={collapsed}
            onToggle={() => sidebarStore.toggleChatsCollapsed()}
            ariaLabel={translate(collapsed ? 'sidebar.expandChats' : 'sidebar.collapseChats')}
          />
          {merged && unread > 0 && (
            <span
              aria-label={translate('sidebar.unreadCount', { count: unread })}
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--badge-red)] px-1 text-[10.5px] font-semibold text-white"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
        {/* 合在一起时没有对话页那两行入口,挪到这颗「+」里,与「项目」头上的「添加项目」对称。 */}
        {merged && (
          <DropdownMenu>
            <Tooltip>
              <DropdownMenuTrigger
                render={
                  <TooltipTrigger
                    render={
                      <button type="button" aria-label={translate('sidebar.newGroupChat')} className={sidebarHeaderIconButtonClass}>
                        <Plus />
                      </button>
                    }
                  />
                }
              />
              <TooltipContent>{`${translate('sidebar.newGroupChat')} / ${translate('sidebar.addContact')}`}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-44">
              {shellChatActions.map(({ action, icon: Icon, label }) => (
                <DropdownMenuItem key={action} onClick={() => openShellChatAction(action)}>
                  <Icon />
                  {translate(label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {/* 聊天列表画进这一格(壳那棵树,经壳的格子 portal 进来)。 */}
      {!collapsed && <div data-region="sidebar-chat-list" className="min-h-0" />}
    </SidebarGroup>
  );
});
