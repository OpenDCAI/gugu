import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '../state/paths'
import {
  isGuestAgentRecord,
  matchAgentByProviderSessionId,
  type LocalAgentRecord
} from '../state/agents'
import {
  detectAgentProviderSession,
  type AgentProviderSessionDetection
} from './agentProviderSession'
import { CLOUD_AGENT_TYPE } from '../../agentTypes'

// #1229 ACP parity — 外部 CLI ACP runtime（刀1 gemini、刀2 opencode、刀3 hermes、刀4 openclaw）。
export type AgentRuntimeKind = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'hermes' | 'openclaw'

export interface AgentRuntimeAuthSession {
  accessToken: string
  refreshToken?: string | null
  agentUserId: string
}

export interface AgentRuntimeSessionIdentity {
  runtime: AgentRuntimeKind
  providerSessionId: string
  agentUserId: string
  groupId?: string
  checkedAt: string
}

export type AgentRuntimeSessionDetection = AgentProviderSessionDetection



export function agentRuntimeSessionFile(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!agentUserId) throw new Error('Agent runtime session file requires agentUserId')
  return join(resolveGuguHome(env), 'runtime-sessions', `${agentUserId}.json`)
}






// @@@3890⑪ `runtime-starting` 标记(<GUGU_HOME>/runtime-starting/<agentUserId>.json, 90s TTL)整套退役。
// 它是「守卫对象已消失」的一例:writeAgentRuntimeStarting 早已零生产调用方,于是 isAgentRuntimeStarting
// 在生产里恒为 false —— 那道「这个 agent 正在启动中」的宽限窗从来没有真的开过。留着它反而是个假抓手:
// 它挂在 @gugu/core 的公共 barrel 上,谁接上去都会拿到一个永远说「没在启动」的门闸。
// 两处仅存的调用(deviceCommandRuntime 的 stop / 换主人清场)删的是一个不可能存在的文件,纯开销。
// ❌ 不为它补启动清扫器:清扫一个没人再产生的对象,正是 #3885 那个物种。旧版本写下的标记自带 90s TTL、
//    无人读取,是惰性垃圾。

export async function writeAgentRuntimeSession(
  session: AgentRuntimeAuthSession,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (!session.accessToken) throw new Error('Agent runtime session requires accessToken')
  if (!session.agentUserId) throw new Error('Agent runtime session requires agentUserId')
  const file = agentRuntimeSessionFile(session.agentUserId, env)
  // @@@atomic-activity-write (#945, 回港 ec60c23) - token resync 走原子写，避免与并发写者交错。
  await atomicWriteText(
    file,
    JSON.stringify(
      {
        access_token: session.accessToken,
        refresh_token: session.refreshToken ?? '',
        updated_at: new Date().toISOString()
      },
      null,
      2
    )
  )
  return file
}

export async function readAgentRuntimeSession(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentRuntimeAuthSession | null> {
  try {
    const raw = JSON.parse(await readFile(agentRuntimeSessionFile(agentUserId, env), 'utf8')) as {
      access_token?: unknown
      refresh_token?: unknown
    }
    if (typeof raw.access_token !== 'string' || !raw.access_token) {
      throw new Error(`Invalid agent runtime session for ${agentUserId}`)
    }
    return {
      accessToken: raw.access_token,
      refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : '',
      agentUserId
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

export async function removeAgentRuntimeSession(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  try {
    await rm(agentRuntimeSessionFile(agentUserId, env))
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return
    throw err
  }
}

export function detectAgentRuntimeSession(
  env: NodeJS.ProcessEnv = process.env
): AgentRuntimeSessionDetection | null {
  return detectAgentProviderSession(env)
}

// @@@ session-id-identity (#18) — see git history for full context.
export async function resolveAgentRuntimeSessionIdentity(
  env: NodeJS.ProcessEnv = process.env,
  _options: { cwd?: string } = {}
): Promise<{
  detection: AgentRuntimeSessionDetection | null
  identity: AgentRuntimeSessionIdentity | null
}> {
  const detection = detectAgentRuntimeSession(env)

  // @@@stale-launch-tag-fallback 已随 rung 1 一起撤销:GUGU_LOCAL_ID 携带的是 roster 本地 id,
  // 而那个 id 本身已经撤掉了 —— 全仓从来只读它、没有任何地方写它(产生它的 CLI/终端栈随 #1021/#1030
  // 死亡)。留一个没有主语的守卫只会让人以为还有这条路。身份解析现在只有一条真路径:provider 会话 id。
  if (!detection) return { detection: null, identity: null }

  // @@@session-identity - the ONLY runtime key: the provider session id (CODEX_THREAD_ID /
  // @@@guest-invisible-ladder - guest records are invisible here too; only active/owned records resolve.
  const bound = await matchAgentByProviderSessionId(detection.providerSessionId, env)
  if (bound && !isGuestAgentRecord(bound)) return { detection, identity: identityFromRecord(bound, detection) }
  return { detection, identity: null }
}

function identityFromRecord(
  record: LocalAgentRecord,
  detection: AgentRuntimeSessionDetection | null
): AgentRuntimeSessionIdentity {
  // @@@1289 record.agent_type 可能是 'gugu-cloud'（云标记），但云 agent 不进本机 runtime 身份解析
  // （本机 hook 只对本地引擎触发）。该不变量若破，宁可 fail-loud 也别静默把 'gugu-cloud' cast 成
  // AgentRuntimeKind 往下传错数据（原是裸 as 断言，会悄悄伪造）。
  if (!detection?.runtime && record.agent_type === CLOUD_AGENT_TYPE) {
    throw new Error('[agentRuntimeSession] 云 agent(gugu-cloud) 不应进入本机 runtime 身份解析')
  }
  return {
    runtime: detection?.runtime ?? (record.agent_type as AgentRuntimeKind),
    providerSessionId: detection?.providerSessionId ?? '',
    agentUserId: record.gugu_user_id,
    checkedAt: new Date().toISOString()
  }
}
