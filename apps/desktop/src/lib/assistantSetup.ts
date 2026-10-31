// #7199 给个人助理安家(owner 10-16「先给用户建一个个人助理」「会员一键领取;非会员在本机创建」):
//   会员 → 一键领取,住云上:交给管家开一台它的宿主,建它时带上引导里起的名字、选的形象和主人留的「称呼和基本信息」;
//   非会员 → 装在这台电脑上:主进程先把它的家准备好(工作目录、说明、那条记忆),再走与「新建 agent」同一条链建它(member_key='assistant')。
// 两条都带同一份初始化任务(@gugu/core/shared/assistantPolicy):建好它先开口。界面在 components/assistant/onboarding;手机也用这里。
import {
  ASSISTANT_CHILD_HARNESS,
  ASSISTANT_DEFAULT_MODEL,
  ASSISTANT_FIRST_TASK,
  ownerProfileMarkdown,
  type OwnerProfileInput,
} from '@gugu/core/shared/assistantPolicy'
import type { CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'
import { REST_FACES } from '../components/agentAvatar/engine/identity'
import type { AgentLook } from '../components/agentAvatar/look'
import type { ExpressionId } from '../components/agentAvatar/engine/spec'
import { desktopIpc } from '../platform/desktopIpc'
import { getLocaleSnapshot } from '../i18n/runtime'
import {
  completedSingleProvisionSession,
  assertResumeRecordOwner,
  createResumeStore,
  getProvision,
  getProvisionOperation,
  provisionSingleAgent,
  resumeSingleAgent,
  type ProvisionResumeRecord,
  type SingleProvisionDeps,
} from './agentProvision'
import { ASSISTANT_HOME_CHANNELS } from './assistantHomeIpc'
import { prepareLocalAssistantSetup } from './assistantSetupPreparation'
import { provisionCloudComputer } from './cloudComputerStore'
import { platformModelsEnabled } from '@gugu/core/cloud/optionalServices'
import { contactsService } from './contacts'
import { getCurrentAuthUserId } from './supabase'
import { cancelTeamProvision } from './teamProvisionSaga'

/** 起名、称呼、自我介绍的长短(名字 30 字、称呼 80 字;介绍是交给管家的那段,管家收 4000)。 */
export const ASSISTANT_NAME_MAX = 30
export const OWNER_NAME_MAX = 80
export const OWNER_ABOUT_MAX = 1000

/** 「随便取一个」的候选名。 */
export const ASSISTANT_NAME_IDEAS: readonly string[] = ['松果', '栗子', '糯米', '团子', 'Milo', 'Mochi', 'Kiwi', 'Coco']

/** 引导里攒下的那一份:它叫什么、长什么颜色、主人怎么称呼和几句介绍。 */
export type AssistantSetupDraft = AgentLook & {
  name: string
  owner: OwnerProfileInput
}

export function randomRestFace(rng: () => number = Math.random): ExpressionId {
  return REST_FACES[Math.min(REST_FACES.length - 1, Math.floor(rng() * REST_FACES.length))]
}

/** 头像字段那个形象地址(本套环境存储里那个颜色的定格图 + 休息表情)。 */
export function draftAvatarUrl(draft: AgentLook): string {
  return contactsService.agentLookAvatarUrl({ color: draft.color, rest: draft.rest, wear: draft.wear })
}

function cleanDraft(draft: AssistantSetupDraft) {
  const name = draft.name.trim()
  if (!name || name.length > ASSISTANT_NAME_MAX) throw new Error(`assistant name must be 1–${ASSISTANT_NAME_MAX} characters`)
  const preferredName = draft.owner.preferredName.trim()
  if (!preferredName || preferredName.length > OWNER_NAME_MAX) throw new Error(`owner name must be 1–${OWNER_NAME_MAX} characters`)
  return { name, avatar: draftAvatarUrl(draft), ownerProfile: ownerProfileMarkdown({ preferredName, about: draft.owner.about.slice(0, OWNER_ABOUT_MAX), language: getLocaleSnapshot().resolvedLocale }) }
}

/** 会员一键领取:管家开它的宿主、在上面建它(要几分钟;进度看管家的 /state,界面在 CloudComputerProvisionPanel 那三步)。 */
export async function claimCloudAssistant(draft: AssistantSetupDraft): Promise<void> {
  await provisionCloudComputer({ assistant: cleanDraft(draft) })
}

/** 助理的续建记录另放一份:❌ 被启动时「收掉没建完的单 agent」那一扫当成普通 agent 撤掉(见 createResumeStore)。 */
export const assistantResumeStore = createResumeStore('gugu:assistant-provision:pending:')

/** 建到一半(退出 / 断网)留下的那一次;没有 = null。 */
export function pendingLocalAssistant(ownerUserId: string): ProvisionResumeRecord | null {
  return assistantResumeStore.list(ownerUserId)[0] ?? null
}

export class AssistantSetupError extends Error {
  constructor(
    readonly kind: 'not-desktop' | 'still-starting' | 'failed' | 'cancelled',
    message: string,
  ) {
    super(message)
  }
}

/** 这次没成只是因为它还没起来(那一单还在,过一会儿接着推就行);别的失败(真失败、那一单已被收回、读不到来源……)都不是。 */
export function setupStillStarting(error: unknown): boolean {
  return error instanceof AssistantSetupError && error.kind === 'still-starting'
}

function settled(result: Awaited<ReturnType<typeof provisionSingleAgent>>): CreateAgentOnDeviceResult {
  if (result.outcome.member.phase === 'awaiting_terminal') throw new AssistantSetupError('still-starting', 'assistant is still starting on this computer')
  if (result.outcome.member.phase === 'failed') throw new AssistantSetupError('failed', result.outcome.member.error ?? 'agent.create failed')
  return completedSingleProvisionSession(result)
}

async function startDeps(): Promise<SingleProvisionDeps> {
  return {
    resumeStore: assistantResumeStore,
    model: platformModelsEnabled() ? ASSISTANT_DEFAULT_MODEL : null,
    assistant: { childHarness: ASSISTANT_CHILD_HARNESS, firstTask: ASSISTANT_FIRST_TASK },
  }
}

// 同一时刻只推这台电脑上的一次开通:开通页还在等它起来时,它的身份就已经有了,咕咕那一格(壳)也会想接着做 ——
// 两边一起推 = 同一单推两遍。后来的一方接上正在推的那一次。
let localSetupInFlight: Promise<CreateAgentOnDeviceResult> | null = null
function singleFlight(work: () => Promise<CreateAgentOnDeviceResult>): Promise<CreateAgentOnDeviceResult> {
  if (localSetupInFlight) return localSetupInFlight
  const running = work()
  localSetupInFlight = running
  const clear = () => {
    if (localSetupInFlight === running) localSetupInFlight = null
  }
  running.then(clear, clear)
  return running
}

/** 非会员:装在这台电脑上(这台 = `localDeviceId`)。建好返回它是谁、和它的私聊。 */
export function setUpAssistantOnThisComputer(draft: AssistantSetupDraft, localDeviceId: string, options: { signal?: AbortSignal; onInstalling?: () => void } = {}): Promise<CreateAgentOnDeviceResult> {
  return singleFlight(() => setUpHere(draft, localDeviceId, options))
}

async function setUpHere(draft: AssistantSetupDraft, localDeviceId: string, options: { signal?: AbortSignal; onInstalling?: () => void }): Promise<CreateAgentOnDeviceResult> {
  const ipc = desktopIpc()
  if (!ipc) throw new AssistantSetupError('not-desktop', 'only the desktop app can host the assistant')
  const clean = cleanDraft(draft)
  // 开通的是全新的一位:上一位留在这台电脑上的家先清掉(#7350,别处删掉的 / 关到一半的),❌ 带着上一位的记忆和性格。
  const home = await prepareLocalAssistantSetup(ipc, { ownerProfile: clean.ownerProfile, fresh: true }, options)
  const result = await provisionSingleAgent(
    localDeviceId,
    {
      memberKey: 'assistant',
      displayName: clean.name,
      agentType: 'claude-code',
      projectPath: home.workdir,
      avatar: clean.avatar,
      inheritMemory: false,
      historyImportRequired: false,
    },
    await startDeps(),
  )
  return settled(result)
}

/** 接着建上次没建完的那一个(同一个 agent,❌ 再建一个);这台电脑上正有一次在推,就接上那一次。 */
export function resumeLocalAssistant(record: ProvisionResumeRecord): Promise<CreateAgentOnDeviceResult> {
  return singleFlight(async () => {
    await assertResumeRecordOwner(record, getCurrentAuthUserId, 'single')
    const operation = await getProvisionOperation(record.operationId)
    if (operation && (operation.owner_user_id !== record.ownerUserId || operation.kind !== 'single')) {
      throw new Error('assistant setup operation does not belong to this recovery record')
    }
    const member = operation ? await getProvision(record.members[0]!.provisionId) : null
    if (member && (member.operation_id !== record.operationId || member.owner_user_id !== record.ownerUserId || member.member_key !== 'assistant')) {
      throw new Error('assistant setup member does not belong to this recovery record')
    }
    const removed = !!member?.provisioned_agent_user_id && !member.agent_user_id
    if (operation?.phase === 'cleaning_up' || (removed && operation?.phase !== 'completed' && operation?.phase !== 'cancelled')) {
      const result = await cancelTeamProvision(record.operationId, { resumeStore: assistantResumeStore })
      if (!result.fullyCancelled) throw new AssistantSetupError('failed', 'assistant setup cleanup is still in progress; try again')
      throw new AssistantSetupError('cancelled', 'the previous assistant setup has ended; start a new setup')
    }
    if (operation?.phase === 'cancelled' || (operation?.phase === 'completed' && removed)) {
      // Only an authoritative terminal can release this pointer. A new setup remains an explicit user action.
      assistantResumeStore.forget(record.ownerUserId, record.operationId)
      throw new AssistantSetupError('cancelled', 'the previous assistant setup has ended; start a new setup')
    }
    const ipc = desktopIpc()
    if (!ipc) throw new AssistantSetupError('not-desktop', 'only the desktop app can host the assistant')
    await ipc.invoke(ASSISTANT_HOME_CHANNELS.prepare, {})
    return settled(await resumeSingleAgent(record, await startDeps()))
  })
}

/** 住在这台电脑上时每次打开 App 刷一遍它的家(说明跟上这一版咕咕;不动记忆)。 */
export async function refreshLocalAssistantHome(): Promise<void> {
  await desktopIpc()?.invoke(ASSISTANT_HOME_CHANNELS.prepare, {})
}
