import type { SessionpageSessionCreateResult } from '@gugu/session-core/session-record/contract'
import { topicService } from '@/lib/topics'
import { createSession } from './sessionpage-rpc'

export type TaskInGroupFailure =
  /** 那台电脑还不认「派任务」:它建了一条普通会话,没有卡、也没有话题。 */
  | 'host_outdated'
  /** 会话建下了,agent 没起来(原因码在 message 里,同 `startFailure`):卡和话题都还没有。 */
  | 'start_failed'
  /** agent 起来了,卡上却没有话题(那个群不是项目群,或 agent 还没进群)。 */
  | 'topic_missing'

/** 会话已经建下、但没走到话题:带上 sessionId,发起方照样进那条会话看原因、再试一次。 */
export class TaskInGroupError extends Error {
  readonly code: TaskInGroupFailure
  readonly sessionId: string
  constructor(code: TaskInGroupFailure, message: string, sessionId: string) {
    super(message)
    this.name = 'TaskInGroupError'
    this.code = code
    this.sessionId = sessionId
  }
}

/**
 * 手机在项目里派一个新任务(OpenDCAI/gugu#446,照电脑:浮出项目文件夹卡、点文件夹开工):在那台电脑上、这个项目的
 * 这个文件夹里建会话,第一句由电脑落成项目群里的一张任务卡,再从卡上开出话题。回会话 id 和话题 id,发起方直接进话题。
 * 电脑回的 `{ok:false}` 原样抛 SessionpageRpcError(原因码,与新建页同一套);建下了却没走到话题抛 TaskInGroupError。
 */
export async function createTaskInGroup(input: {
  deviceId: string
  projectId: string
  cwd: string
  chatId: string
  prompt: string
  harness: string
  model?: string
}): Promise<{ sessionId: string; topicChatId: string }> {
  const result = await createSession(input.deviceId, {
    projectId: input.projectId,
    cwd: input.cwd,
    harness: input.harness,
    prompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    chatId: input.chatId,
    taskChatId: input.chatId,
  })
  return { sessionId: result.conversationId, topicChatId: await taskTopicOf(input.chatId, result) }
}

/** 建会话那一问回来时 agent 已经起过(卡落下、话题开好),所以这里读一次就是答案,❌ 轮询。 */
async function taskTopicOf(chatId: string, result: SessionpageSessionCreateResult): Promise<string> {
  const sessionId = result.conversationId
  if (!result.taskMessageId) {
    throw new TaskInGroupError('host_outdated', 'that computer does not know dispatched tasks yet: it made a plain session', sessionId)
  }
  if (result.startFailure) throw new TaskInGroupError('start_failed', result.startFailure, sessionId)
  const topic = (await topicService.listTopicsOfChat(chatId)).find((row) => row.source_message_id === result.taskMessageId)
  if (!topic) throw new TaskInGroupError('topic_missing', `no topic was opened off task card ${result.taskMessageId}`, sessionId)
  return topic.chat_id
}
