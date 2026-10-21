// @@@sessionpage TASKPAGE-FUSION 顶栏动作分组 — 会话页顶部这一横排按钮的**唯一**几何来源。
//
// 为什么要有这个文件:在它之前,右上角的按钮各自 `fixed` 到自己算出来的偏移(分享 `right-[4.5rem]`、
// 工作区面板 `right-2`),而同一视觉行里另一些按钮又长在各视图自己的 tab bar 里(流式布局)。一行里两套
// 定位体系 → 顺序和间距按视图漂;每加一个浮动按钮,都得回头手改每个视图的右侧留白。owner 实机反馈
// 「这几个按钮一直不统一位置,总是乱放」,根因就是这个,不是某一次没对齐。
//
// 第一版把「分享 + 工作区面板」收进固定簇就收工了,但**待办(输出/来源)没进来** —— 它留在消息栏 header
// 里跟着可拖拽分栏走,于是三个按钮画成一簇、其中一个却会漂。owner 复看时点破了归属:
// 「分享和待办都是消息栏动作」。所以这一版按**语义**重新分组,而不是把按钮都塞进同一个容器:
//
//   ┌ 消息栏动作组(跟着聊天栏走,归属这个会话)┐         ┌ 窗口固定簇(贴窗口右缘)┐
//   │  待办/输出   分享                        │ ← 4px → │  工作区面板开关        │
//   └────────────── 4px ──────────────────────┘         └──────────────────────┘
//
// 中间有一版把「收起面板」在面板展开时搬进最右那条页签条的 <TabBarActionRow>,理由是
// 「同屏只剩一个容器才没得错」。owner 2026-09-10 推翻了这个取舍:那样一来同一枚按钮在
// 面板开/关两态落在两个坐标,点完一下手就得去别处找它。**按钮位置不变是目的,同屏一个容器
// 只是当时想到的手段**;冲突时按位置不变来做,跨容器的基线一致由 <TabBarActionRow> 自己算
// 高度与外边距来保证(它不继承页签的竖直对齐),不靠按钮搬家。
//
//   面板展开:  ┌ 消息栏动作组 ┐ … ┌ 页签条:拆分  全屏 ┐ ← 4px → ┌ 固定簇:收起面板 ┐
//   面板收起:  ┌ 消息栏动作组 ┐ ────────────────────── ← 4px → ┌ 固定簇:展开面板 ┐
//                                                                 ↑ 同一坐标
//
// 曾经这两组之间是 16px、组内 4px,想用「组内紧组间松」把分组画出来。owner 否掉了这个前提:
// 「一簇不一簇是实际行为而不是靠视觉差」「这个 gap 差我不明确,因为都是一串按钮」。
// 于是整排等距 4px —— 分组是**归属与行为**上的事实(一组跟聊天栏走、一组锚窗口),不再用空白去暗示。
//
// 规矩:
//  · 归属决定容器:属于一块会话的动作(在哪打开、输出/来源、分享)进那一块右上页签条的 <TabBarActionRow>
//    (#7052 对话成了会话的一枚页签,原来那条消息栏 header 没了),属于这一页内容的进 <PageTitleActions>,
//    属于窗口 chrome 的进 <TitlebarActions>;
//    ❌ 别按「看起来挨着」分,那正是上一版翻车的地方。
//  · 这一横排的容器**全部**在本文件里,共三个(外加左上那个单独的侧栏展开按钮,它不成组,
//    只借 data-titlebar-sidebar-toggle 蹭同一条图标规则)。❌ 别在某个视图里 `absolute top-N right-N`
//    自己糊一个 —— 项目主页就那么干过(top-3 比同排低 6px、right-12 量的是内容列不是窗口),
//    owner 又实机圈了一次;两轮清扫都漏掉它,只因为它长在 projects/ 而不是 tasks/。
//  · 固定簇的成员只认 FIXED_ACTION_IDS 这一份清单 —— 加一个 id,TypeScript 会逼你补上对应节点,
//    槽位数与预留宽度自动跟上;❌ 别在任何调用点手写槽位数(手写的护栏会过期,加了按钮忘了改就重叠)。
//  · 视图给固定簇预留的横向空间只认 contentClusterReserve,❌ 各处各写一份右侧留白。
//  · 全排只有 TITLEBAR_ACTION_SLOT_GAP_PX 一个间距;❌ 别再引入「组间距」,也 ❌ 不加分隔线。
import type { ReactElement, ReactNode } from 'react';
import {
  hasWindowTitlebarRow,
  readRendererPlatform,
  TITLEBAR_ACTION_EDGE_GAP_PX,
  TITLEBAR_ACTION_SLOT_GAP_PX,
  TITLEBAR_ACTION_SLOT_WIDTH_PX,
  titlebarActionsReserve,
  titlebarActionsRight,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
  windowTitlebarHeight,
} from '@/lib/window-chrome';

