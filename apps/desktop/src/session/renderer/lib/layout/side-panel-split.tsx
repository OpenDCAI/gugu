import { motion, useMotionValue, useTransform } from 'framer-motion';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clamp01,
  panelContentLayout,
  usePanelAnimatedSize,
  usePanelMounted,
  usePanelProgress,
} from '@renderer/lib/layout/panel-motion';
import { PanelResizeHandle } from '@renderer/lib/layout/panel-resize-handle';
import { cn } from '@renderer/utils/utils';

/** 右栏的形态:关着 / 和左栏并排 / 全屏(右栏盖住左栏)。会话页右栏和群右栏是同一个三态。 */
export type PanelForm = 'closed' | 'side' | 'full';

/** 右栏宽度:记在哪个键、最窄多少、第一次多宽(不给 = 分栏区的三分之一)。 */
export type SidePanelWidths = { storageKey: string; min: number; initial?: number };
const SESSION_PANEL_WIDTHS: SidePanelWidths = { storageKey: 'gugu.taskpage.workspacePanelWidth', min: 320 };

/** 左栏(聊天栏)最少留的宽度(px)。 */
const CHAT_MIN_WIDTH_PX = 240;
const WORKSPACE_DEFAULT_SHARE = 0.33;

function readStoredWorkspaceWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredWorkspaceWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // 存储不可用:宽度这一项丢了就丢了。
  }
}

interface SidePanelSplitProps {
  /** 视图模型说右栏此刻是哪一态。 */
  form: PanelForm;
  /** 这一态是哪一处的(会话页 = 会话 id)。换了一处就直接落到它的形态,不放开合 / 全屏的弹簧:那是换了地方,不是面板在动。 */
  place?: string;
  chatColumn: ReactNode;
  workspacePanel: ReactNode;
  /** 分隔条的无障碍名 —— 由调用方用自己的文案表给:会话页和咕咕主壳不是同一套。 */
  resizeLabel: string;
  widths?: SidePanelWidths;
  /** 右栏此刻是否盖着聊天栏(全屏,或正从全屏掀开):这期间右栏内容贴着分栏区左缘。 */
  onChatColumnCoveredChange?: (covered: boolean) => void;
  /** 用户把分隔条拖过收起阈值 —— 由调用方去改视图模型。 */
  onCollapseWorkspace?: () => void;
  /** 关上(收起动画放完)就卸掉右栏内容。会话页留着(页签里的终端、网页要活着);群槽位卸掉(看不见的页放手,F17)。 */
  unmountWhenClosed?: boolean;
  /** 分栏根的额外类,如放进横排 flex 时的 `flex-1`;`chatMinWidth` 是左栏的地板(群聊那边由 useMessageColumnMinWidth 给,不给 = 0)。 */
  className?: string;
  chatMinWidth?: number;
}

/**
 * 左栏 + 右栏的两栏分栏(product spec 会话页):会话页的会话页、新建页、项目首页,
 * 和群聊的工作区 App 槽位,都是这一个 —— 开合、全屏、拖宽、拖过阈值就关,两边是同一份逻辑。
 *
 * ## 为什么不再用 react-resizable-panels
 *
 * 那个库把宽度记在自己的 flex 布局里,程序性 collapse 是**瞬间**改 flex-grow —— 没有可插入过渡的量,
 * 于是 product spec 那条「尺寸变化必须过渡:面板展开/收缩不允许瞬跳」在这里一直是
 * 破的。想让它动起来只能每帧调 `resize()`,但动画中途宽度必然低于 minSize,会一路撞上它自己的收起
 * 阈值(半路被判成收起而吸走),而且它每次布局提交都落 localStorage。
 *
 * 现在:面板宽度是一个 motion value,占位宽 = 弹簧进度 × 目标宽,聊天栏吃剩下的(flex-1)。
 * 详见 lib/layout/panel-motion.ts —— 侧栏用的是同一条弹簧,「同一场景全产品同档」。
 *
 * ## 三件事各管各的
 *
 * · **收起/展开**改的是"进度",目标宽不变 —— 内容层宽度跟着占位宽收到最小宽度为止,
 *   窄过之后整块滑走 + 淡出(panelContentLayout)。判据是「一个像素都不许被啃掉」。
 * · **拖分隔条**改的是目标宽,跟手,不放弹簧。
 * · **全屏/还原**是右栏**盖住**聊天栏(product spec:「暂隐聊天列」),不是把它挤没:
 *   聊天栏的几何与并排时一模一样,只是被盖住、整栏 inert。右栏内容在盖上那一刻排到整条宽、
 *   掀开放完那一刻排回并排宽,各一次;弹簧只走右栏的外框(盖到哪),内容不逐帧重排。
 *   原来那样逐帧挤(mac1 实测,一次全屏):聊天栏里的终端 reflow 十几次,PTY 一路收到 2 列,TUI 在
 *   2 列宽下整屏重画,还原回来行被拆成竖条、重复错序、输入框没了;右栏里的网页重排二十几次。
 */
