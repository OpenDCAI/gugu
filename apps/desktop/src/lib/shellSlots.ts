// 会话页里的格子,咕咕壳往里画自己的组件(从 #7199 助理的那座桥里原样抽出来的那一半,gugu-dev#181 项目块也要用)。
//
// 会话页和壳是同一个 document 里各自的 React 根,壳的 context 到不了会话页:会话页在自己页面上留一个空格子
// (DOM 节点)登记在这里,壳把自己的组件 portal 进去 —— 那些组件照旧在壳的 context 里跑(聊天、通讯录、设置……),
// ❌ 在会话页里另写一份。
//
// 格子按字符串认:`assistant:<格>` 是助理那几格,`chat:<对话 id>` 是画一个对话(项目块里的项目群、对话块)。
// 谁登记了哪种前缀的格,由壳那边认这个前缀的那一处去画;一个键同一时刻只有一个格子。
// 只由壳装(装在 window 上);会话页 bundle 只读写 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。

export const SHELL_SLOTS_KEY = '__GUGU_SHELL_SLOTS__' as const

export interface ShellSlots {
  /** 会话页:这一格的 DOM 节点挂上 / 摘掉(null)。 */
  setSlot(key: string, element: HTMLElement | null): void
  getSlots(): ReadonlyMap<string, HTMLElement>
  subscribeSlots(listener: () => void): () => void
}

type SlotsWindow = Window & { [SHELL_SLOTS_KEY]?: ShellSlots }

let slots = new Map<string, HTMLElement>()
const listeners = new Set<() => void>()

const registry: ShellSlots = {
  setSlot: (key, element) => {
    if ((slots.get(key) ?? null) === element) return
    const next = new Map(slots)
    if (element) next.set(key, element)
    else next.delete(key)
    slots = next
    for (const listener of listeners) listener()
  },
  getSlots: () => slots,
  subscribeSlots: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

/** 壳:装上(幂等)。 */
export function installShellSlots(w: Window = window): void {
  const target = w as SlotsWindow
  if (target[SHELL_SLOTS_KEY] !== registry) target[SHELL_SLOTS_KEY] = registry
}

/** 读 window 上那一份;壳还没装上 = null(会话页先于壳挂上的那一瞬)。 */
export function readShellSlots(w: Window = window): ShellSlots | null {
  return (w as SlotsWindow)[SHELL_SLOTS_KEY] ?? null
}

/** 画一个对话的那种格子(项目块里的项目群、对话块):壳那边 components/ChatSlotHost.tsx 认这个前缀。 */
export const CHAT_SLOT_PREFIX = 'chat:'
export const chatSlotKey = (chatId: string) => `${CHAT_SLOT_PREFIX}${chatId}`
