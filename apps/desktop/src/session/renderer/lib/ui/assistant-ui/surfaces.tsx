/**
 * Vendored from assistant-ui Elements（`elements-surfaces`）——**Elements 全家的公共底座**。
 *
 * 上游：`https://r.assistant-ui.com/elements-surfaces.json`
 * registry 里 94 个元素中的绝大多数 `import { … } from "./surfaces"`，所以它必须先落地，
 * 否则每搬一个元素都要重抄一份同样的 class 配方。
 *
 * 这一层只有 class 配方与两个纯展示 helper，**不含任何具体元素**（那是后续工单的事）。
 *
 * ## 相对上游的逐条改动
 *
 * 上游取值与本仓视觉规格硬限冲突时**本仓赢**（`docs/ui-visual-spec.md` §2/§4/§5/§6）。
 * 下表就是这些差异存在的理由，⚠️ 下次同步 registry 时不要把它们「改回去」。
 *
 * | 名字 | 上游 | 这里 | 为什么 |
 * |---|---|---|---|
 * | `paper` | `shadow-[0_1px_2px_rgba(…),0_12px_32px_-16px_rgba(…)]` | `bg-card`（**无影**） | §6：表面层级靠**底色**表达不靠投影。⚠️ 2026-09-22 按 design.md 统一：原来这里留了一条 `shadow-xs`，与同一行自述的判据自相矛盾 —— 「Shadows are zeroed globally. Only a floating surface may lift」，静置表面不是浮层 |
 * | `floating` | 同上另一组任意值双层投影 | `bg-popover rounded-surface shadow-lift` | §6.1：菜单/下拉/弹层**只有一种表达**。⚠️ 2026-09-22 按 design.md 统一，原配方是 `shadow-sm ring-1 ring-foreground/10`：「Do not stack a border, a ring, and a shadow on one edge」——浮层只需要「抬起来」那一层，环是第二条线。圆角补到 `--radius-surface`（#7333 起 12px）那一档；抬起的那一层是全仓唯一的 `--shadow-lift`，而不是 Tailwind 内置的 `shadow-sm`（0 1px 3px）——同一个 composer 里 `packages/session-ui` 那半边画的就是 lift，两半边深浅不一读起来像两类东西 |
 * | `ghostButton` | `focus-visible:ring-foreground/20` | `focus-visible:ring-border-primary` | §7：焦点强调色走 `--color-ring`→`--border-primary`，不另起一份 |
 * | `labelSwap` | 6px 的半步 gap | `gap-2`（8px） | §4：0.5 步进 utility 由 `check-ui-visual-spec.mts` 双向棘轮冻结（会话页基线 341，只减不增），新增一处就会红。⚠️ 那把尺子按**源码文本**计数，注释里的取值和代码里的取值同形 —— 所以这一行不能把上游那个字面量写出来，写出来它自己就会把棘轮顶破一格（实测：342 vs 341） |
 * | `mono` | 上游 11 像素的任意值 | `text-tiny` | §2：走 `--text-tiny` 这一档 token（#7333 起并入 12 的标注档） |
 * | `live` | `text-blue-500 dark:text-blue-400` | `text-live` | 2026-09-22 按 design.md 统一：「`blue-500` means live: streaming, running, connected, or currently selected」。原裁决（2026-08-12）是 `text-primary`，理由是「当时会话页主题里 `--color-(info\|blue)` 读到 0 ⇒ jade 是唯一可用强调色」——那个前提已不成立：`index.css` 现在有 `--color-live`（#6104 的唯一 accent 档）。⚠️ 代用期间 live 是绿的、而蓝被拿去标已完成态，两个强调色在同屏争；现在回到「一次只有一个强调色，那个色是蓝」 |
 * | 各处 `duration-150/200/300` | 裸数字 | `duration-[var(--dur-fast,120ms)]` / `-med,180ms` | 时长走 token 档位（沿用 `thread-welcome.tsx` 已有先例） |
 * | `cn` | `@/lib/utils` | `@renderer/utils/utils` | 本仓路径 |
 *
 * ## `collapsePanel` 一个字没改，因为上游本来就是双栈写的
 *
 * 上游源码里同时出现 `data-open`（Radix）与 `data-panel-open` / `data-[starting-style]` /
 * `data-[ending-style]`（Base UI）两套属性，`--collapsible-panel-height` 也是 Base UI Collapsible
 * Panel 的变量。而本仓 `lib/ui/collapsible.tsx` 用的正是 `@base-ui/react/collapsible` 的
 * `Collapsible.Panel`，`data-[starting-style]` / `data-[ending-style]` 在本仓也已是既有写法
 * （`components/ui/variants.ts:76-78`、`Sheet.tsx:14`）。
 *
 * ✅ `--collapsible-panel-height` 在本仓**已经有 4 个生产消费者**，写法与本文件的 `collapsePanel`
 * 完全一致（`h-(--collapsible-panel-height)` 配 `CollapsibleContent`）：
 * `session-config/setup-step-preview.tsx:26`、`session-config/workspace-summary-alert.tsx:65`、
 * `session-config/branch-picker-field.tsx:72`、`automations/components/CreateAutomationView.tsx:153`。
 * 截至 2026-08-12，`grep -rn -- collapsible-panel-height apps packages` 读到这 4 处
 * （阳性对照：同命令查 `var(--radius` 读到 18 个文件）⇒ 这个变量在本仓是**跑通的**。
 *
 * ⚠️ 本段原文写的是「本仓还没有任何消费者，所以真能拿到高度只是读文档的推断」——**那句是假的，
 * 而且写下时就假**。成因是我当初那条搜索用了 `| head -8` 截断：该命令实际命中 22 行，
 * 而 `collapsible-panel-height` 从第 10 行才开始 ⇒ 我看到的 8 行全是 `ending-style`，
 * 于是把「没搜到」当成了「不存在」。**截断过的搜索不能用来支持否定性结论。**
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@renderer/utils/utils';

/** 静置表面：比页底高一阶的卡片/面板。**不抬起来** —— 层级由底色阶表达。 */
export const paper = 'bg-card';

