import { AlignJustify } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useState, type MouseEvent, type ReactNode } from 'react';
import type { SidebarListLayout, SidebarListPage } from '@shared/view-state';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { ProjectNeedsYouDot } from './project-row-parts';
import { sidebarHeaderIconButtonClass } from './sidebar-primitives';

// gugu-dev#181「侧栏」:项目和对话默认分开,顶上「项目 | 对话」两枚页签;也能合在一起(右上「显示方式」或在侧栏上右键)。
// 两枚页签一直挂着各自的信号,数只在真读了才减 —— 切页签不算读,所以这里只读数、❌ 在切换时清任何东西。

/** 未读数(红底白字):页签上、项目行尾、合在一起时「对话」分区头上。 */
export function SidebarUnreadCount({ count }: { count: number }) {
  const { translate } = useSessionMessages();
  if (count <= 0) return null;
  return (
    <span
      aria-label={translate('sidebar.unreadCount', { count })}
      className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--badge-red)] px-1 text-[length:var(--font-caption)] leading-none font-semibold text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export const SidebarListSwitch = observer(function SidebarListSwitch({
  projectsUnread,
  chatsUnread,
}: {
  projectsUnread: number;
  chatsUnread: number;
}) {
  const { translate } = useSessionMessages();
  const page = sidebarStore.listPage;
  const tab = (id: SidebarListPage, label: string, signal: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={page === id}
      data-testid={`sidebar-list-page-${id}`}
      onClick={() => sidebarStore.setListPage(id)}
      className={cn(
        'flex h-full flex-1 items-center justify-center gap-1 rounded-md text-sm transition-colors',
        page === id ? 'bg-background font-medium text-foreground shadow-xs' : 'text-foreground-tertiary-muted hover:text-foreground'
      )}
    >
      {label}
      {signal}
    </button>
  );
  return (
    <div role="tablist" className="mb-2 flex h-8 w-full gap-[2px] rounded-lg bg-foreground/[0.06] p-[2px]">
      {tab('projects', translate('sidebar.projects'), (
        <>
          <SidebarUnreadCount count={projectsUnread} />
          <ProjectNeedsYouDot count={sidebarStore.projectsNeedYouCount} />
        </>
      ))}
      {tab('chats', translate('sidebar.chats'), <SidebarUnreadCount count={chatsUnread} />)}
    </div>
  );
});

function LayoutChoices() {
  const { translate } = useSessionMessages();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{translate('sidebar.listLayoutMenu')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={sidebarStore.listLayout}>
        {(['merged', 'split'] as const satisfies readonly SidebarListLayout[]).map((layout) => (
          <DropdownMenuRadioItem key={layout} value={layout} onClick={() => sidebarStore.setListLayout(layout)}>
            {translate(layout === 'merged' ? 'sidebar.listMerged' : 'sidebar.listSplit')}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** 侧栏右上那颗「显示方式」。 */
export const SidebarListLayoutButton = observer(function SidebarListLayoutButton() {
  const { translate } = useSessionMessages();
  return (
    <DropdownMenu>
      <Tooltip>
        <DropdownMenuTrigger
          render={
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={translate('sidebar.listLayout')}
                  data-testid="sidebar-list-layout"
                  className={cn(sidebarHeaderIconButtonClass, '[-webkit-app-region:no-drag]')}
                >
                  <AlignJustify />
                </button>
              }
            />
          }
        />
        <TooltipContent>{translate('sidebar.listLayout')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <LayoutChoices />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/**
 * 在侧栏空白处右键 = 同一份「显示方式」菜单。行自己的右键菜单先接住事件(它会 preventDefault),
 * 那时这里不出第二份。菜单钉在指针那一点上(没有 Trigger,靠 anchor 定位)。
 */
export function useSidebarLayoutContextMenu(): {
  onContextMenu: (event: MouseEvent) => void;
  menu: ReactNode;
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setAt({ x: event.clientX, y: event.clientY });
  };
  const menu = (
    <DropdownMenu open={at !== null} onOpenChange={(open) => !open && setAt(null)}>
      <DropdownMenuContent
        className="min-w-52"
        sideOffset={0}
        anchor={at ? { getBoundingClientRect: () => new DOMRect(at.x, at.y, 0, 0) } : undefined}
      >
        <LayoutChoices />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return { onContextMenu, menu };
}