export function SidePanelSplit({
  form,
  place,
  chatColumn,
  workspacePanel,
  resizeLabel,
  widths = SESSION_PANEL_WIDTHS,
  onChatColumnCoveredChange,
  onCollapseWorkspace,
  unmountWhenClosed = false,
  className,
  chatMinWidth,
}: SidePanelSplitProps) {
  const workspaceHidden = form === 'closed';
  const chatHidden = form === 'full';
  const minWidth = widths.min;
  const initialWidth = widths.initial;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const containerWidth = useMotionValue(0);
  /** 用户选定的宽 —— 只有拖分隔条改它。 */
  const preferredWidth = useMotionValue(readStoredWorkspaceWidth(widths.storageKey) ?? 0);
  /** 面板并排时的宽(用户选定宽,clamp 到给聊天栏留够 240px)。全屏不改它:全屏是盖过去,不是拉宽。 */
  const panelWidth = useMotionValue(0);

  const progress = usePanelProgress(!workspaceHidden, place);
  const animatedWidth = usePanelAnimatedSize(progress, panelWidth);
  const isPanelMounted = usePanelMounted(!workspaceHidden, progress);

  // 全屏 = 从分隔条往左盖住聊天栏,同一条弹簧(0 = 并排,1 = 盖满)。还原的弹簧放完之前仍算「盖着」:
  // 内容层还是整条宽,只是外框往回收,掀开放完才排回并排宽。
  const cover = usePanelProgress(chatHidden, place);
  const covering = usePanelMounted(chatHidden, cover);
  /** 聊天栏还露着的那部分(1 = 全露,0 = 盖满)。 */
  const uncovered = useTransform(cover, (c) => 1 - c);
  /** 盖满之后聊天栏 visibility:hidden(盖的途中它还露着):不画,也不再往顶栏拖拽带里挖 no-drag 的洞。 */
  const chatShown = usePanelMounted(!chatHidden, uncovered);
  /** 盖着时右栏外框的宽:从并排宽一路盖到整条。聊天栏不跟着变 —— 它不在这条宽度里。
   *  弹簧有回弹,进度要夹在 0..1:冲过 1 的那几帧外框会探出分栏区左缘、压到侧栏上。 */
  const coverWidth = useTransform([progress, cover, panelWidth, containerWidth], ([p, c, side, whole]: number[]) =>
    clamp01(p) * (side + clamp01(c) * Math.max(0, whole - side))
  );

  // @@@sidebar-content-fits 的右侧对偶(见 panel-motion.ts):内容宽度跟着占位宽走到最小宽度为止,
  // 窄过之后才整块贴左缘滑走并淡出。内容层贴的是**右**缘,所以位移是正向的。
  // ❌ 别让它恒为整宽由外层裁掉:真机实测那样收起时左侧被啃 221.8 → 320px,
  // 与 #5578 在左侧栏上的那个洞是同一个,只是镜像。
  // 盖着聊天栏时内容恒为整条宽(最小宽度就是整条):外框怎么动它都不重排;全屏下直接关面板,它整块滑走 + 淡出。
  const contentLayout = ([p, side, whole]: number[]) =>
    covering ? panelContentLayout(p, whole, whole, 'end') : panelContentLayout(p, side, minWidth, 'end');
  const contentWidth = useTransform([progress, panelWidth, containerWidth], (latest: number[]) =>
    contentLayout(latest).width
  );
  const contentX = useTransform([progress, panelWidth, containerWidth], (latest: number[]) =>
    contentLayout(latest).offset
  );
  const contentOpacity = useTransform([progress, panelWidth, containerWidth], (latest: number[]) =>
    contentLayout(latest).opacity
  );

  // 分栏区宽度:窗口缩放、咕咕会话列表拖动、切 tab 回来(隐藏时 rect 为 0)都会变。
  // 容器变宽变窄,面板宽要**立刻**跟上:拖窗口时每帧都在变,再放一条弹簧只会让面板追不上边框。
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const read = () => {
      const container = element.clientWidth;
      if (container <= 0) return; // 隐藏挂载:量到 0 不当真,别把面板宽度冲成 0。
      containerWidth.set(container);
      const preferred = preferredWidth.get() || (initialWidth ?? container * WORKSPACE_DEFAULT_SHARE);
      const max = Math.max(minWidth, container - CHAT_MIN_WIDTH_PX);
      panelWidth.set(Math.max(minWidth, Math.min(max, preferred)));
    };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    read();
    return () => observer.disconnect();
  }, [containerWidth, panelWidth, preferredWidth, minWidth, initialWidth]);

  useEffect(() => {
    onChatColumnCoveredChange?.(covering);
  }, [covering, onChatColumnCoveredChange]);

  const showHandle = !workspaceHidden && !covering;

  return (
    <motion.div
      className={cn('relative flex h-full min-w-0', className)}
      // 盖着时右栏出了流,这条右内边距替它占住并排时的那一截:聊天栏的宽度与并排时分毫不差。
      style={{ minWidth: chatMinWidth, paddingRight: covering ? animatedWidth : 0 }}
      ref={containerRef}
    >
      {/* 聊天栏吃剩下的宽度。min-w-0 必须留:没有它,长代码块会把这一栏顶宽,面板就挤不进来。
          isolate:栏里带 z-index 的东西(吸顶条、浮钮)只在栏内比高低,盖上来的右栏一律压住它们。
          全屏时整栏 inert —— 被盖住的东西点不到,也不该 Tab 得进去。 */}
      <div
        data-testid="session-chat-panel"
        className={cn('isolate flex min-h-0 min-w-0 flex-1 flex-col', !chatShown && 'invisible')}
        inert={chatHidden}
      >
        {chatColumn}
      </div>
      {showHandle ? (
        <PanelResizeHandle
          edge="start"
          offset={animatedWidth}
          ariaLabel={resizeLabel}
          getSize={() => panelWidth.get()}
          minSize={minWidth}
          maxSize={() => Math.max(minWidth, containerWidth.get() - CHAT_MIN_WIDTH_PX)}
          onSize={(size) => {
            preferredWidth.set(size);
            panelWidth.set(size);
          }}
          onCollapse={() => onCollapseWorkspace?.()}
          onSizeCommit={(size) => {
            preferredWidth.set(size);
            panelWidth.set(size);
            writeStoredWorkspaceWidth(widths.storageKey, size);
          }}
          onDraggingChange={setIsResizing}
        />
      ) : null}
      {/* 收起动画放完之前不卸载,否则面板会在收到一半时凭空消失;两栏并排时它是流内元素,
          盖着聊天栏时出流、贴右缘浮在上面(同一个元素只换定位,里面的网页与终端不重挂)。 */}
      <motion.aside
        data-testid="session-workspace-panel"
        data-app-shell-focus-area="right-panel"
        className={cn(
          'h-full min-h-0 shrink-0 overflow-hidden',
          covering ? 'absolute inset-y-0 right-0 z-10' : 'relative',
          !isPanelMounted && 'pointer-events-none'
        )}
        style={{ width: covering ? coverWidth : animatedWidth }}
      >
        {/* 内容层绝对定位到右缘,宽度由 panelContentLayout 给:占位宽以上跟着缩(内容完整,
            左右两端都在),窄过最小宽度才贴着右缘整块往右滑走并淡出。贴**右**缘是方向性的
            —— 面板从右侧滑出。❌ 别把宽度钉成整宽由外层裁:那是 #5578 在左侧栏上的那个洞的镜像。 */}
        <motion.div
          className={cn('absolute inset-y-0 right-0 flex min-h-0 flex-col', isResizing && 'select-none')}
          style={{ width: contentWidth, x: contentX, opacity: contentOpacity }}
        >
          {isPanelMounted || !unmountWhenClosed ? workspacePanel : null}
        </motion.div>
        {/* 分隔线是面板**里面**贴左缘的一条 1px,于是它跟着面板一起滑走,收到 0 时被
            overflow-hidden 顺手裁掉。❌ 别画回聊天栏的右缘:那样面板一开始收起线就当场消失,
            板还在滑 —— 线先没了、板还在动,那一下就是"发虚";也❌ 别用 border-l,border-box
            有 1px 地板,收到 0 还会剩一道贴边的线。盖满了就没有分隔对象:线随盖的进度淡出,掀开时淡回。 */}
        <motion.div
          className="absolute inset-y-0 left-0 z-10 w-px bg-border"
          style={{ opacity: uncovered }}
          aria-hidden="true"
        />
      </motion.aside>
    </motion.div>
  );
}
