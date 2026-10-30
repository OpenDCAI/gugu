// #7350 关闭咕咕(住在这台电脑上的那一位;product spec「关闭咕咕」)。
//
// 一份确认、一个按钮:它的记忆、性格、交给它的文件和定时任务清掉,和它的聊天不再显示;它开过的会话删不删由人在确认框里选
// (owner 10-18「要不要删是用户选的」,默认归档保留)。删完咕咕那一格回到「认识咕咕」,再开通的是全新的一位。
//
// 顺序是硬的:
//   1. 定时任务先撤 —— 在删任何东西之前。正好有一条在启动(automation_runs_active)= 整个停下,让人稍等再关;
//      ❌ 先删它再撤定时任务:撤不掉的那几条会照点往一个已经不在的会话里投。
//   2. 它开过的任务走现有归档;勾了永久删除时删身份,由同一删除入口清掉绑定任务。
//   3. 删它自己的身份(同一个「删除 agent」:撤掉正在跑的那一轮、放掉本机的登记;服务端把和它的私聊收起来)。
//   身份删除已经停掉并删除它自己的任务,不能再归档一次。
//   4. 清掉它在这台电脑上的家(主进程算路径)。
//   5. 清掉这台电脑上记着的开通进度、「自定义」卡、没走完的开通记录、搬家记录 —— 下次进来就是「认识咕咕」
//      (第 3 步一过就一定做,后面哪步没成也做)。
// 任何一步失败都如实报出来(第几步、为什么进日志),❌ 吞掉接着走、❌ 报「关好了」。

import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { assistantDescendants, isAssistantSession } from '@/session/renderer/features/assistant/assistant-lineage'
import { isMyAssistant } from './myAssistant'
import { UI_EVENTS } from './uiEvents'

export type CloseSession = Pick<
  SessionpageSessionSummary,
  'conversationId' | 'projectId' | 'title' | 'agent' | 'parentConversationId' | 'spawnedByConversationId'
>

export type LocalClosePlan = {
  /** 它自己的会话(这台电脑上)。 */
  own: CloseSession[]
  /** 它开过的会话(子、孙……),确认框里那个勾说的就是它们。 */
  started: CloseSession[]
}

export type LocalCloseDeps = {
  /** 云端清理能力与目标仍有效；在撤任何定时任务、删任何身份之前复核。 */
  check?: () => Promise<void>
  listSessions: () => Promise<readonly CloseSession[]>
  listAutomations: () => Promise<readonly { id: string; agentSessionId?: string | null }[]>
  deleteAutomation: (id: string) => Promise<void>
  /** 同一个「删除 agent」:删身份、放掉本机登记并永久删除绑定任务,之后不能再归档它。 */
  removeAgent: (agentUserId: string) => Promise<void>
  /** 收起一条会话(停掉它的进程)。 */
  archiveSession: (projectId: string, sessionId: string) => Promise<void>
  wipeHome: () => Promise<void>
  resetLocalState: () => void
}

export type AssistantCloseStep = 'check' | 'schedules' | 'started' | 'identity' | 'home'

export class AssistantCloseError extends Error {
  constructor(
    /** 停在哪一步;`schedule-starting` = 它的一个定时任务正好在启动,稍等再关(什么都还没删)。 */
    readonly step: AssistantCloseStep,
    readonly kind: 'schedule-starting' | 'failed',
    readonly reason: unknown,
  ) {
    super(`close assistant failed at ${step}: ${String((reason as Error)?.message ?? reason)}`)
  }
}

/** 确认框要先知道的:它自己的会话、它开过的会话(数一下给那个勾)。 */
export async function planLocalClose(assistantId: string, deps: Pick<LocalCloseDeps, 'listSessions'>): Promise<LocalClosePlan> {
  const listed = await deps.listSessions()
  return {
    own: listed.filter((summary) => isAssistantSession(summary, assistantId)),
    started: assistantDescendants(listed.map((summary) => ({ summary })), assistantId).map((item) => item.summary),
  }
}

export async function closeLocalAssistant(
  input: { assistantId: string; deleteStarted: boolean },
  plan: LocalClosePlan,
  deps: LocalCloseDeps,
): Promise<void> {
  const started = plan.started
  const step = async (name: AssistantCloseStep, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      if (error instanceof AssistantCloseError) throw error
      const starting = name === 'schedules' && String((error as Error)?.message ?? error).includes('automation_runs_active')
      throw new AssistantCloseError(name, starting ? 'schedule-starting' : 'failed', error)
    }
  }

  const sessionIds = new Set([...plan.own, ...started].map((session) => session.conversationId))
  await step('check', async () => { await deps.check?.() })
  await step('schedules', async () => {
    for (const automation of await deps.listAutomations()) {
      if (automation.agentSessionId && sessionIds.has(automation.agentSessionId)) await deps.deleteAutomation(automation.id)
    }
  })
  await step('started', async () => {
    for (const session of started) {
      if (input.deleteStarted && session.agent?.userId && session.agent.userId !== input.assistantId) {
        await deps.removeAgent(session.agent.userId)
      } else {
        await deps.archiveSession(session.projectId, session.conversationId)
      }
    }
  })
  await step('identity', () => deps.removeAgent(input.assistantId))
  // 它已经删掉了:后面哪一步没成都照实报,但这台电脑上记着的开通进度一律清掉 —— 咕咕那一格要回到「认识咕咕」,❌ 停在半截的步骤上。
  try {
    await step('home', deps.wipeHome)
  } finally {
    deps.resetLocalState()
  }
}

/** 设置里的「关闭咕咕」、通讯录 / agent 设置里删它:都只发这一声,确认框只有一个(AssistantCloseHost)。 */
export function requestAssistantClose(): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.closeAssistant))
}

/** 通讯录 / agent 设置里删的是他的个人助理 = 换成关闭咕咕那一份确认(返回 true,调用方别再走通用删除);不是 = false。 */
export function closeIfMyAssistant(ownerUserId: string | null | undefined, agentUserId: string): boolean {
  if (!isMyAssistant(ownerUserId, agentUserId)) return false
  requestAssistantClose()
  return true
}
