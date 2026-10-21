// #6299 — 单 agent 创建不再「重启后续建」。启动时把上次没建完的单 agent 记录收掉,结果如实交给 UI 提示。
//
// 为什么在启动时收:旧式创建弹窗(CreateAgentModal + AgentCreateRetryHost)下架后,本机再没有谁会读这些
// owner-scoped 续建记录 —— 不收,它们就永远躺在 localStorage 里,云端那次开了头的创建也永远停在半截。
// 新的创建入口(共享 Session Composer)只在自己开着时续建,不跨重启(spec agent-create)。
//
// 每条记录的去向以**云端这次创建的事实**为准,❌ 不按本地猜:
//   · 云端没有这次操作(记录写下、首个 RPC 前就断了)→ 只清本地(连同本机的会话继承预留);
//   · 云端已 completed → 照常收尾,不当失败:直接用云端这条成员行(Agent / DM 已由云端绑好),清本地记录。
//     ❌ 不走 resumeSingleAgent —— 它先重读并比对创建时的本机源指纹,源被改过就永远收不掉一个已建好的 Agent;
//   · 其余 → cancelTeamProvision(取消 + 回收 + settle,全收掉时它自己删记录);没收干净 → 记录保留,
//     下次启动再收,卡在哪一步如实报。
// 团队(kind='team')的记录归 team saga,这里不碰。

import type { AgentProvision, AgentProvisionOperation } from '@gugu/core/shared/types/agentProvision'
import type { CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'
import {
  completedSingleProvisionSession,
  defaultResumeStore,
  getProvision,
  getProvisionOperation,
  type ProvisionResumeStore,
} from './agentProvision'
import { cancelTeamProvision, type CancelTeamProvisionResult } from './teamProvisionSaga'
import type { CleanupStage } from './cleanupStageCopy'

export type UnfinishedSingleAgentOutcome =
  | { operationId: string; kind: 'discarded' }
  | { operationId: string; kind: 'cancelled'; warningStages: CleanupStage[] }
  | { operationId: string; kind: 'completed'; session: CreateAgentOnDeviceResult }
  | { operationId: string; kind: 'pending'; stages: CleanupStage[]; error?: string }

export interface UnfinishedSingleAgentSweepDeps {
  store?: ProvisionResumeStore
  getOperation?: (operationId: string) => Promise<AgentProvisionOperation | null>
  cancel?: (operationId: string) => Promise<CancelTeamProvisionResult>
  getMember?: (provisionId: string) => Promise<AgentProvision | null>
}

export async function sweepUnfinishedSingleAgents(
  ownerUserId: string,
  deps: UnfinishedSingleAgentSweepDeps = {},
): Promise<UnfinishedSingleAgentOutcome[]> {
  const store = deps.store ?? defaultResumeStore
  const getOperation = deps.getOperation ?? getProvisionOperation
  const cancel = deps.cancel ?? cancelTeamProvision
  const getMember = deps.getMember ?? getProvision
  const outcomes: UnfinishedSingleAgentOutcome[] = []

  for (const record of store.list(ownerUserId)) {
    if (record.blueprint.kind !== 'single') continue
    const { operationId } = record
    const member = record.members[0]
    const finish = async (operation: AgentProvisionOperation): Promise<UnfinishedSingleAgentOutcome> => {
      if (!member) throw new Error(`resume record ${operationId} has no member ref`)
      const row = await getMember(member.provisionId)
      if (!row) throw new Error(`single provision ${member.provisionId} missing although operation ${operationId} completed`)
      // 成员行缺绑定时 completedSingleProvisionSession 抛错 → pending,记录保留。
      const session = completedSingleProvisionSession({ operationId, provisionId: member.provisionId, operation, outcome: { member: row } })
      store.forget(ownerUserId, operationId)
      return { operationId, kind: 'completed', session }
    }
    try {
      const operation = await getOperation(operationId)
      if (!operation) {
        store.forget(ownerUserId, operationId)
        outcomes.push({ operationId, kind: 'discarded' })
        continue
      }
      if (operation.phase === 'completed') {
        outcomes.push(await finish(operation))
        continue
      }
      const result = await cancel(operationId)
      if (result.operation.phase === 'completed') {
        outcomes.push(await finish(result.operation))
      } else if (result.fullyCancelled) {
        outcomes.push({ operationId, kind: 'cancelled', warningStages: result.cleanupErrors.map((item) => item.stage) })
      } else {
        outcomes.push({ operationId, kind: 'pending', stages: result.cleanupErrors.map((item) => item.stage) })
      }
    } catch (error) {
      // 一条收不掉不拦其余几条;记录原样保留,下次启动再收。
      outcomes.push({
        operationId,
        kind: 'pending',
        stages: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
