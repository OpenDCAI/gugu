// 输入框此刻是不是「新任务 / 定时任务」(gugu-dev#181「输入框」:框里「+」右边两个词,选了一个,框就换成那件事)。
//
// 按对话记:每个对话一格。壳那棵树的输入框(InputArea)写,会话页那棵读 —— 项目块据此把新任务的框摆在群聊底下、
// 浮出文件夹卡;对话页也读,据此收起自己的框。同一个 window 对象 + 一个 window 事件(与 chatSummariesBridge 同一做法),
// 两边都只 import 这一个文件,❌ 各写一份键名。
//
// 新任务的框会默认选中的那个 agent(和它的标)也在这里:会话页那一侧算得出(设置、记忆、装没装都在那边)、发布,
// 壳的「新任务」按钮读它画标 —— 那也是新任务框的状态。
import { useSyncExternalStore } from 'react'
import type { AgentIconAsset } from '../session/shared/core/agents/agent-payload'

export type ComposerVerb = 'task' | 'schedule'

const KEY = '__GUGU_COMPOSER_VERBS__'
const EVENT = 'gugu:composer-verb'

function verbs(): Map<string, ComposerVerb> {
  const holder = window as unknown as Record<string, unknown>
  let map = holder[KEY] as Map<string, ComposerVerb> | undefined
  if (!map) {
    map = new Map()
    holder[KEY] = map
  }
  return map
}

/** 选词的那个对话是什么:群名,以及派出去的 agent 进不进得了它(群 = 进;和人的私聊 = 进不去)。会话页那一侧不知道这些。 */
export interface ComposerVerbChat {
  name: string
  joinable: boolean
}

const CHAT_KEY = '__GUGU_COMPOSER_VERB_CHATS__'

function chats(): Map<string, ComposerVerbChat> {
  const holder = window as unknown as Record<string, unknown>
  let map = holder[CHAT_KEY] as Map<string, ComposerVerbChat> | undefined
  if (!map) {
    map = new Map()
    holder[CHAT_KEY] = map
  }
  return map
}

/** 选词那一刻记下的对话(没经输入框选过 = null,例如群成员「新建 Agent 并加入本群」直接设的词)。 */
export function readComposerVerbChat(chatId: string): ComposerVerbChat | null {
  return chats().get(chatId) ?? null
}

const CARRY_KEY = '__GUGU_COMPOSER_VERB_CARRY__'

function carries(): Map<string, string> {
  const holder = window as unknown as Record<string, unknown>
  let map = holder[CARRY_KEY] as Map<string, string> | undefined
  if (!map) {
    map = new Map()
    holder[CARRY_KEY] = map
  }
  return map
}

/**
 * 选了一个词(null = 点了标签上的 ×,框还原)。`carry` = 框里已经写了的话,跟着换上来的那个框走(由接手的那一侧
 * `takeComposerCarry` 取走一次):选词时从发消息的框带进新任务的框,点 × 时从新任务的框带回发消息的框 —— 同一条路两个方向。
 */
export function setComposerVerb(chatId: string, verb: ComposerVerb | null, carry?: string, chat?: ComposerVerbChat): void {
  if (carry?.trim()) carries().set(chatId, carry)
  if (verb && chat) chats().set(chatId, chat)
  const map = verbs()
  if ((map.get(chatId) ?? null) === verb) return
  if (verb) map.set(chatId, verb)
  else map.delete(chatId)
  window.dispatchEvent(new Event(EVENT))
}

/** 选词那一刻框里写着的话;取一次就没了。 */
export function takeComposerCarry(chatId: string): string {
  const text = carries().get(chatId) ?? ''
  carries().delete(chatId)
  return text
}

export function readComposerVerb(chatId: string): ComposerVerb | null {
  return verbs().get(chatId) ?? null
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** 这个对话的输入框此刻是哪个词;没选 = null(就是发消息)。 */
export function useComposerVerb(chatId: string | null | undefined): ComposerVerb | null {
  return useSyncExternalStore(subscribe, () => (chatId ? readComposerVerb(chatId) : null), () => null)
}

/** 新任务的框会默认选中的那个 agent 和它的标(没有 = null)。 */
export interface DefaultTaskAgent {
  id: string
  icon: AgentIconAsset
}

const DEFAULT_AGENT_KEY = '__GUGU_COMPOSER_VERB_DEFAULT_AGENT__'

function readDefaultTaskAgent(): DefaultTaskAgent | null {
  return ((window as unknown as Record<string, unknown>)[DEFAULT_AGENT_KEY] as DefaultTaskAgent | undefined) ?? null
}

/** 会话页:默认的那个 agent 变了。没变不通知。 */
export function publishDefaultTaskAgent(agent: DefaultTaskAgent | null): void {
  const current = readDefaultTaskAgent()
  if (current?.id === agent?.id && current?.icon === agent?.icon) return
  ;(window as unknown as Record<string, unknown>)[DEFAULT_AGENT_KEY] = agent
  window.dispatchEvent(new Event(EVENT))
}

/** 壳:「新任务」按钮上画哪个 agent 的标。 */
export function useDefaultTaskAgent(): DefaultTaskAgent | null {
  return useSyncExternalStore(subscribe, readDefaultTaskAgent, () => null)
}
