// 输入框此刻是不是「新任务 / 定时任务」(gugu-dev#181「输入框」:框里「+」右边两个词,选了一个,框就换成那件事)。
//
// 按对话记:每个对话一格。壳那棵树的输入框(InputArea)写,会话页那棵读 —— 项目块据此把新任务的框摆在群聊底下、
// 浮出文件夹卡;对话页也读,据此收起自己的框。同一个 window 对象 + 一个 window 事件(与 chatActivityBridge 同一做法),
// 两边都只 import 这一个文件,❌ 各写一份键名。
import { useSyncExternalStore } from 'react'

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
 * 选了一个词(null = 点了标签上的 ×,框还原)。`carry` = 框里已经写了的话,跟着进新任务的框(由接手的那一侧
 * `takeComposerCarry` 取走一次)。
 */
export function setComposerVerb(chatId: string, verb: ComposerVerb | null, carry?: string): void {
  if (verb && carry?.trim()) carries().set(chatId, carry)
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