/**
 * 窗口固定簇的成员清单 —— 这一簇里有谁,只在这里写一次。
 *
 * 只收「窗口 chrome」级别的动作(开关某块面板),❌ 会话级动作(分享、输出/来源)不属于这里:
 * 它们跟着那一块会话走,在它右上页签条的 <TabBarActionRow> 里。
 */
const FIXED_ACTION_IDS = ['workspace-panel'] as const;

export type TitlebarActionId = (typeof FIXED_ACTION_IDS)[number];

/** 槽位数由清单推导,不是手写的常量 —— 加成员时它自己会变。
 *  ❌ 不导出:导出就是邀请别处手写槽位数,而这正是本文件要根除的东西。 */
const TITLEBAR_ACTION_SLOT_COUNT = FIXED_ACTION_IDS.length;

/**
 * 同一行内容要给固定簇留的右侧空间。Windows 上这一簇住在标题栏行(#6753),不压内容 ⇒ 按 0 个槽留。
 * 会话页一屏几块之后(#7052)会话页上没有这一簇(没有面板可开关)⇒ `withCluster: false` 只留窗口控制条与边缘呼吸。
 */
function contentClusterReserve(withCluster = true): number {
  const platform = readRendererPlatform();
  return titlebarActionsReserve(platform, !withCluster || hasWindowTitlebarRow(platform) ? 0 : TITLEBAR_ACTION_SLOT_COUNT);
}

/** 固定的 28px 槽位让动作 hitbox 和顺序在不同视图状态下保持稳定。
 *  ❌ 不导出:槽位只由 TitlebarActions 按清单铺,别处不该自己搓一个。 */
function TitlebarActionSlot({ id, children }: { id?: string; children?: ReactNode }) {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center"
      data-titlebar-action-slot={id ?? ''}
    >
      {children}
    </span>
  );
}

/**
 * 窗口固定簇:贴窗口右缘(Windows/Linux 上再让开窗口控制条),不随分栏或视图移动。
 *
 * 成员用 id → 节点的映射传入,而不是 children:这样「清单里有谁」和「实际渲染了谁」由类型系统钉死,
 * 少一个多一个都编译不过 —— 槽位数因此永远等于真实按钮数。
 *
 * 值收窄到 ReactElement,❌ 不用 ReactNode:后者含 undefined / null / false,于是
 * `actions={{ 'workspace-panel': undefined }}` 也能编译过,渲染出一个空的 28px 槽位,而槽位数
 * 照样把它算进预留 —— 「加成员不接线就编译不过」那句话就只对「整个键缺失」成立,是漏的。
 */
