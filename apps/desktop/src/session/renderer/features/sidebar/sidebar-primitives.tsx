import * as React from 'react';
import { cn } from '@renderer/utils/utils';

/**
 * @@@sidebar-inset-single-source (#3480) — 侧栏横向留白的唯一出处。
 *
 * 侧栏的留白归 **list body**(`SidebarMenu` 及承担同一角色的滚动容器),不归行。
 * 「这一组离侧栏边多远」因此只有这一个答案,每个 list body 引用它,而不是各写一遍同一个字面量。
 *
 * 行为什么不自己写横向内距:因为「这一组离侧栏边多远」只应有一个答案。两个行各写一遍同一个
 * 字面量与一个字面量被引用两遍,读起来一样、改起来不一样 —— 前者会在下一次调整时分叉。
 *
 * ⚠️ 而且**行也吃不下**:`sidebarMenuItemClass` 用在 `<button>` 上,Tailwind preflight 的
 * `button { padding: 0 }` 会把写在按钮自己身上的 `px-*` 抹平(2026-09-05 实测:给行加 `px-2`
 * 之后,搜索行那个 `<div>` 量到 8、`新建任务` 那个 `<button>` 量到 0)。#3512 修好的是
 * session-chat-ui 那条**未分层**的 reset,不是这一条。❌ 别再试图把留白搬回行。
 */
export const sidebarGroupInsetX = 'px-3';

/**
 * 内容列 —— 侧栏里所有可读内容的左缘,list body 之内再让开 8px(合计 20px)。
 *
 * 这不是新发明的数,是侧栏**本来就在用**的那一列:三个分区标题(`pl-5`)算出来落在 20px 上。
 * 唯独顶部那一组动作行(搜索 / 新建任务 / 导入会话 / 已安排 / 设置)的图标停在 list body 的
 * 边上(12px),于是整组比它下面的所有东西向左突出 8px —— owner 圈的「不统一」就是这 8px。
 *
 * ⚠️ **树里的行(项目行 / 会话行 / 状态分组标题)不在这一列上了**(2026-09-07,owner 拍板给折叠
 * 箭头开恒宽车道,并要求项目行与会话行同形)。它们让出车道之后落在更右边,数由
 * `sidebar-row-metrics.ts` 算,❌ 别把它们改回来对齐这里 —— 那等于把车道又填掉。
 * 这一列现在管的是**分区级**的东西:分区标题,以及顶部/底部那几行动作。
 *
 * 行本身吃不下内距(见上),所以它加在行内的**内容容器**上:底色与光标 ring 仍然铺满整行,
 * 内容对齐到公共列。
 */
export const sidebarRowContentInsetX = 'pl-2';

/**
 * 分区头(置顶 / 项目 / 任务)的外框。
 *
 * `pl-5` = 内容列(list body 12 + 8);`pr-2` 让右侧那枚 size-6 小钮里的 16px 字形右缘
 * 落在 12px 上 —— 与搜索行右端的 ⌘K 键帽、设置行右端的键帽同一条竖线(8 + (24-16)/2 = 12)。
 * 三个分区头引用同一个常量,❌ 各写一遍。`group/ghdr` 是分区头的 hover 组名:折叠箭头(SidebarGroupToggle)悬停整条头才出现。
 */
export const sidebarGroupHeaderClass = 'group/ghdr flex h-8 items-center justify-between pr-2 pl-5';

/** 一条会话正拖在这一行上、松手就挂过去(或回到根):罩上落点那一层,同这屏分块 / 插 @ 的落点(use-session-drop-target)。 */
export const sidebarDropTargetClass = 'bg-foreground/10 ring-1 ring-inset ring-foreground/20';

/**
 * 分区头那一条通栏(左右贴着侧栏边),行却缩进 12px、带圆角:落点那一层画在头里面缩进的一块上,与下面的行同宽同形。
 * 用伪元素画,头本身的排版一像素不动。
 */
export const sidebarHeaderDropTargetClass =
  'relative isolate before:pointer-events-none before:absolute before:-z-10 before:inset-y-0 before:inset-x-3 before:rounded-md before:bg-foreground/10 before:ring-1 before:ring-inset before:ring-foreground/20';

/**
 * 分区头标题(置顶 / 项目 / 任务)的角色 —— MicroLabel 自带 text-xs,咕咕字阶只有 14/12,
 * 这里落在 14 档(text-sm)。三个分区头引用同一个常量,❌ 各写一遍手抄同一串覆盖类:
 * 手抄三份正是「项目」曾经掉队成 12px、和「任务」的 14px 不一致的成因(见 projects-group-label)。
 */
