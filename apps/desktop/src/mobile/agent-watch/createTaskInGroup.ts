import type { SessionpageSessionCreateRequest } from '@gugu/session-core/session-record/contract'
import { createSession } from './sessionpage-rpc'

export type TaskInGroupFailure =
  /** 那台电脑还不认「派任务」:它建了一条普通会话,没有卡、也没有话题。 */
  | 'host_outdated'
  /** 会话建下了,agent 没起来(原因码在 message 里,同 `startFailure`):卡还没有。 */
  | 'start_failed'

/** 会话已经建下、但卡没落下:带上 sessionId,发起方照样进那条会话看原因、再试一次。 */
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
 * 这个文件夹里建会话,第一句由电脑落成项目群里的一张任务卡,agent 在群里回(同普通群)。回会话 id。
 * 电脑回的 `{ok:false}` 原样抛 SessionpageRpcError(原因码,与新建页同一套);建下了却没落卡抛 TaskInGroupError。
 */
export async function createTaskInGroup(input: {
  deviceId: string
  projectId: string
  cwd: string
  chatId: string
  prompt: string
  harness: string
  model?: string
} & Pick<SessionpageSessionCreateRequest, 'permissionMode' | 'effort'>): Promise<{ sessionId: string }> {
  const result = await createSession(input.deviceId, {
    projectId: input.projectId,
    cwd: input.cwd,
    harness: input.harness,
    prompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    chatId: input.chatId,
    taskChatId: input.chatId,
  })
  const sessionId = result.conversationId
  if (!result.taskMessageId) {
    throw new TaskInGroupError('host_outdated', 'that computer does not know dispatched tasks yet: it made a plain session', sessionId)
  }
  if (result.startFailure) throw new TaskInGroupError('start_failed', result.startFailure, sessionId)
  return { sessionId }
}
