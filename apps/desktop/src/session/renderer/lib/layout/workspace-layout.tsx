import { motion, useTransform } from 'framer-motion';
import { type ReactNode, useState } from 'react';
import { ShellSidebarToggle } from '@renderer/lib/components/titlebar/shell-titlebar';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { SIDEBAR_MIN_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { panelContentLayout, usePanelMounted, usePanelProgress } from '@renderer/lib/layout/panel-motion';
import { PanelResizeHandle } from '@renderer/lib/layout/panel-resize-handle';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import './workspace-surface.css';

/** 侧栏最宽不超过会话页宽度的这个比例 —— 窗口小的时候 520px 会把主区挤没。 */
const SIDEBAR_MAX_SHARE = 0.4;

/**
 * 侧栏**内容**还排得下的最窄宽度 —— 收起动画里内容跟着容器缩,缩到这里就停住。
 *
 * ⚠️ 这不是 `SIDEBAR_MIN_WIDTH_PX`(200)。那个是「用户拖分隔条最窄能拖到哪」,是产品定的手感;
 * 这个是「行还画得出来吗」的物理下限:一行 = list body 留白 24 + 折叠箭头车道 20 +
 * 身份图标 16 + 行尾状态位 24 ≈ 84,再给标题留两个字。比它还窄,行里那些 shrink-0 的零件
 * 自己就会溢出行盒 —— 那时候再缩只是把裁切从面板挪进行里,没有意义。
 */
const SIDEBAR_CONTENT_MIN_PX = 120;

interface WorkspaceLayoutProps {
  leftSidebar: ReactNode;
  mainContent: ReactNode;
  /** A place of its own on the far-left rail (App, Library): no task list beside it. The sidebar stays
   *  mounted, only not shown — swapping the layout out rebuilt the whole task tree on every way back. */
  sidebarHidden?: boolean;
}

/**
 * 侧栏折不折只由用户说了算(顶栏按钮 / 快捷键 / 拖分隔条)。
 *
 * #3904 曾加过一条「窄宽度自动让位」:会话页下量到分栏组宽度不够就替用户把左侧栏折起来。
 * owner 2026-09-05 推翻:「新会话创建之后左侧栏就折叠,这个不好,别折叠啊」。这条规则从来没进
 * behavior spec,是实现侧自己加的 —— 它连同它的两条放大器(量到的不是窗口宽、折了回不来)
 * 一起在那次删掉了,别再以任何形式加回来。
 *
 * ## 这一层的几何
 *
 * 外层不再是 react-resizable-panels 的分栏组:那个库把宽度记在自己的 flex 布局里,程序性
 * collapse 是**瞬间**改 flex-grow,没有可插入过渡的量。现在是一条普通 flex 行 —— 侧栏宽度由
 * 弹簧驱动的 motion value 给,主区吃剩下的(flex-1),所以两者由同一个数推出、不会脱节。
 * 细节见 panel-motion.ts。
 *
 * **内容层是固定宽的**:外层 `<aside>` 宽度在动,里面那层始终是用户选定的整宽、被外层裁掉。
 * 这就是收起时文字不会一路折行抖动的原因 —— 也是"丝滑"的实际来源,❌ 别为了少一层 DOM 把它
 * 摊平成"内容跟着容器缩"。它同时**跟着窗口整块左移**(见下面 contentX),否则固定宽会变成
 * 「原地被右边削平」—— 那是遮罩不是收起。
 */
export function WorkspaceLayout({ leftSidebar, mainContent, sidebarHidden = false }: WorkspaceLayoutProps) {
  const { translate } = useSessionMessages();
  const {
    isLeftOpen,
    isLeftPeeking,
    leftWidth,
    leftProgress,
    leftAnimatedWidth,
    workspaceRootRef,
    setLeftWidth,
    setCollapsed,
  } = useWorkspaceLayoutContext();
  const [isResizing, setIsResizing] = useState(false);

  // 浮出预览用自己的一条进度:它从左缘滑入,而不是把主区推开。
  const peekProgress = usePanelProgress(isLeftPeeking);
  const isPeekVisible = usePanelMounted(isLeftPeeking, peekProgress);

  // 停靠态与浮出态互斥(浮出只在 leftProgress 落到 0 之后才允许),所以同一层内容按当前那一态取值。
  //
  // @@@sidebar-content-fits — 停靠态的宽 / 位移 / 透明度全由 panelContentLayout 一次定义:
  // 内容宽度跟着占位宽走,到最小宽度为止;窄过之后才整块贴右缘滑走并淡出。三个量同源,
  // 所以它们不会各跑各的。
  // ❌ 别回到「内容恒为整宽、由外层裁掉」—— 那是 owner 2026-09-13 圈的「折叠产生遮罩」:
  // 内容原地不动、右边一刀切平,标题切成半个字、行尾状态点整个没了。
  // ❌ 也别只把它整块平移 —— 那只是把被啃的那一边换到左边,owner 当场回
  // 「右边有了,但是左边又丢失了,正常应该两边都有」。
  //
  // 浮出态不吃这套:它是浮在主区之上的一整块预览,本来就该是整宽从左缘滑入。
  const dockedContent = (progress: number, width: number) =>
    panelContentLayout(progress, width, SIDEBAR_CONTENT_MIN_PX);
  const contentWidth = useTransform([leftProgress, leftWidth], (latest: number[]) =>
    latest[0] > 0 ? dockedContent(latest[0], latest[1]).width : latest[1]
  );
  const contentOpacity = useTransform(
    [leftProgress, peekProgress, leftWidth],
    (latest: number[]) =>
      latest[0] > 0 ? dockedContent(latest[0], latest[2]).opacity : latest[1]
  );
  const contentX = useTransform([leftProgress, peekProgress, leftWidth], (latest: number[]) =>
    latest[0] > 0 ? dockedContent(latest[0], latest[2]).offset : (latest[1] - 1) * latest[2]
  );

  const maxSidebarWidth = () => {
    const rootWidth = workspaceRootRef.current?.clientWidth ?? 0;
    return rootWidth > 0 ? rootWidth * SIDEBAR_MAX_SHARE : Number.POSITIVE_INFINITY;
  };

  return (
    <div
      ref={workspaceRootRef}
      className="relative flex h-full w-full overflow-hidden"
      data-workspace-shell=""
    >
      <motion.aside
        data-workspace-left-panel=""
        className={cn(
          'relative h-full shrink-0',
          sidebarHidden && 'hidden',
          // 停靠时 z-40 与顶栏那层同档(它们不重叠);浮出时必须抬到 z-50 压过顶栏 —— 预览是盖在
          // 主区**之上**的一层,主区左上角那块面包屑/项目名不抬就会透出来压在侧栏内容上
          // (顶栏也是 z-40,而且排在 DOM 后面,同档就赢)。开关钮同样 z-50 但更靠后,仍在最上面。
          isPeekVisible ? 'z-50' : 'z-40',
          // 停靠时靠外层裁切做出"滑出视野"的效果;浮出时内容要盖到主区上面,所以不裁。
          isPeekVisible ? 'overflow-visible' : 'overflow-hidden'
        )}
        style={{ width: leftAnimatedWidth }}
      >
        <motion.div
          // #7333 停靠 / 浮出两态的材质不同:停靠时这一层在 mac 原生材质下让出底色,浮出预览盖在正文上仍是不透明面
          // (tokens.css @@@window-material-css 按这个属性分)。
          data-peek={isPeekVisible ? '' : undefined}
          className={cn(
            'absolute inset-y-0 left-0 bg-background-tertiary',
            // 拖分隔条时别让指针顺手把侧栏里的文字选中 —— 与工作区面板同一处方。
            isResizing && 'select-none',
            // 浮出态是浮在主区之上的一层,靠**一档 lift 影**和"停靠"区分开。
            // 原配方是「右缘线 + 一档阴影」,并注明「阴影不得超过 shadow-sm、不得有色」——
            // ⚠️ 2026-09-22 owner 裁决(Refs #6104):承认它就是浮层。design.md
            // 「Do not stack a border, a ring, and a shadow on one edge.」⇒ 去掉 border-r,
            // 只留那一层影;而唯一的那一档影是 --shadow-lift(shadow-sm 那一档已经不存在了)。
            isPeekVisible && 'shadow-lift'
          )}
          style={{
            // ❌ 别再配一条 minWidth:内容层是 absolute,width 已经是硬的;而 framer-motion 只把
            // 同一个 MotionValue 绑到它认识的那条属性上 —— minWidth 会停在首帧那个值,
            // 于是宽度收到 200 时盒子仍被 208 的 min-width 撑着,又变回「内容比容器宽」。
            width: contentWidth,
            opacity: contentOpacity,
            x: contentX,
            pointerEvents: isLeftOpen || isPeekVisible ? 'auto' : 'none',
          }}
        >
          {leftSidebar}
        </motion.div>
      </motion.aside>
      {isLeftOpen && !sidebarHidden ? (
        <PanelResizeHandle
          edge="end"
          offset={leftAnimatedWidth}
          ariaLabel={translate('task.resizeSidebar')}
          getSize={() => leftWidth.get()}
          minSize={SIDEBAR_MIN_WIDTH_PX}
          maxSize={maxSidebarWidth}
          onSize={(size) => setLeftWidth(size)}
          onCollapse={() => setCollapsed('left', true, { suppressPeek: false })}
          onSizeCommit={(size) => setLeftWidth(size, { persist: true })}
          onDraggingChange={setIsResizing}
        />
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-workspace-content-surface="">{mainContent}</div>
      {/* 左侧栏开关:整个会话页**唯一**一枚,永远钉在会话页左缘同一个坐标 ——
          侧栏是从它下面滑过去的,不是把它顶走。❌ 别再在侧栏内部另放一枚。 */}
      {sidebarHidden ? null : <ShellSidebarToggle />}
    </div>
  );
}

interface WorkspaceContentLayoutProps {
  titlebarSlot: ReactNode;
  mainPanel: ReactNode;
}

export function WorkspaceContentLayout({ titlebarSlot, mainPanel }: WorkspaceContentLayoutProps) {
  return (
    <div className="relative flex h-full flex-col bg-background text-foreground">
      {titlebarSlot}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">{mainPanel}</div>
      </div>
    </div>
  );
}
