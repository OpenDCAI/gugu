import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'

/**
 * @@@composer-toolbar-disclosure — composer 底排的**渐进披露**档位。
 *
 * owner 2026-09-05:「横着放不下就可以变成图标,占空间大的就变成图标」「渐进披露」。
 *
 * 为什么不是省略号、也不是换行:
 * - 换行会让卡片跟着某个标签的长度长高,而且左右两组各占一行、每行只用掉三分之二宽度,
 *   发送键还会离开它在右下角的固定位置(owner 圈过这三条)。
 * - 省略号是把信息切掉、地方还照占;收成图标是把地方让出来、意思还留着。
 *
 * 阶梯(每一档只多让一个标签,让的是「图标已经说得清」的那个):
 *
 * | 档 | 让位的 | 留下的 |
 * |---|---|---|
 * | 0 | — | 全部带文字 |
 * | 1 | agent 名字 | 品牌图形(星芒等),名字进 tooltip |
 * | 2 | 权限名字 | 形状 + 颜色编码的图标,名字进 tooltip |
 * | 3 | (原「编程 \| 通用」的另一半;那个分段控件已随手动切换删掉,这一档现在不收东西) | —— |
 * | 4 | 上下文用量读数(51k/1.0M) | —— 点开看的那份读数随之不在底排;它是读数不是控件,窄到这里先让 |
 * | 5 | 锁着的 agent 图标(任务开始后换不了的那颗) | —— 它只是在说「这条会话是谁」,页签上已经画着同一枚图形 |
 * | 6 | 模型名与强度档 | 厂商图形,名字进 tooltip(没有图形的模型不收,靠 ellipsis) |
 *
 * 档 4-6 的由来(#7052,2026-10-09):一屏几块之后,会话里一格最窄 220px(照 VS Code 编辑区一格的下限),
 * 那时底排只剩 142px,档 3 收完还要 200 多,发送键被顶出卡片。收到档 6 刚好放下 + / 权限 / 模型图形 / 发送。
 *
 * 档 3 的由来(owner 2026-09-05):我先做的是「把三枚下拉箭头一起收掉」,他实机看完判
 * 「箭头收了不合适」,改要「把那个编程和通用的切换弄成箭头,省点空间」。所以最后一档收的是
 * 这个分段控件的另一半 —— 两段并排变成一段带箭头的下拉,两个选项都还在,只是要点开才看见。
 *
 * (那个分段控件已随「通用 / 编程」手动切换删掉;档号不挪。)
 *
 * owner 2026-08-21「选不了的那一头要留在原地并说明原因」在档 3 仍然成立:两个选项都进了
 * 下拉,不可选的那一个是 disabled 而不是消失,原因照旧挂在触发器的 title 上。
 * ❌ 不收 + 与发送键:它们本来就是图标。
 * 模型名没有自己的图标(它只是一串名字),所以它**不进这个阶梯**——它靠自己的
 * ellipsis 兜底,是最后一道,不是一档。
 *
 * 判据是**真放不下**(`scrollWidth > clientWidth`),不是容器宽度到了某个数:
 * 模型名长度不受控(厂商起的名),同一个窗口宽度可能放得下也可能放不下,按宽度盲判必错。
 *
 * 收敛性:每升一档严格变窄,最多 `MAX_LEVEL` 档,所以最多重排 MAX_LEVEL 次就停。
 * 尺寸变化时回到 0 重新往上爬 —— 变宽了要能爬回来,否则只会越缩越小回不去。
 * 全程在 `useLayoutEffect` 里做,浏览器绘制前就定档,看不到中间态。
 */
export const TOOLBAR_DISCLOSURE_MAX_LEVEL = 6

/** 「编程 | 通用」那一档(档 3):塞进工具栏的分段控件从这一档起收成下拉。 */
const SEGMENTED_COLLAPSE_LEVEL = 3

