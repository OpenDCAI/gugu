import { createGuguSupabaseClient } from '../../cloud/supabase'
import { readAgentRuntimeSession } from './agentRuntimeSession'

/**
 * @@@2175 deliver 回合结局记录——「连续异常回合」计数的唯一写口(镜像 agentDeliveryDedup 的
 * identity-scoped RPC 打法)。ok=false 原子 +1、ok=true 清零(DB 侧幂等:已是 0 不 UPDATE 不广播)。
 * 计数存 DB 而非宿主内存:引擎坏是 agent+引擎的属性,宿主重启不假装恢复,只有真实成功回合才清零。
 * #6448 起它不再驱动任何显示:「出错」只认宿主状态写入者(投递终态失败本来就是写入者日志里的 Error)。
 */
export interface AgentDeliverOutcomeInput {
  agentUserId: string
  ok: boolean
}

type OutcomeRpcClient = {
  rpc(
    fn: 'record_agent_deliver_outcome',
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

interface OutcomeOptions {
  env?: NodeJS.ProcessEnv
  /** Injectable so the RPC is unit-testable without a live client. */
  client?: OutcomeRpcClient
}

async function outcomeClient(agentUserId: string, env: NodeJS.ProcessEnv): Promise<OutcomeRpcClient> {
  const session = await readAgentRuntimeSession(agentUserId, env)
  if (!session) {
    throw new Error(`No runtime auth session for ${agentUserId}; cannot record deliver outcome`)
  }
  return createGuguSupabaseClient({
    schema: 'identity',
    headers: { Authorization: `Bearer ${session.accessToken}` }
  }) as unknown as OutcomeRpcClient
}

/** 记录一次 deliver 回合结局,返回记录后的连续异常计数(成功恒 0)。 */
export async function recordAgentDeliverOutcome(
  input: AgentDeliverOutcomeInput,
  options: OutcomeOptions = {}
): Promise<number> {
  const env = options.env ?? process.env
  const client = options.client ?? (await outcomeClient(input.agentUserId, env))
  const { data, error } = await client.rpc('record_agent_deliver_outcome', {
    p_agent_user_id: input.agentUserId,
    p_ok: input.ok
  })
  if (error) throw new Error(error.message)
  if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) {
    throw new Error(`record_agent_deliver_outcome returned unexpected value: ${JSON.stringify(data)}`)
  }
  return data
}
