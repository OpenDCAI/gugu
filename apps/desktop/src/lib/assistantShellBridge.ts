// #7199 「助理」App 两棵树之间的桥(形制同 identityDirectoryBridge:window 上一个对象 + getSnapshot / subscribe)。
//
// 「助理」是会话页的一个视图(左栏一格,与资源库同形),而它要用的几样东西住在咕咕壳那棵树里:云电脑的状态、
// 通讯录里的个人助理、设置里的聊天渠道 / 设备授权页 / 云电脑开关。两棵树是同一个 document 里各自的 React 根,
// 壳的 context 到不了会话页。于是:
//   · 壳 → 会话页:壳把「此刻的样子」发布在这里(有没有云电脑、它的状态、个人助理是谁、主人叫什么);
//   · 会话页 → 壳:会话页在自己页面上留一个空格子(slot),壳把自己的组件 portal 进去 —— 格子登记在公共的
//     lib/shellSlots.ts(键 `assistant:<格>`),这些组件照旧在壳的 context 里跑,❌ 在会话页里另写一份。
// 桥只由壳装(AssistantShellHost 挂上时);会话页 bundle 只读写 window 上那一个对象,❌ 自己装(会装上一个永远空的副本)。
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { AssistantHomePlace } from './assistantHome'

export type AssistantShellAssistant = {
  id: string
  display_name: string
  avatar: string | null
  created_at: string | null
}

/**
 * 新用户第一次打开 = 给它安家(owner 10-16:欢迎 → 起名、选主题色 → 你的称呼和基本信息 → 安家 → 连几个常用应用(可跳过)→ 进 App,它先开口)。
 * 'shell' = 欢迎到安家那几步(壳画进 `onboarding` 格子:要会员档、建 agent、管家);'connect' = 连应用(会话页画,要它家那台的集成);
 * 'ready' = 一切就绪那一页。null = 不在引导里(早就有它了 / 走完了)。
 */
export type AssistantSetupStep = 'shell' | 'connect' | 'ready'

export type AssistantShellSnapshot = {
  /** 管家说这里能开云电脑(会员一键领取、住云上)。false = 只能装在自己的电脑上。 */
  cloudAvailable: boolean
  /** 这台能当它的家(桌面版:有本机运行时)。网页 / 手机 = false。 */
  canHostHere: boolean
  cloud: CloudComputerSnapshot | null
  /** 读管家状态失败的那一类(网络 / 拒绝……);null = 没失败。 */
  loadError: string | null
  assistant: AssistantShellAssistant | null
  /**
   * 认它的那一次读库(lib/myAssistant.ts)读到了什么:found = 找到且通讯录里有它;loading = 还在读 / 通讯录还没跟上;
   * none = 这台云电脑上没有标记为助理的 agent;unreadable = 读失败(≠ 没有,页面照实说读不到)。
   */
  assistantState: 'found' | 'loading' | 'none' | 'unreadable'
  ownerName: string | null
  /** 和它的那条私聊(还没认出来 = null):「今天」页读这条私聊文件夹里的 today.json。 */
  chatId: string | null
  /** 它住哪(云上 / 某台电脑);还没有它、还认不出 = null。 */
  home: AssistantHomePlace | null
  setup: AssistantSetupStep | null
  /**
   * 是不是会员(会员一键领取住云上;非会员装在自己的电脑):最左栏顶上那一格在「还没有咕咕」时按它写悬停提示
   * (领取你的咕咕 / 创建你的咕咕)。null = 还没读到 / 读不到(❌ 当成非会员)。
   */
  member: boolean | null
  /** 正在给它安家(云上正在开 / 本机正在建):入口那一格画转圈,❌ 画成坏掉或「没有」。 */
  preparing: boolean
}

/** 壳往会话页里画的那几格(在 lib/shellSlots.ts 里登记为 `assistant:<格>`)。新增一格 = 这里加一个名字 + AssistantShellHost 里配一个组件。 */
export type AssistantShellSlot = 'onboarding' | 'chat' | 'task-chat' | 'devices' | 'connectors' | 'connectors-device' | 'connectors-other' | 'settings'
// 连接应用复用全局设置的同一个组件,在助理资料页直接展开;聊天工具与状态仍走设置。
// ⚠ 'connectors-device' / 'connectors-other' 只为「助理安家」的 assistant-capabilities.tsx(安好家之后的「连应用」一步,设置重做把它删了)暂时编得过,
// 总分支把两边对齐时一起去掉(那一步该用设置里的连接应用)。

/** 会话页要壳替它做的几件事(那些状态只在壳那棵树里:通讯录、agent 设置弹窗)。 */
export type AssistantShellActions = {
  /** 改它的名字(与 agent 设置里改名同一条路:云端身份 + 本机花名册)。 */
  renameAssistant(name: string): Promise<void>
  /** 打开它的形象工坊(agent 设置的「形象」那一页)。 */
  openLook(): void
  /** 再问一次管家云电脑此刻的样子(读不到时页面上的「重试」)。 */
  refreshCloud(): void
  /** 引导往下走一步(连应用 → 一切就绪)/ 走完(null)。 */
  advanceSetup(next: AssistantSetupStep | null): void
}