/**
 * 「放不下」不能只看 `scrollWidth > clientWidth`。
 *
 * 底排里左组(`composer-actions-start`)带 `flexShrink: 1`,它会**把挤压整个吞掉**:
 * 自己被压窄、内容在它内部溢出,而底排的 scrollWidth 一点不涨。
 * 2026-09-05 实测:容器 378px 时左组渲染宽 74、内容 228,底排 client 374 / scroll 374 ——
 * 溢出读数恒为 0,阶梯一档都不会走。当时的修法是「往里看一层」,方向对。
 *
 * ⚠️ 但**两处都还是 `scrollWidth`,而这条查不出「可见溢出」**:左组没有 `overflow: hidden`,
 * 它的子控件是 `flexShrink: 0`,被挤时**原样溢出到盒子外面**(`overflow: visible`),
 * 而 `scrollWidth` 对这种溢出不保证计入 —— 于是读数仍旧恒 0。
 * 2026-09-06 实测(#5141,1280x900 真机):`data-disclosure` 停在 **0**、标签一个都没收,
 * 而 Work 按钮(x=726 w=50)被 harness 选择器(x=740 w=99)盖掉 36/50px,
 * 五点探针只有最左一点命中它自己。⇒ **不是布局压坏了,是这把尺子没读出来。**
 *
 * ⇒ 改用几何:直接比**边**。三种「放不下」各对应一条,任一成立即溢出:
 *   ① 子组越出底排的边;
 *   ② 相邻子组互相压(左组的内容压到右组身上,正是 #5141 的形状);
 *   ③ 子组自己的孩子越出该子组的边(左组被压窄、控件溢出去)。
 * 同族法则:`scrollWidth > clientWidth` 查不出
 * `overflow: visible` 的溢出,要用 `getBoundingClientRect` 边缘比对(两条边、自身+邻居)。
 */
const EDGE_EPSILON = 1

/**
 * 只有**参与正常流**的盒子才可能把这一行挤开。
 *
 * ⚠️ 这条不是防御性写法,是第一版判据的真实翻车点(2026-09-06 实测):Base UI 的 Radio 在每个
 * 分段里放一个视觉隐藏的 `<input>`,矩形是 `[-1, 0]` —— 宽 1px、绝对定位到容器外面。它天生
 * 就"越界",于是判据**在任何宽度、任何 composer 上恒为真**,阶梯一路顶到最高档、标签永远全收。
 * 那是一条**永远红的判据**,和永远绿的一样没用:它分不出"放得下"与"放不下"。
 * ⇒ 绝对/固定定位的元素排除掉 —— 它们脱离流,压根不会把兄弟挤开。
 */
function participatesInFlow(el: Element, rect: DOMRect): boolean {
  if (rect.width <= 0 && rect.height <= 0) return false
  const position = getComputedStyle(el).position
  return position !== 'absolute' && position !== 'fixed'
}

function isOverflowing(el: HTMLElement): boolean {
  // 有真滚动区的情况照旧先认它 —— 便宜且确定。
  if (el.scrollWidth > el.clientWidth + EDGE_EPSILON) return true

  const box = el.getBoundingClientRect()
  let previousRight: number | null = null
  for (const child of Array.from(el.children)) {
    const rect = child.getBoundingClientRect()
    // 被 CSS 收掉的(档 1/2 会 display:none 掉标签)与脱流的都不参与判断。
    if (!participatesInFlow(child, rect)) continue
    // ① 越出底排
    if (rect.right > box.right + EDGE_EPSILON || rect.left < box.left - EDGE_EPSILON) return true
    // ② 压到前一个兄弟
    if (previousRight !== null && rect.left < previousRight - EDGE_EPSILON) return true
    previousRight = rect.right
    // ③ 子组自己的孩子越出子组
    for (const grandChild of Array.from(child.children)) {
      const inner = grandChild.getBoundingClientRect()
      if (!participatesInFlow(grandChild, inner)) continue
      if (inner.right > rect.right + EDGE_EPSILON || inner.left < rect.left - EDGE_EPSILON) {
        return true
      }
    }
  }
  return false
}

export interface ToolbarDisclosure {
  /** 0 = 全文字;1 = agent 收成图标;2 = 权限也收成图标;3 =「编程 | 通用」收成下拉;4 = 用量读数让位;5 = 锁着的 agent 让位;6 = 模型只剩厂商图形。 */
  level: number
  /** 挂到底排那个 flex 行上。 */
  ref: (node: HTMLElement | null) => void
}