export const sidebarGroupTitleClass = 'font-medium text-sm text-foreground-passive';

/** 标题旁的数量(状态分组「需要你 3」、收起的分区头「置顶 3」)。@@@sidebar-type-scale — 归 12(text-xs)。 */
export const sidebarCountClass = 'text-xs leading-none tabular-nums text-foreground-passive select-none';

/**
 * 分区头右侧的小图标钮(排序 / 新建项目 / 新建任务)与顶条折叠钮共用的一种视觉。
 *
 * 两件事在这里定死:**字形 16px**,与行内图标同一档(改动前是 12px / 14px / 16px 三档);
 * **hover 底色取 `background-tertiary-*`**,即侧栏那一族 —— 改动前它们 hover 到
 * `background-1`(主壳那一族),画在 `bg-background-tertiary` 的侧栏上是另一个产品的按钮。
 *
 * @@@sidebar-ink-tiers — 静止态字色是 `foreground-passive`,与它同一行的分区头标签同档。
 * 上一轮把标签从 tertiary-passive(#7B7B7B)提到 passive(#9A9AA2)时漏了这些图标,结果
 * **图标比它自己的标题还深**:标签退成了背景,图标没退,一行里两个层级。
 * hover/展开仍到 `foreground-tertiary`(最深),交互反馈没丢。
 */
export const sidebarHeaderIconButtonClass =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-passive transition-colors hover:bg-row-hover hover:text-foreground-tertiary active:bg-row-press aria-expanded:bg-row-selected aria-expanded:hover:bg-row-selected aria-expanded:active:bg-row-selected aria-expanded:hover:state-hover-layer aria-expanded:active:state-press-layer aria-expanded:text-foreground-tertiary [&_svg]:size-4';

/**
 * 行尾键帽的显隐 —— 指针落到这一行(或键盘停在这一行)才淡入,静止态不画。
 *
 * 为什么不常驻:侧栏里挂键帽的是搜索、资源库、设置三行,三行同时在屏上,于是同一副 ⌘ 方块
 * 在一条竖线上重复三遍,成了永久家具。而键帽回答的那个问题(「这一项的键位是什么」)只在
 * 用户看向这一项时才被问起 —— owner 2026-09-15 圈的正是这三处(「不应该常驻且重复出现」)。
 * 侧栏里本来就是这么办事的:会话行的置顶/归档钮、分区头的折叠箭头、项目行的小钮,
 * 全是悬浮才现身;这一条只是把行尾键帽并回同一条规矩。
 *
 * 用 `opacity-0` 而不是不渲染:键帽照旧占住行尾那一格,标题的截断宽度、以及右缘那条竖线
 * (见 sidebarGroupHeaderClass)因此一格不动 —— 指针进出时行内不会抖。
 *
 * ⚠️ 用它的行必须自己声明 `group/row`,与会话行 / 项目行同一个组名,❌ 别另起一个。
 */
export const sidebarRowShortcutClass =
  'opacity-0 transition-opacity duration-[var(--dur-fast,120ms)] ease-out group-hover/row:opacity-100 group-focus-visible/row:opacity-100';

/**
 * 行尾动作(置顶 / 归档)与它底下那格时间的显隐 —— **两者互为补集**,所以配方写在一起。
 *
 * 判据只有两条:**指针落在这一行**,或**这两枚钮里有一枚真的拿到了焦点**。
 *
 * ❌ 不认「这一行是键盘光标」,❌ 不认「这一行被选中」。#5642 想守的是「看不见却能 Enter 触发归档」,
 * 而焦点那一条已经守住了它 —— 按不到看不见的按钮,因为 Tab 到它的同一刻它就现形了。
 * #5643 当时多加的 `data-nav-cursor` 那一条把它守过了头:点一行也会把键盘光标同步过去
 * (`syncCursorFromPointer`),于是选中的那一行从此常驻两枚钮、还压住标题尾巴(#5818,owner 实机)。
 *
 * ⚠️ 两层必须同时改。时间那一层从前写的是 `group-focus-within/row:opacity-0` —— `group/row` 就是行本身、
 * 行又 `tabIndex=0`,所以点一下行就把时间藏掉;与上面那条一配,选中行的右端会变成「动作不画、时间也不画」
 * 的一片空。现在两层认的是同一个 `group/row-actions`(声明在 `sidebarRowActionsSlotClass` 上),
 * 一层亮的条件就是另一层灭的条件,不会再出现两层同时缺席的缝。
 *
 * 隐去用的是 opacity 而不是不渲染(与 `sidebarRowShortcutClass` 同一条):那一格照旧占位,
 * 指针进出时标题的截断宽度不会抖。
 */
