import { getAgent, type AgentSelector } from '../state/agents'
import { readFreshHumanAuthSession } from '../identity/humanAuthSession'
import { writeAgentRuntimeSession, type AgentRuntimeKind } from './agentRuntimeSession'

export interface FreeformAttachResult {
  agentUserId: string
  runtime: AgentRuntimeKind
  cwd: string
}

// @@@freeform-attach-bootstrap - the plain-launch counterpart of the desktop spawn path
// ⚠️ #1914 park:唯一非测试调用方是 guestRegistration.ts(guest 懒注册簇,写入侧随终端栈 teardown
// 断链但按 push.ts 规矩 park)。勿当死码删;裁定背景见 guestRegistration.ts 头注释 + #1914。
export async function attachFreeformAgent(
  selector: AgentSelector,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<FreeformAttachResult> {
  const env = options.env ?? process.env
  const agent = await getAgent(selector, env)
  if (!agent) throw new Error('No such local agent; create it in Gugu first')
  if (!agent.gugu_user_id) throw new Error('That local agent has no gugu_user_id; cannot attach')

  const human = await readFreshHumanAuthSession(env)
  if (!human) throw new Error('Not logged in; run `gugu login` first')

  const cwd = options.cwd ?? (agent.path || process.cwd())
  await writeAgentRuntimeSession(
    {
      accessToken: human.access_token,
      refreshToken: human.refresh_token,
      agentUserId: agent.gugu_user_id
    },
    env
  )
  // @@@1289 agent.agent_type 可能是 'gugu-cloud'，但 freeform attach 是本机路径、云 agent 不触达；断言为引擎 kind 安全。
  return { agentUserId: agent.gugu_user_id, runtime: agent.agent_type as AgentRuntimeKind, cwd }
}
