/**
 * teamGenerate — Agent 团队生成（渲染端薄客户端）
 *
 * 职责：调 `team-generate` Supabase Edge Function 生成团队，client 侧 validate + 加 tempId。
 * 为什么走 edge fn:LLM API key 必须留服务端,渲染端无 process.env、且不能把 key 烤进 bundle。
 * LLM 调用 + prompt + 解析在 edge fn(gugu-supabase 的 supabase/functions/team-generate/index.ts,读服务端 GUGU_SERVER_LLM_* 配置)。
 *
 * 缺配置 / LLM 失败 / 返回不可解析 → edge fn 返回非 2xx,这里 throw（fail loud,不兜底）。
 */

import { edgeFunctionError } from './edgeFunctionError'
import { dataClient } from './supabase'
// @@@1438 类型来自 BuildAgentWizard（未接入的占位组件，owner 拍板保留作 Hub/市场 方向基底，勿删）。
import type { AgentTeam, AgentTeamMember } from '../components/BuildAgentWizard'
import { DEFAULT_AGENT_TYPE, VALID_AGENT_TYPES } from '@gugu/core/agentTypes'

// ─────────────────────────────────────────────
// edge fn 返回的原始 team 形状（解析+映射前）
// ─────────────────────────────────────────────

interface RawMember {
  role?: unknown
  displayName?: unknown
  description?: unknown
  engineId?: unknown
}

interface RawTeam {
  teamName?: unknown
  members?: unknown[]
}

function normalizeEngineId(raw: unknown): string {
  if (typeof raw === 'string' && (VALID_AGENT_TYPES as readonly string[]).includes(raw)) {
    return raw
  }
  return DEFAULT_AGENT_TYPE
}

let _tempIdCounter = 0
function nextTempId(): string {
  return `tmp-${Date.now()}-${_tempIdCounter++}`
}

function validateAndMap(parsed: unknown, userDescription: string): AgentTeam {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('team-generate returned non-object — cannot build team')
  }
  const raw = parsed as RawTeam
  if (typeof raw.teamName !== 'string' || !raw.teamName.trim()) {
    throw new Error('team-generate response missing teamName')
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new Error('team-generate response missing or empty members array')
  }
  const members: AgentTeamMember[] = raw.members.map((m, idx) => {
    const rm = m as RawMember
    if (typeof rm.role !== 'string' || !rm.role.trim()) throw new Error(`Member[${idx}] missing role`)
    if (typeof rm.displayName !== 'string' || !rm.displayName.trim()) throw new Error(`Member[${idx}] missing displayName`)
    if (typeof rm.description !== 'string' || !rm.description.trim()) throw new Error(`Member[${idx}] missing description`)
    // @@@2470 模板 key 用这个 blueprint 槽位 key 本身（tempId）。它随后被当作 member_key 落库
    // （createAgentTeam: memberKey = tempId），重放时又以 stored.member_key 取回同一个串 ——
    // 所以生成 → provision → 重放全程是同一个模板 key。
    // ❌ 不用角色标签/显示名派生（那与「模板 key 与显示名解耦」矛盾），❌ 不用每次渲染的随机值。
    const tempId = nextTempId()
    return {
      tempId,
      role: rm.role.trim(),
      displayName: rm.displayName.trim(),
      avatarSeed: tempId,
      description: rm.description.trim(),
      avatarUrl: null,
      engineId: normalizeEngineId(rm.engineId),
    }
  })
  return { userDescription, teamName: raw.teamName.trim(), members }
}

/**
 * 调 team-generate edge fn 生成 AgentTeam。
 * @throws edge fn 未部署 / LLM 未配置 / LLM 失败 / 返回不可解析。
 */
export async function generateAgentTeam(description: string): Promise<AgentTeam> {
  const { data, error } = await dataClient.functions.invoke('team-generate', {
    body: { description },
  })
  if (error) throw new Error(`team-generate edge function failed: ${await edgeFunctionError(error)}`)
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new Error(`team-generate: ${(data as { error: string }).error}`)
  }
  return validateAndMap(data, description)
}
