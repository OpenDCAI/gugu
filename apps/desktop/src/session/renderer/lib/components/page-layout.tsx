import { ExternalLink } from '@/lib/icons'
import React from 'react';
import { cn } from '@renderer/utils/utils';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

import { STATE_LAYERS } from '@renderer/lib/ui/state-layers';

export type PageSidebarItem<T extends string = string> = {
  id: T;
  label: string;
  isExternal?: boolean;
  /** 右边的小数字徽标(比如「有几个扩展要注意」,#5410);省略或 0 都不画。 */
  badge?: number;
};

export function PageSidebarMenu<T extends string>({
  title,
  header,
  items,
  activeId,
  onSelect,
}: {
  /**
   * 这一页的名字(设置 / 资源库),画成这列的列头。
   *
   * ❌ 别把它放回顶上那条 40px 窗口带里 —— 那条带是**窗口 chrome**,页名跟着它会比屏幕上其他
   * 所有东西高一截、和红绿灯一排(owner 2026-09-15:「这个是不是太靠上了」);而且那条带是
   * 浮层,页名会直接压在这列第一项上。放在这里,它和右边的页标题同一条基线(两边都从 40px 起)。
   */
  title?: string;
  /**
   * 列头下、各项之上的一格:管着下面**每一项**的那个范围(资源库的机器选择器,#6264)。
   * owner:「设备是资源库级别的」⇒ 只在这里一个,❌ 各子页标题旁各摆一个。
   */
  header?: React.ReactNode;
  items: ReadonlyArray<PageSidebarItem<T>>;
  activeId: T;
  onSelect: (item: PageSidebarItem<T>) => void;
}) {
  return (
    <div className="sticky top-0 self-start py-10 [-webkit-app-region:drag]">
      {title ? (
        <div className="gg-type-page-title px-3 pb-3 [-webkit-app-region:drag]">{title}</div>
      ) : null}
      {header ? (
        <div className="w-36 pb-3 [-webkit-app-region:no-drag]" data-slot="page-sidebar-header">
          {header}
        </div>
      ) : null}
      <nav className="flex min-w-28 flex-col gap-0.5 [-webkit-app-region:no-drag]">
        {items.map((item) => {
          const isActive = item.id === activeId && !item.isExternal;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-normal text-foreground-muted transition-colors hover:bg-row-hover active:bg-row-press hover:text-foreground',
                isActive &&
                  `bg-background-2 text-foreground hover:bg-background-2 active:bg-background-2 ${STATE_LAYERS} hover:text-foreground`
              )}
            >
              <span className="flex-1 text-left">{item.label}</span>
              {Boolean(item.badge) && (
                <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-background-destructive px-1 text-tiny font-medium text-foreground-destructive">
                  {item.badge}
                </span>
              )}
              {item.isExternal && <ExternalLink className="h-4 w-4" />}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/** 一页的数据第一次还没取回来:占住内容区画加载态,❌ 先画一句「没有…」冒充它是空的。 */
export function PageLoading() {
  const { translate } = useSessionMessages();
  return (
    <div className="flex min-h-64 items-center justify-center text-foreground-muted">
      <LoadingIndicator ariaLabel={translate('task.loading')} />
    </div>
  );
}

export function PageContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full max-w-4xl px-4', className)}>{children}</div>;
}

export function PageLayout({
  sidebar,
  children,
}: {
  /** 省略 = 这一页没有左边那列分栏,内容自己占满(资源库现在只有一项)。 */
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="h-full scrollbar-gutter-stable overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full max-w-[1060px] px-8">
          {/* The menu column takes the width of its longest label (floor 7rem), not a
              fixed 13rem: with two-character Chinese labels a fixed column left a
              ~160px blank band between the menu and the page (#5265 review). */}
          <div
            className={cn(
              'grid w-full',
              sidebar ? 'grid-cols-[auto_minmax(0,1fr)] gap-8' : 'grid-cols-[minmax(0,1fr)]'
            )}
          >
            {sidebar}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