/**
 * #7199 语音笔记的录音机在会话页那一侧(它要读写云电脑);聊天框「+」在壳这一侧。会话页挂上时登记这一份,
 * 壳的「+」菜单照它画「录制语音笔记」(正在录时置灰),点了叫它开录。
 */
export type AssistantVoiceNoteHandler = {
  /** 开录;从会议提醒开始的带上那场会(写进这条笔记,交给助理时一并说)。 */
  start(meeting?: { title: string; start: string; end: string | null }): Promise<boolean>
  busy(): boolean
  subscribe(listener: () => void): () => void
}

export interface AssistantShellBridge {
  getSnapshot(): AssistantShellSnapshot | null
  subscribe(listener: () => void): () => void
  /** 会话页:把这句话(和要带上的文件,如「分析健康报告」选的那份)填进和个人助理那条私聊的输入框(只填不发,人看过再发)。 */
  fillChatDraft(text: string, files?: File[]): void
  /** 壳:取走还没填进去的那句(那条私聊就绪时取);没有 = null。 */
  takeChatDraft(): AssistantChatDraft | null
  subscribeChatDraft(listener: () => void): () => void
  /** 壳挂上时登记、卸下时清空;会话页读到 null = 壳还没挂上。 */
  setActions(actions: AssistantShellActions | null): void
  getActions(): AssistantShellActions | null
  /** 会话页:登记 / 注销语音笔记的录音机(见 AssistantVoiceNoteHandler)。 */
  setVoiceNoteHandler(handler: AssistantVoiceNoteHandler | null): void
  getVoiceNoteHandler(): AssistantVoiceNoteHandler | null
  subscribeVoiceNoteHandler(listener: () => void): () => void
}

/** 填进输入框的那一份:一句话,和要作为附件带上的文件(没有 = 空)。 */
export type AssistantChatDraft = { text: string; files: File[] }

export const ASSISTANT_SHELL_BRIDGE_KEY = '__GUGU_ASSISTANT_SHELL__' as const

type BridgeWindow = Window & { [ASSISTANT_SHELL_BRIDGE_KEY]?: AssistantShellBridge }

let current: AssistantShellSnapshot | null = null
const listeners = new Set<() => void>()
let pendingDraft: AssistantChatDraft | null = null
let actions: AssistantShellActions | null = null
const draftListeners = new Set<() => void>()
let voiceNoteHandler: AssistantVoiceNoteHandler | null = null
const voiceNoteListeners = new Set<() => void>()

const bridge: AssistantShellBridge = {
  getSnapshot: () => current,
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  fillChatDraft: (text, files = []) => {
    pendingDraft = { text, files }
    for (const listener of draftListeners) listener()
  },
  takeChatDraft: () => {
    const draft = pendingDraft
    pendingDraft = null
    return draft
  },
  subscribeChatDraft: (listener) => {
    draftListeners.add(listener)
    return () => {
      draftListeners.delete(listener)
    }
  },
  setActions: (next) => {
    actions = next
  },
  getActions: () => actions,
  setVoiceNoteHandler: (handler) => {
    if (voiceNoteHandler === handler) return
    voiceNoteHandler = handler
    for (const listener of voiceNoteListeners) listener()
  },
  getVoiceNoteHandler: () => voiceNoteHandler,
  subscribeVoiceNoteHandler: (listener) => {
    voiceNoteListeners.add(listener)
    return () => {
      voiceNoteListeners.delete(listener)
    }
  },
}

/** 壳:装桥(幂等)。 */
export function installAssistantShellBridge(w: Window = window): void {
  const target = w as BridgeWindow
  if (target[ASSISTANT_SHELL_BRIDGE_KEY] !== bridge) target[ASSISTANT_SHELL_BRIDGE_KEY] = bridge
}

/** 壳:发布此刻的样子(没变就不通知)。 */
export function publishAssistantShell(snapshot: AssistantShellSnapshot): void {
  if (current && sameSnapshot(current, snapshot)) return
  current = snapshot
  for (const listener of listeners) listener()
}

function sameSnapshot(a: AssistantShellSnapshot, b: AssistantShellSnapshot): boolean {
  return (
    a.cloudAvailable === b.cloudAvailable &&
    a.canHostHere === b.canHostHere &&
    a.setup === b.setup &&
    JSON.stringify(a.home) === JSON.stringify(b.home) &&
    a.loadError === b.loadError &&
    a.ownerName === b.ownerName &&
    a.assistantState === b.assistantState &&
    a.chatId === b.chatId &&
    JSON.stringify(a.cloud) === JSON.stringify(b.cloud) &&
    JSON.stringify(a.assistant) === JSON.stringify(b.assistant)
  )
}

/** 会话页:读 window 上那一个桥;壳还没装上 = null(会话页先于壳挂上的那一瞬)。 */
export function readAssistantShellBridge(w: Window = window): AssistantShellBridge | null {
  return (w as BridgeWindow)[ASSISTANT_SHELL_BRIDGE_KEY] ?? null
}

/** 助理这一格在公共格子表里的键。 */
export const assistantSlotKey = (slot: AssistantShellSlot) => `assistant:${slot}`