export const sidebarRowActionsSlotClass =
  'group/row-actions relative ml-2 flex h-6 shrink-0 items-center justify-end';

export const sidebarRowHoverActionsClass =
  'pointer-events-none absolute inset-y-0 right-0 z-10 flex translate-x-1 items-center justify-end gap-1 opacity-0 transition-opacity duration-[var(--dur-fast,120ms)] ease-out group-hover/row:pointer-events-auto group-hover/row:translate-x-0 group-hover/row:opacity-100 group-focus-within/row-actions:pointer-events-auto group-focus-within/row-actions:translate-x-0 group-focus-within/row-actions:opacity-100';

export const sidebarRowRestActionsClass =
  'pointer-events-none flex shrink-0 items-center justify-end opacity-100 transition-opacity duration-[var(--dur-fast,120ms)] group-hover/row:opacity-0 group-focus-within/row-actions:opacity-0';

export const SidebarContainer = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('group/sidebar relative z-50 flex flex-col text-sm text-foreground', className)}
    {...props}
  />
));
SidebarContainer.displayName = 'SidebarContainer';

export const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 border-b-0', className)} {...props} />
  )
);
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-1 flex-col overflow-hidden text-sm text-foreground-muted', className)}
    {...props}
  />
));
SidebarContent.displayName = 'SidebarContent';

export const SidebarGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mb-6 grid', className)} {...props} />
  )
);
SidebarGroup.displayName = 'SidebarGroup';

export const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('grid gap-0.5', className)} {...props} />
));
SidebarGroupContent.displayName = 'SidebarGroupContent';

// list body —— 它拥有这一组的横向留白(见 sidebarGroupInsetX)。
export const SidebarMenu = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(sidebarGroupInsetX, className)} {...props} />
  )
);
SidebarMenu.displayName = 'SidebarMenu';

export const SidebarItemMiniButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      'w-6 h-6 flex items-center justify-center text-foreground-tertiary-muted hover:text-foreground-tertiary rounded-md hover:bg-row-hover active:bg-row-press',
      className
    )}
    onMouseDown={(e) => e.preventDefault()}
    onPointerDown={(e) => e.stopPropagation()}
    {...props}
  />
));
SidebarItemMiniButton.displayName = 'SidebarItemMiniButton';

// 横向留白不在这里:它归 list body(见 sidebarGroupInsetX),内容列归行内的内容容器
// (见 sidebarRowContentInsetX)。行自己两样都拿不到 —— preflight 会抹平按钮上的 px-*。
// 也没有 py-*:行高由 h-8 拥有,而这是 `flex items-center` —— 纵向内距不改变任何一个像素,
// 留着只会读成「我设了纵向内距」。谁要改行高,改 h-8。
//
// @@@sidebar-rest-ink (owner 2026-09-05) — 静止态字色是 `-rest` 不是 `-muted`。
// 这里原先写的是 `text-foreground-tertiary-muted`(neutral-11 #646464,白底 5.9:1),
// 等于把侧栏正文画在「次要信息」那一档,只有 hover 才升到正文档。owner 把咕咕与 Codex 并排
// 对照后拍板加深:静止态改用 `-rest`(#3B3B3B,11.2:1,与 Codex 实测的 #3B3E40 基本重合)。
// hover/active 仍是 `-tertiary`(neutral-12),对比台阶没丢,只是起点从次要档抬到了正文档。
// ❌ 别改回 -muted「与上游对齐」:这是 owner 明确推翻上游的一处。
//
// @@@state-ladder-mix (#2322) 三态走 row 三件套(--hover/--press/--selected 的半透明叠色),
// 不再从 background-tertiary 这条**表面**阶梯上挑级。挑级坏在三处,正是 owner 2026-09-09
// 截图里圈的那件事:
//   ① 深浅离谱 —— 浅色下 tertiary-2 = neutral-5 = 压黑 16.5%(实测 #d5d5d5),而咕咕主体的
//      选中行是蓝 tint 7%(#f1f6fe)。同一个「选中」,侧栏比主体深五倍。
//   ② 按下 == 选中 —— active: 与 data-[active=true]: 以前同取 tertiary-2,按一下就长得像选中。
//   ③ 明暗不一致 —— tertiary-1/2 浅色映到 neutral-4/5、暗色映到 background-1/2,而暗色下
//      --card 与 --bg-elevated 同色 ⇒ 暗色里 hover/按下/选中**三态同一个色**,全都分不出。
// 叠色还顺带解决「行已选中时行内小钮要不要再深一档」——叠色天然叠加,不需要特例。
// #7333 视觉规范:侧栏是导航 ⇒ 行是胶囊(rounded-full = --radius-capsule);键盘焦点走全局 :focus-visible 环,
// 不再在这里压掉(outline 跟着胶囊圆角走)。
const sidebarMenuItemClass =
  'flex w-full font-normal h-8 text-foreground-tertiary-rest rounded-full items-center hover:bg-row-hover active:bg-row-press hover:text-foreground-tertiary gap-2 text-sm transition-colors data-[active=true]:bg-row-selected data-[active=true]:hover:bg-row-selected data-[active=true]:active:bg-row-selected data-[active=true]:text-foreground-tertiary data-[active=true]:hover:state-hover-layer data-[active=true]:active:state-press-layer';