export function useToolbarDisclosure(): ToolbarDisclosure {
  const [level, setLevel] = useState(0)
  // 尺寸变了要重新判一次。❌ 只 setLevel(0) 不够:已经是 0 时那是空操作,不触发重渲染,
  // 检测用的 layout effect 就不会再跑 —— 2026-09-05 实测档位恒为 0 就是这么来的。
  const [recheck, setRecheck] = useState(0)
  const nodeRef = useRef<HTMLElement | null>(null)
  // 记住上一次量到的容器宽度:只有宽度真的变了才回到 0 重爬,
  // ❌ 别在每次 ResizeObserver 回调里无条件重置 —— 升档本身会改变尺寸,
  //    那样就是「重置 → 升档 → 触发 resize → 重置」的死循环。
  const lastWidthRef = useRef<number | null>(null)

  const setNode = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node
    lastWidthRef.current = null
  }, [])

  useLayoutEffect(() => {
    const el = nodeRef.current
    if (!el) return
    // 放不下就升一档。每次 render 后跑一次,一档一档爬,不在这里循环——
    // setLevel 会再触发一次 layout effect,天然就是下一次迭代。
    if (level < TOOLBAR_DISCLOSURE_MAX_LEVEL && isOverflowing(el)) {
      setLevel(level + 1)
    }
  }, [level, recheck])

  useLayoutEffect(() => {
    const el = nodeRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined) return
      const previous = lastWidthRef.current
      lastWidthRef.current = width
      // 宽度没变(是我们自己升档导致的重排)就别动档位,否则来回震荡。
      if (previous !== null && Math.abs(previous - width) < 1) return
      // 回到档 0 重爬(变宽了要能爬回来),并显式要求重判一次。
      setLevel(0)
      setRecheck((n) => n + 1)
    })
    observer.observe(el)

    // ⚠️ 只观察底排自己是不够的,而这正是 #5141 里阶梯"明明溢出却停在 0"的那一半原因:
    // 底排的宽度由卡片定(卡片有 max-width,窗口变宽它也不变),而**撑爆它的是内容**——
    // harness 名、模型名、权限档这些是异步到的,它们变宽时底排的 `contentRect.width` 一个像素
    // 都不动 ⇒ 这个回调不触发 ⇒ 阶梯永远不再判一次。
    // 2026-09-06 实测:1280 与 1700 两个宽度下 `data-disclosure` 都是 0,而同一时刻把判据
    // 拿到页面里跑是 `true`(`session-view-control [671,776]` 越出左组 `[466,736]`)。
    // ⇒ 判据没错,是**没人再问它一次**。
    //
    // 所以子组也要观察。❌ 但子组变化**不能**像容器那样 `setLevel(0)` 重爬:
    // 升档本身就会改变子组尺寸,那样就是「升档 → 子组变 → 重置 → 再升档」的死循环。
    // 这里只 `setRecheck`:效果是"再判一次,该升就升",而阶梯只升不降且有上界,必然收敛。
    const childObserver = new ResizeObserver(() => {
      setRecheck((n) => n + 1)
    })
    for (const child of Array.from(el.children)) childObserver.observe(child)

    return () => {
      observer.disconnect()
      childObserver.disconnect()
    }
  }, [])

  return { level, ref: setNode }
}

/**
 * 把当前档位透给塞进工具栏的外来控件(`toolbarExtra`)。
 *
 * 档 0-2 全靠 CSS 收标签,不需要谁知道档位;档 3 要换的是**渲染形态**(分段 → 下拉),
 * CSS 做不到 —— 用 CSS 藏掉一段就点不到那一段了。所以只有这一档需要把数字交出去。
 * 默认 0:控件被单独用在工具栏之外时,就是完整形态。
 */
const ToolbarDisclosureContext = createContext(0)

export const ToolbarDisclosureProvider = ToolbarDisclosureContext.Provider

/**
 * 「底排已经没地方了」—— 塞进工具栏的控件用它决定要不要让出最后一块。
 *
 * ❌ 故意**不**把档位数字交出去:消费方不该知道阶梯有几档、自己该在第几档动手,
 * 那样档位编号一改就得同步改两处,而漏改的那一边不会报错、只会静默不生效。
 * 交一个布尔,阈值留在定义阶梯的这一侧。
 */
export function useToolbarOutOfRoom(): boolean {
  return useContext(ToolbarDisclosureContext) >= SEGMENTED_COLLAPSE_LEVEL
}
