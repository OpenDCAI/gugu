// spec session-graph「删除的范围」/ session-addressing-identity:删掉之后任何路都到不了它——而「到不了」
// 要能说出**为什么**。收回身份时在这里留一块墓碑(本机、有界),让此后指名投递的失败报
// 「该 agent 已被删除」,而不是一句会被读成配置错误的「不是 mapped local session」。
// 只记「云端身份确认删除 + 本机花名册已摘除」的那种永久不可达;身份仍在别的设备上的 not-homed 不算删除。
//
// 墓碑同时按 **conversation id** 记账。会话页会话本身在删除后继续存在(用户的工作不该因为删掉一个联系人
// 而消失),而 provisioning 的幂等键正是这个 conversation id ——没有这块碑,下一次 session start 找不到花名册
// 记录就会重新开户,把 owner 亲手删掉的 agent 当成"还没供给过的新会话"再造一遍。碑在,那条会话此后按
// identity-none 处理。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, ensureStateDirs, stateDir } from './paths'

export interface ReapedAgentTombstone {
  gugu_user_id: string
  name: string
  reaped_at: string
  /** 该 agent 绑定的会话页会话(有则记)。provisioning 用它拒绝为同一条会话重新开户。 */
  conversation_id?: string
  /**
   * 删掉这个 agent 的账号(有则记)。#4277:会话不带账号,A 删过自己的 agent 只挡 A 自己为这条会话重新
   * 开户,B 照常登记。没记账号的是老碑,对谁都挡(与立碑时的语义一致)。
   */
  owner_user_id?: string
}

const TOMBSTONE_LIMIT = 200

export function reapedAgentsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'reaped-agents.json')
}

export async function listReapedAgents(
  env: NodeJS.ProcessEnv = process.env
): Promise<ReapedAgentTombstone[]> {
  let raw: string
  try {
    raw = await readFile(reapedAgentsFile(env), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(raw) as { reaped?: unknown }
  if (!Array.isArray(parsed.reaped)) return []
  return parsed.reaped.filter(
    (entry): entry is ReapedAgentTombstone =>
      !!entry &&
      typeof (entry as ReapedAgentTombstone).gugu_user_id === 'string' &&
      typeof (entry as ReapedAgentTombstone).reaped_at === 'string'
  )
}

/**
 * 这条会话页会话被移除过的全部身份(每次「归档并移出身份 → 恢复」各留一块)。空 id 一律不算命中——`cacheString`
 * 对缺失键返回 '',拿它当钥匙会让**每一条**没有会话绑定的墓碑匹配上**每一条**新会话,把整个会话页 provisioning 关死。
 */
export async function listReapedAgentsForSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  ownerUserId?: string
): Promise<ReapedAgentTombstone[]> {
  if (!sessionId) return []
  return (await listReapedAgents(env)).filter(
    (entry) =>
      entry.conversation_id === sessionId &&
      (!entry.owner_user_id || !ownerUserId || entry.owner_user_id === ownerUserId)
  )
}

/** 有界追加(同一 id 只留最新一块);写坏/写不动直接抛——墓碑丢了,删除提示就退化成误导文案。 */
export async function recordReapedAgents(
  entries: ReapedAgentTombstone[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!entries.length) return
  await ensureStateDirs(env)
  const existing = await listReapedAgents(env)
  const merged = [
    ...existing.filter((entry) => !entries.some((next) => next.gugu_user_id === entry.gugu_user_id)),
    ...entries,
  ].slice(-TOMBSTONE_LIMIT)
  await atomicWriteText(reapedAgentsFile(env), `${JSON.stringify({ reaped: merged }, null, 2)}\n`)
}