interface SidebarMenuButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
}
export const SidebarMenuButton = React.forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(
  ({ className, isActive, ...props }, ref) => (
    <button
      ref={ref}
      data-slot="button"
      data-active={isActive || undefined}
      className={cn(sidebarMenuItemClass, className)}
      onMouseDown={(e) => e.preventDefault()}
      {...props}
    />
  )
);

// Sidebar row labels use this as the named voice-control target. Primary
// activation is handled by the parent row's click handler via bubbling.
interface SidebarMenuActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * 所在的行可以被拖走(`draggable`)时必须打开:吞掉 mousedown 的默认动作,浏览器就不再发起
   * 原生拖拽 —— 连 dragstart 都不发(headless Chromium 实测),而这枚按钮铺满了行的可点区域,
   * 于是整行都拖不动。代价是点这一行会把焦点收到按钮上,那正是这个 preventDefault 原本要挡的。焦点环在咕咕已全废(product spec),所以看不出来。
   */
  allowNativeDrag?: boolean;
}
export const SidebarMenuAction = React.forwardRef<HTMLButtonElement, SidebarMenuActionProps>(
  ({ className, allowNativeDrag, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      'flex min-w-0 flex-1 items-center self-stretch rounded-md text-left text-inherit outline-none',
      className
    )}
    onMouseDown={allowNativeDrag ? undefined : (e) => e.preventDefault()}
    {...props}
  />
));
SidebarMenuAction.displayName = 'SidebarMenuAction';

interface SidebarMenuRowProps extends React.HTMLAttributes<HTMLDivElement> {
  isActive?: boolean;
  /**
   * behavior session-page「键盘导航」: the keyboard cursor. It normally coincides with `isActive`
   * (walking the chain takes the main area with it), so it draws only a thin ring rather than a
   * second background — there must read as one highlight, not two. It becomes visible on its own
   * only in the gap where the target session is still opening.
   */
  isCursor?: boolean;
  /**
   * Armed by a first ⌃X and waiting for the confirming second press. A plain primary ring, not the
   * destructive red it had as a delete: archiving is undone from its toast or Session history (#6949).
   */
  isPendingArchive?: boolean;
}
export const SidebarMenuRow = React.forwardRef<HTMLDivElement, SidebarMenuRowProps>(
  ({ className, isActive, isCursor, isPendingArchive, ...props }, ref) => (
    <div
      ref={ref}
      data-active={isActive || undefined}
      data-nav-cursor={isCursor || undefined}
      data-pending-archive={isPendingArchive || undefined}
      className={cn(
        sidebarMenuItemClass,
        // @@@state-ladder-mix 键盘光标以前画的是一圈 ring,于是它成了整行上最重的东西 ——
        // 比这一行「是不是当前项」(选中底)还抢眼,而它表达的只是「键盘停在这」。
        // 键盘停在哪由浏览器焦点自己画(#7333:键盘 :focus-visible 有环,全局一处);这一层只表达「导航光标在这」。
        // 所以改用悬浮档铺一层:层走 background-image,不抢选中态的 background-color,
        // 「选中 + 键盘停在这」= 选中底 + 悬浮层,两件事同时看得见且不互相顶掉。
        isCursor && 'state-hover-layer',
        isPendingArchive && 'ring-1 ring-inset ring-border-primary',
        className
      )}
      {...props}
    />
  )
);
