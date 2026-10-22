// 新任务的框会默认选中的那个 agent 和它的标(gugu-dev#181):会话页那棵树算得出(设置、记忆、装没装都在那边),
// 壳那棵树里群输入框上的「新任务」按钮要画它。会话页写、壳读,同一个 window 对象 + 一个 window 事件
// (与 composerVerbBridge 同一做法),两边都只 import 这一个文件。
import { useSyncExternalStore } from 'react'
import type { AgentIconAsset } from '../session/shared/core/agents/agent-payload'

export interface DefaultTaskAgent {
  id: string
  icon: AgentIconAsset
}

const KEY = '__GUGU_DEFAULT_TASK_AGENT__'
const EVENT = 'gugu:default-task-agent'

function read(): DefaultTaskAgent | null {
  return ((window as unknown as Record<string, unknown>)[KEY] as DefaultTaskAgent | undefined) ?? null
}

/** 会话页:默认的那个 agent 变了(没有 = null)。没变不通知。 */
export function publishDefaultTaskAgent(agent: DefaultTaskAgent | null): void {
  const current = read()
  if (current?.id === agent?.id && current?.icon === agent?.icon) return
  ;(window as unknown as Record<string, unknown>)[KEY] = agent
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

export function useDefaultTaskAgent(): DefaultTaskAgent | null {
  return useSyncExternalStore(subscribe, read, () => null)
}