/** 浮层：菜单 / 下拉 / 选择器 / 弹出层。本仓唯一表达，见 ui-visual-spec §6.1。 */
export const floating = 'bg-popover rounded-surface shadow-lift';

/** 内嵌字段底：请求/结果 payload、代码块这类「凹进去」的区域。 */
export const field = 'bg-foreground/[0.04] dark:bg-foreground/[0.06]';

// @@@state-ladder-mix 这一条**不能**换成 bg-row-*:它的静止态本身就是一层 4% 叠色,而 Tailwind 的
// `hover:bg-*` 是**替换** background-color、不是再叠一层 —— 换上去之后 hover(2.4%)反而比静止(4%)更浅,
// 方向是反的。字段面的静止态是自己的「表面」,状态增量另算,所以保留原值(增量 +3%,与阶梯的 2.4% 同量级)。
// (现全仓 0 消费者;留着是因为 field/mono 同族在用,删它是另一件事。)
export const fieldInteractive =
  'bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]';

export const pressable =
  'transition-transform duration-[var(--dur-fast,120ms)] ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none';

// @@@radius-scale 图标按钮是**控件**不是状态点:胶囊档(--radius-capsule)只给 switch / 头像 /
// 状态点。最小的图标按钮落在 sm(6px)那一档。
export const ghostButton =
  'flex items-center justify-center rounded-sm text-foreground/45 outline-none transition-[background-color,color] duration-[var(--dur-fast,120ms)] hover:bg-row-hover hover:text-foreground/90 focus-visible:bg-row-hover focus-visible:text-foreground/90 active:bg-row-press motion-reduce:transition-none';

export const inkButton =
  'bg-foreground text-background transition-opacity duration-[var(--dur-fast,120ms)] ease-[var(--ease,cubic-bezier(0.2,0.8,0.2,1))] hover:opacity-[.88] active:opacity-[.78] motion-reduce:transition-none';

export const iconSwap =
  '[grid-area:1/1] transition-[opacity,scale,filter] duration-[var(--dur-med,180ms)] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none';

export const iconSwapIn = 'scale-100 opacity-100 blur-none';

export const iconSwapOut = 'scale-[0.25] opacity-0 blur-[4px]';

export const labelSwap =
  'col-start-1 row-start-1 flex w-max items-center gap-2 leading-none transition-[opacity,filter] duration-[var(--dur-med,180ms)] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none';

export const labelSwapIn = 'opacity-100 blur-none';

export const labelSwapOut = 'pointer-events-none select-none opacity-0 blur-[2px]';

/**
 * 折叠面板的高度补间。消费 Base UI Collapsible Panel 的 `--collapsible-panel-height`
 * 与 `data-[starting-style]` / `data-[ending-style]`。本仓已有 4 个同写法的生产消费者，见文件头。
 */
export const collapsePanel =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-[var(--dur-med,180ms)] ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none';

/** 「正在发生」的强调色：streaming / running / connected / 当前选中。全站唯一的 accent。 */
export const live = 'text-live';

export const mono = 'font-mono text-tiny tracking-tight';

/**
 * 保留自身空白的内容的滚动区。`whitespace-pre` 放进定长盒子会把长行裁掉且无法触达，
 * 所以让行自己横向滚动。
 *
 * `codeSurface` 把所有行**当作一整块**包起来，行是它的子节点。它不能挂在每一行上：
 * `min-width: 100%` 是相对滚动容器的**可见宽度**解析的，不是它的滚动宽度 ——
 * 逐行挂会让除最长行以外的每一行的背景都在折叠处断掉。
 */
export const codeScroll = 'overflow-x-auto';

export const codeSurface = 'w-max min-w-full';

/**
 * 两层标签的等宽交叉淡入：测量当前激活层的宽度并补间容器宽度，
 * 这样「Running…」换成「Ran」时不会让右边的东西跳一下。
 */
export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () => setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        'grid overflow-x-clip transition-[width] duration-[var(--dur-slow,300ms)] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
        className
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(labelSwap, active === index ? labelSwapIn : labelSwapOut)}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
