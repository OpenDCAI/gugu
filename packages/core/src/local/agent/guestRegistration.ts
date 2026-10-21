import { appendFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgent, updateAgent, isGuestAgentRecord, createGuestAgentForProviderSession, type LocalAgentRecord } from '../state/agents'
import { stateDir } from '../state/paths'
import { acquireStateLock } from '../state/fileLocks'
import { readHumanAuthSession } from '../identity/humanAuthSession'
import { readCachedDeviceId } from '../../cloud/deviceRuntime'
import { getSupabaseUrl, getSupabaseAnonKey } from '../../cloud/config'
import { provisionOwnedAgent } from '../../cloud/ownedAgent'
import { attachFreeformAgent } from './freeformCapture'
import type { AgentRuntimeKind } from './agentRuntimeSession'

// @@@ guest-registration (#665) — ⚠️ 当前全仓零调用是**终端栈 teardown 的结果,不是死码**(#1914 裁定
// park,勿删)。这是宪章身份不变量「guest 对身份 ladder 不可见(懒注册)」的**写入侧唯一实现**:
// 旧入口 = 本地野生会话的 SessionStart hook → ensureGuestForSession 预登记 + `gugu agent register`
// → activateGuestAgent 懒激活,两个入口随 #1021/#1030 终端/CLI 栈死亡。读侧守卫
// (@@@guest-invisible-ladder / @@@guest-prune)仍活着守存量;status='guest' 记录形态以本文件为源定义。
// ACP 时代的新入口长什么样 = 产品级缺口,待 Supervisor/owner 定夺(见 #1914「产品缺口上报」段);
// 定夺前勿删本簇(含 freeformCapture.ts、agents.ts 的 createGuestAgentForSession),也勿反向把读侧守卫当死码清理。

const ENGINE_WORDS = ['claude', 'codex', 'claude-code', 'claude code', 'gpt', 'agent', 'assistant']

function autoGuestName(_env: NodeJS.ProcessEnv, cwd?: string): string {
  const dir = cwd ?? process.cwd()
  const sanitized = basename(dir)
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase()
    .slice(0, 20)
    .replace(/^-+|-+$/g, '')
  const base = !sanitized || ENGINE_WORDS.includes(sanitized) ? 'project' : sanitized
  const suffix = randomUUID().replace(/-/g, '').slice(0, 4)
  return `${base}-${suffix}`
}

export async function ensureGuestForProviderSession(
  provider: AgentRuntimeKind,
  rawPayload: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<{ created: boolean; record: LocalAgentRecord | null }> {
  const env = options.env ?? process.env
  try {
    // 1. Parse payload to extract session id
    let providerSessionId: string | null = null
    try {
      const payload = JSON.parse(rawPayload.trim()) as Record<string, unknown>
      if (provider === 'claude-code') {
        const v = payload.session_id
        providerSessionId = typeof v === 'string' && v.trim() ? v.trim() : null
      } else {
        const tid = payload.thread_id
        const sid = payload.session_id
        providerSessionId =
          (typeof tid === 'string' && tid.trim() ? tid.trim() : null) ??
          (typeof sid === 'string' && sid.trim() ? sid.trim() : null)
      }
    } catch {
      // unparseable payload — no session id
    }

    // 2. If no session id, nothing to do
    if (!providerSessionId) return { created: false, record: null }

    // 3. Create guest record atomically (check + write in one lock acquisition to prevent TOCTOU).
    // createGuestAgentForSession re-checks inside the lock, so a concurrent call for the same
    // session id returns created:false with the existing record rather than creating a duplicate.
    const name = autoGuestName(env, options.cwd)
    return await createGuestAgentForProviderSession(
      {
        name,
        agent_type: provider,
        path: options.cwd ?? process.cwd(),
        providerSessionId
      },
      env
    )
  } catch (error) {
    try {
      const logPath = join(env.HOME ?? '/tmp', '.gugu-hook.log')
      const msg = error instanceof Error ? error.message : String(error)
      await appendFile(logPath, `[gugu guest-registration] ${msg}\n`)
    } catch {
      // logging failure must not propagate
    }
    return { created: false, record: null }
  }
}

export async function activateGuestAgent(
  providerSessionId: string,
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    displayName?: string
    fetchImpl?: typeof fetch
  } = {}
): Promise<{ name: string; agentUserId: string }> {
  const env = options.env ?? process.env

  // @@@activate-lock - prevent concurrent double-provision when two commands race to activate the
  const lockDir = join(stateDir(env), `agent-activation-${providerSessionId}.lock`)
  await mkdir(stateDir(env), { recursive: true })
  let release: (() => Promise<void>) | null = null
  try {
    try {
      release = await acquireStateLock(lockDir, 'agent-activation')
    } catch {
      // Timed out (~2 s) — re-read the record; if it is already active, return the identity.
      const timedOutRecord = await getAgent({ providerSessionId }, env)
      if (timedOutRecord && !isGuestAgentRecord(timedOutRecord) && timedOutRecord.gugu_user_id) {
        return { name: timedOutRecord.name, agentUserId: timedOutRecord.gugu_user_id }
      }
      throw new Error(`Timed out waiting for agent-activation lock for session ${providerSessionId}`)
    }

    // 1. RE-READ the record inside the lock to detect a concurrent activation.
    const agent = await getAgent({ providerSessionId }, env)
    if (!agent) throw new Error(`No local agent bound to session ${providerSessionId}`)
    // If a concurrent activation already promoted this record, return its identity.
    if (!isGuestAgentRecord(agent) && agent.gugu_user_id) {
      return { name: agent.name, agentUserId: agent.gugu_user_id }
    }
    if (agent.status !== 'guest' || agent.gugu_user_id) {
      throw new Error(`Agent on session ${providerSessionId} is not a guest (status=${agent.status ?? 'none'}, gugu_user_id=${agent.gugu_user_id || '(empty)'})`)
    }

    // 2. Check human auth
    const human = await readHumanAuthSession(env)
    if (!human) throw new Error('Not logged in; run `gugu login` first')

    // 3. Check device
    let deviceId: string
    try {
      deviceId = await readCachedDeviceId(env, human.user_id)
    } catch (err) {
      throw new Error(
        `Device not registered yet; launch the Gugu desktop app first to register this device. (${err instanceof Error ? err.message : String(err)})`
      )
    }

    // 4. Display name
    const displayName = options.displayName ?? agent.name

    // 5. Provision cloud identity
    const provisioned = await provisionOwnedAgent({
      supabaseUrl: getSupabaseUrl(),
      anonKey: getSupabaseAnonKey(),
      accessToken: human.access_token,
      displayName,
      avatar: null,
      agentType: agent.agent_type,
      deviceId,
      localPath: options.cwd ?? agent.path ?? null,
      fetchImpl: options.fetchImpl
    })

    // 6. Promote the local record
    await updateAgent({ providerSessionId }, { gugu_user_id: provisioned.id, status: 'active' }, env)

    // 7. Write runtime-sessions token so the session can deliver/receive messages
    await attachFreeformAgent({ guguUserId: provisioned.id }, { env, cwd: options.cwd })

    return { name: agent.name, agentUserId: provisioned.id }
  } finally {
    await release?.()
  }
}
