// 会话页里的格子,咕咕壳往里画自己的组件(从 #7199 助理的那座桥里原样抽出来的那一半,gugu-dev#181 项目块也要用)。
//
// 会话页和壳是同一个 document 里各自的 React 根,壳的 context 到不了会话页:会话页在自己页面上留一个空格子
// (DOM 节点)登记在这里,壳把自己的组件 portal 进去 —— 那些组件照旧在壳的 context 里跑(聊天、通讯录、设置……),
// ❌ 在会话页里另写一份。
//
// 格子按字符串认:`assistant:<格>` 是助理那几格,`chat:<对话 id>` 是画一个对话(项目块里的项目群、对话块)。
// 谁登记了哪种前缀的格,由壳那边认这个前缀的那一处去画;一个键同一时刻只有一个格子。
// 只由壳装(装在 window 上);会话页 bundle 只读写 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。

import { createContext, useContext } from 'react'

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

/**
 * 同一个对话在块的页签条上的几格(gugu-dev#181:块里没有群聊头,头上那些东西挪到页签条):
 * `actions` = 右端那排图标(搜索、群文件夹、成员、历史、⋯),`title` = 对话块第一枚页签上的头像和名字,
 * `tabs` = 第一枚页签后面那几枚(开着的话题,和群对话并排成一对)。
 * 和 `chat:` 那格一起由 ChatSlotHost 交给同一个群聊组件,❌ 单独画。
 */
export type ChatPart = 'actions' | 'title' | 'tabs' | 'empty'
export const chatPartSlotKey = (part: ChatPart, chatId: string) => `chat-${part}:${chatId}`

/**
 * 对话块里一枚页签此刻在屏上的那一格(群文件夹、App、文件、话题):会话页的页签引擎留格子,壳把这一枚的内容画进来
 * (components/chat/ChatTabPortals.tsx)。只有在屏上的页签有格子。
 */
const CHAT_TAB_SLOT_PREFIX = 'chat-tab:'
export const chatTabSlotKey = (chatId: string, tabId: string) => `${CHAT_TAB_SLOT_PREFIX}${chatId}/${tabId}`

/**
 * 这个对话是不是画在会话页的格子里(项目块、对话块,gugu-dev#181):ChatSlotHost 给它包上;不在格子里 = null。
 * 输入框据此换成格子里的排法(「新任务 / 定时任务」在框内底排,能换成会话页那一侧的框);❌ 去 DOM 里找格子猜。
 * `projectName`:它是项目群时,那个项目的名字(输入框提示「发消息给 X…」);别的对话 = null。
 */
export const InChatSlot = createContext<{ projectName: string | null } | null>(null)
export const useInChatSlot = () => useContext(InChatSlot) !== null
export const useChatSlotProjectName = () => useContext(InChatSlot)?.projectName ?? null