export function TitlebarActions({ actions }: { actions: Record<TitlebarActionId, ReactElement> }) {
  const platform = readRendererPlatform();
  const right = titlebarActionsRight(platform);
  // 28px 槽在会话页那条 40px 带里居中;带本身从窗口顶端起,Windows 上再让开标题栏那一行
  // (fixed 量的是窗口,不是会话页那一格)。与左端 ShellTitlebar 同一个式子,❌ 另写 top-*。
  const top = windowTitlebarHeight(platform) + (WINDOW_CONTROL_BAR_HEIGHT_PX - TITLEBAR_ACTION_SLOT_WIDTH_PX) / 2;

  return (
    <div
      className="fixed z-50 flex flex-nowrap items-center whitespace-nowrap [-webkit-app-region:no-drag]"
      // Fixed controls still use window coordinates. Consume the same surface inset as the
      // in-flow/absolute title controls; composer-only and auxiliary hosts have no inset.
      style={{ top: `${top}px`, right: `${right}px`, marginTop: 'var(--workspace-chrome-inset, 0px)', marginRight: 'var(--workspace-chrome-inset, 0px)', gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px` }}
      // 只是一排按钮,不是一个 toolbar 语义组(每个按钮自带 aria-label);给它一个名字方便定位与取证。
      data-titlebar-actions=""
    >
      {FIXED_ACTION_IDS.map((id) => (
        <TitlebarActionSlot key={id} id={id}>
          {actions[id]}
        </TitlebarActionSlot>
      ))}
    </div>
  );
}

/**
 * 页面级动作行:给**没有自己 header 行**的页面用 —— 项目主页那种整页居中排版,主内容竖直居中,
 * 压根没有一条可以把按钮放进去的流式行。
 *
 * 它用一条零占位的绝对定位行,把按钮放进顶栏那条 40px 带里,不动页面原有的居中排版。
 * 竖直位置由「28px 按钮在 40px 行里居中」结构性得出,❌ 不写 `top-3` 这类数字 —— 项目主页原本写的
 * 就是 top-3,比同排其它按钮低 6px,正是 owner 实机圈出来的那一下。
 *
 * 水平位置走 `right` 偏移而**不是** paddingInlineEnd:后者会让这个盒子一路伸到固定簇底下
 * (mac 68px、Windows 206px),在页面右上角留下一片看不见却吃点击的死区。用 right 偏移,盒子只有
 * 按钮那么宽,落点却完全一样。
 *
 * `reserveFixedCluster` 必须由调用点显式回答「窗口固定簇此刻是不是就在我右边」——
 * ❌ 不给默认值:它在项目主页上就有两种情况会是 false(工作区面板展开时这一列够不到窗口右缘;
 * bootstrapping 态渲染的是普通 Titlebar、固定簇压根没挂载),默认成 true 会在 Windows 上
 * 白白缩进 178px。会话页那边同样是显式回答的(右上那格的 <TabBarActionRow fixedCluster={false}>)。
 *
 * 归属:放进来的动作作用于**这一页的内容**(项目设置作用于当前项目),所以它跟着内容列走 ——
 * 和会话自己的控制跟着那一块走是同一个道理。❌ 开关面板那类窗口 chrome 动作不进这里,进 TitlebarActions。
 *
 * ⚠️ 宿主得是定位祖先,且它的上边缘就是这条 40px 带的上边缘。
 */
export function PageTitleActions({
  children,
  reserveFixedCluster,
}: {
  children: ReactNode;
  reserveFixedCluster: boolean;
}) {
  const right = reserveFixedCluster ? contentClusterReserve() : TITLEBAR_ACTION_EDGE_GAP_PX;

  return (
    <div
      className="absolute top-0 flex items-center"
      // 高度/间距/落点全部内联,和另外几个容器同一处方:这个组件的职责就是几何,
      // ❌ 别把它交给一个可能没被生成出来的 utility class(Tailwind v4 在本仓库静默丢过 utility)。
      style={{
        right: `${right}px`,
        height: `${WINDOW_CONTROL_BAR_HEIGHT_PX}px`,
        gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px`,
      }}
      data-page-title-actions=""
    >
      {children}
    </div>
  );
}

