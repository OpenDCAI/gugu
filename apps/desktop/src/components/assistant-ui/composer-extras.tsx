import { NeedsYouSlot } from '../needsYou/NeedsYouSlot'
import { createContext, useContext, type ReactNode } from 'react'

/**
 * 官方 `thread.aui.tsx` 里给宿主留的两个插槽。
 *
 * 为什么要加这么一层：orca 手机端把「模型 / 权限档」做成**输入框操作行里的一个胶囊**
 * （`MobileNativeChatComposer` 的 actionRow 里就摆着 `MobileNativeChatSessionOptionPickers`），
 * 又把「Agent 在干活」这类瞬时状态摆在**输入框正上方**（`MobileAgentWorkingIndicator`）。
 * 官方 assistant-ui 的 `Thread` 只给消息侧留了 `components` 覆盖点，输入框这一带没有插槽。
 *
 * 与其把宿主自己的东西直接编进官方源码，不如留两个 context，官方那份只多几行：
 *   · `inline` → 操作行里，和发送键同一排（会话选项胶囊）
 *   · `above`  → 输入框上方，随输入框贴底（发送失败）
 *   · `tail`   → 时间线末尾，在消息流里跟着滚（还等着人答、流里又没有那一行的审批 / 提问卡）
 *   · `stop`   → 远端在跑时，发送键位置换成停止键（照桌面端 ChatComposer）
 *
 * ❌ 「Agent 在干活」不再占输入框上方一整行：页头状态词已经说了同一件事，
 *    那一行只是把停止键托着，而停止键本就该在输入框里（owner 2026-09-24 真机）。
 *
 * ⚠️ `above` 必须在 `ViewportFooter` 之内：那个容器会把自己的高度登记成视口的内容内边距，
 * 摆在外面不会报错，只会让「回到底部」少算这一块（它自己的源码就是这么算的）。
 */
export type ComposerStop = { onStop: () => void; stopping: boolean }

type Slots = { inline: ReactNode; above: ReactNode; tail: ReactNode; placeholder: string | null; stop: ComposerStop | null }

const ComposerSlotsContext = createContext<Slots>({ inline: null, above: null, tail: null, placeholder: null, stop: null })

export function ComposerExtrasProvider({
  children,
  extras,
  above = null,
  tail = null,
  placeholder = null,
  stop = null
}: {
  children: ReactNode
  /** 操作行里的东西，和发送键同排。 */
  extras: ReactNode
  /** 输入框正上方的东西。它在贴底的那一带里,❌ 放高度没上限的东西:比视口高就把整个视口盖住。 */
  above?: ReactNode
  /**
   * 时间线末尾、在消息流里的东西。待答的审批/提问卡放这里:最后一条消息之后、跟着时间线滚 ——
   * 视口跟到底时就在眼前,卡片再高也能整张滑着看完(2026-10-02:3 题 × 4 选项的卡钉在贴底带里,
   * 卡高 1233 > 视口 778,手指滑了屏幕纹丝不动)。
   */
  tail?: ReactNode
  /**
   * 输入框占位文字。官方那份从 copy.ts 取「回复…」—— 对着一条已存在的会话是对的；
   * 新建页上还没有可回复的东西，同一句就成了误导（人会以为进错了会话）。宿主给了就用宿主的。
   */
  placeholder?: string | null
  /**
   * 远端那一轮正在跑、能停。给了就在**输入框为空时**把发送键换成停止键；一旦打了字又换回发送键 ——
   * 机器端在跑时 `send` 是排队，手机没有「回车发送」，发送键不能被停止键永久顶掉。
   * ❌ 不借官方的 isRunning/onCancel：那会锁输入框（理由见 AgentThread）。
   */
  stop?: ComposerStop | null
}) {
  return (
    <ComposerSlotsContext.Provider value={{ inline: extras, above, tail, placeholder, stop }}>
      {children}
    </ComposerSlotsContext.Provider>
  )
}

/** 宿主指定的占位文字；没给就 null，官方那份退回 copy.ts 的默认。 */
export function useComposerPlaceholder(): string | null {
  return useContext(ComposerSlotsContext).placeholder
}

/** 宿主给的停止能力；没给就 null，操作行照官方原样。 */
export function useComposerStop(): ComposerStop | null {
  return useContext(ComposerSlotsContext).stop
}

/** 操作行插槽；宿主没塞就什么都不画。 */
export function ComposerExtras() {
  return <>{useContext(ComposerSlotsContext).inline}</>
}

/** 输入框上方插槽；宿主没塞就什么都不画。 */
export function ComposerAboveExtras() {
  return <>{useContext(ComposerSlotsContext).above}<NeedsYouSlot /></>
}

/** 时间线末尾插槽；宿主没塞就什么都不画。 */
export function ThreadTailExtras() {
  return <>{useContext(ComposerSlotsContext).tail}</>
}