/**
 * 工作区页签条右端的动作组 —— 面板打开时,顶栏右端这一排**整排**都在这里:
 * 向右拆分 / 面板全屏 / 收起面板。
 *
 * 为什么「收起面板」也在这儿,而不是留在贴窗口的固定簇里:owner 三次实机圈同一排
 * (「这三个按钮高度不一致」→「一直漂移」→「一瘸一拐,一高一低」),最后点破了病根 ——
 * 「本质是不在同一个组件中,本来应该更统一的设计,而不是靠手动统一」。两个容器只要各自的
 * 竖直规则不同就会漂:Chrome 式页签给页签条加了顶部呼吸,这一组被带下去 3px,而贴窗口那个没动。
 * 共享常量治不了这个 —— 常量一样,宿主不一样。同一个容器里,基线是结构性的。
 *
 * 几何**留在这个文件里**而不是写在 tab-bar-actions.tsx 的那个 div 上,是为了让判据能咬住它:
 * 之前浏览器测试是自己搭一个 div、自己写上 gap 再去量那个 gap —— 产品里的 gap 删掉它照样绿,
 * 是一条判不了假的断言(#3783 自审漏掉的那条)。现在测试渲染的就是这个真组件 + 真页签条外壳。
 *
 * 右侧预留分两种,由 `atWindowEdge` 显式回答,❌ 不给默认值:最右那条直抵窗口右缘,要让开原生
 * 窗口控制条;左边那些分栏右侧是拖拽把手,让开窗口控制条会在分栏中间开一道洞。
 */
export function TabBarActionRow({
  children,
  atWindowEdge,
  fixedCluster = true,
}: {
  /**
   * 可以一个动作都没有 —— 草稿工作区面板那条页签条就是:它右边没有分栏级控制,但**右端一样贴着
   * 窗口固定簇**,照样得让位。空着的这一行就是那份预留,而预留的算法只有这一个出处
   * (titlebarActionsReserve)。❌ 别为了「反正没按钮」回到在调用点自己写一份右侧留白。
   */
  children?: ReactNode;
  /** 这条页签条是不是最右那条(右边再无分栏、直抵窗口右缘)。 */
  atWindowEdge: boolean;
  /** 窗口固定簇此刻在不在右边(会话页没有它,#7052)。只在 `atWindowEdge` 时有意义。 */
  fixedCluster?: boolean;
}) {
  return (
    <div
      className="flex shrink-0 items-center"
      // 几何全部内联,和这一横排另外三个容器同一处方。这里**必须**内联,不能交给 utility:
      // tokens.css 里那条 `*:not(.gugu-skin, …){margin:0;padding:0}` 没进任何 @layer,
      // 而无 layer 的声明压得过 `@layer utilities` —— 任何 `pl-*`/`pt-*` 在这层壳外面都会被静默抹平。
      //
      // 竖直位置**自己算**,不继承页签条的对齐:页签是 Chrome 式贴条(坐在条底、顶上留呼吸),
      // 按钮不是页签。高度钉成一个槽位、在这条 40px 带里居中,和贴窗口的固定簇是同一个式子,
      // 于是这一排跨容器也在同一条基线上(owner:「一瘸一拐,一高一低」正是继承了页签对齐)。
      style={{
        height: `${TITLEBAR_ACTION_SLOT_WIDTH_PX}px`,
        marginBlock: `${(WINDOW_CONTROL_BAR_HEIGHT_PX - TITLEBAR_ACTION_SLOT_WIDTH_PX) / 2}px`,
        alignSelf: 'flex-start',
        paddingInlineStart: `${TITLEBAR_ACTION_SLOT_GAP_PX * 2}px`,
        // 最右那条的右边就是常驻的窗口固定簇(收起面板那一枚,两态同一坐标),所以要按固定簇的
        // 真实成员数留位 —— 少留就是「按钮压住按钮」。左边那些分栏右侧是拖拽把手,只留一道边缘呼吸。
        // ❌ 别在这里手写数字:成员清单一变,这里跟着变。
        paddingInlineEnd: `${atWindowEdge ? contentClusterReserve(fixedCluster) : TITLEBAR_ACTION_EDGE_GAP_PX}px`,
        gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px`,
      }}
      data-tabbar-actions=""
      data-tabbar-actions-edge={atWindowEdge ? '' : undefined}
    >
      {children}
    </div>
  );
}
