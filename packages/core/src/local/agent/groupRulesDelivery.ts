import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getSupabaseAnonKey, getSupabaseUrl } from '../../cloud/config'
import { resolveGuguHome } from '../state/paths'

/**
 * 群规(chats.group_prompt)的主动送达(spec gugu-plugin「会话态必达，变更即重达」,#3641)。
 *
 * 以前群规只有一条通道:agent 发言时 MCP 发送闸拦一次。于是 agent 决定「回不回」的那一刻从没见过群规,
 * 决定沉默的 agent 永远见不到。现在读者在投递时带上它:
 *   · 每条群/话题投递都带群规版本(内容哈希)—— 一格现场事实;
 *   · 这个 agent 的**这一段上下文**没收到过当前版本(首次、群规改了、会话换了新的 provider 上下文)
 *     ⇒ 这一批里该群第一条投递附上群规原文(不砍字、不翻译)。
 * 已送达记录落盘(本机 GUGU_HOME),进程重启不丢;键里带上下文标识,上下文一换就重达。
 * 发送闸保留为兜底,读同一份记录:投递里已经给过当前版本的,不再拒一次。
 */

/** 群规版本 = 原文 sha256 的前 16 位十六进制;没有群规时是 `none`。 */
export function groupRulesVersion(rules: string): string {
  const text = rules.trim()
  if (!text) return 'none'
  return createHash('sha256').update(rules, 'utf8').digest('hex').slice(0, 16)
}

export interface DeliveredGroupRules {
  version: string
  /** 送达时 agent 所在的那一段 provider 上下文;null = 宿主报不出(当成同一段)。 */
  contextKey: string | null
}

export interface GroupRulesLedger {
  read(agentUserId: string, chatId: string): Promise<DeliveredGroupRules | null>
  write(agentUserId: string, chatId: string, entry: DeliveredGroupRules): Promise<void>
}

export interface GroupRulesDecision {
  version: string
  /** 要随这一批附上的原文;`''` = 群规已被清空(要告诉它一声);null = 不附。 */
  text: string | null
}

/**
 * 纯判定:这一批要不要附群规原文。
 * ❌ 不按「多久没发过」之类的启发式补发 —— 只认三件事实:版本变了、上下文换了、从没送达过。
 */
export function decideGroupRulesDelivery(input: {
  rules: string
  delivered: DeliveredGroupRules | null
  contextKey: string | null
}): GroupRulesDecision {
  const version = groupRulesVersion(input.rules)
  const { delivered } = input
  const sameContext = delivered !== null && delivered.contextKey === input.contextKey
  if (version === 'none') {
    // 从没立过规矩 / 在一段新上下文里:没什么可说的。同一段上下文里原先送达过一版 ⇒ 告诉它规矩撤了。
    return { version, text: sameContext && delivered!.version !== 'none' ? '' : null }
  }
  if (sameContext && delivered!.version === version) return { version, text: null }
  return { version, text: input.rules }
}

// ── 落盘的已送达记录 ────────────────────────────────────────────────────────────
type LedgerFile = Record<string, Record<string, DeliveredGroupRules>>

const ledgers = new Map<string, FileGroupRulesLedger>()

class FileGroupRulesLedger implements GroupRulesLedger {
  private data: LedgerFile | null = null
  private loading: Promise<LedgerFile> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async load(): Promise<LedgerFile> {
    if (this.data) return this.data
    this.loading ??= (async () => {
      let parsed: LedgerFile = {}
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as LedgerFile
        else throw new Error(`group rules ledger ${this.path} is not an object`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.data = parsed
      return parsed
    })()
    return this.loading
  }

  async read(agentUserId: string, chatId: string): Promise<DeliveredGroupRules | null> {
    const data = await this.load()
    const entry = data[agentUserId]?.[chatId]
    return entry && typeof entry.version === 'string'
      ? { version: entry.version, contextKey: typeof entry.contextKey === 'string' ? entry.contextKey : null }
      : null
  }

  async write(agentUserId: string, chatId: string, entry: DeliveredGroupRules): Promise<void> {
    const data = await this.load()
    data[agentUserId] = { ...(data[agentUserId] ?? {}), [chatId]: { version: entry.version, contextKey: entry.contextKey } }
    const snapshot = JSON.stringify(data)
    const next = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${randomUUID()}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.path)
    })
    // 一次写失败不能把后面的写永久卡死;失败本身由这次调用抛给调用方。
    this.writing = next.catch(() => undefined)
    await next
  }
}

export function groupRulesLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGuguHome(env), 'delivery', 'group-rules-delivered.json')
}

/** 本机唯一的已送达记录(读者与 MCP 发送闸同进程共用一个实例,按文件路径区分 GUGU_HOME)。 */
export function groupRulesLedgerFor(env: NodeJS.ProcessEnv = process.env): GroupRulesLedger {
  return groupRulesLedgerAt(groupRulesLedgerPath(env))
}

export function groupRulesLedgerAt(path: string): GroupRulesLedger {
  let ledger = ledgers.get(path)
  if (!ledger) {
    ledger = new FileGroupRulesLedger(path)
    ledgers.set(path, ledger)
  }
  return ledger
}

/** 不落盘的记录(注入式测试用)。 */
export function memoryGroupRulesLedger(): GroupRulesLedger {
  const entries = new Map<string, DeliveredGroupRules>()
  return {
    read: async (agentUserId, chatId) => entries.get(`${agentUserId}\u0000${chatId}`) ?? null,
    write: async (agentUserId, chatId, entry) => { entries.set(`${agentUserId}\u0000${chatId}`, { ...entry }) },
  }
}

export function resetGroupRulesLedgersForTests(): void {
  ledgers.clear()
}

// ── 群规现取 ────────────────────────────────────────────────────────────────────
export interface ChatFactsRow {
  kind: string | null
  source_chat_id: string | null
  group_prompt: string | null
}

/**
 * 一条线此刻生效的群规:话题自己没立规矩时沿用来源群的(与 hide_history 跟着来源线走同一个道理)。
 * 读的是 chat.chat_facts(按 agent 身份判可见),群规每次现读,❌ 不缓存(群主随时能改)。
 */
export async function effectiveGroupRules(
  chatId: string,
  readFacts: (chatId: string) => Promise<ChatFactsRow | null>,
): Promise<string> {
  const facts = await readFacts(chatId)
  const own = typeof facts?.group_prompt === 'string' ? facts.group_prompt : ''
  if (own.trim()) return own
  if (facts?.kind === 'topic' && facts.source_chat_id) {
    const source = await readFacts(facts.source_chat_id)
    const inherited = typeof source?.group_prompt === 'string' ? source.group_prompt : ''
    if (inherited.trim()) return inherited
  }
  return ''
}

export async function fetchChatFactsViaRpc(
  chatId: string,
  asUserId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatFactsRow | null> {
  const response = await fetchImpl(`${getSupabaseUrl().replace(/\/+$/, '')}/rest/v1/rpc/chat_facts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
      'Accept-Profile': 'chat',
      'Content-Profile': 'chat',
    },
    body: JSON.stringify({ p_chat_id: chatId, p_as_user_id: asUserId }),
  })
  if (!response.ok) {
    throw new Error(`chat_facts failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
  }
  const rows = (await response.json()) as unknown
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  return {
    kind: typeof record.kind === 'string' ? record.kind : null,
    source_chat_id: typeof record.source_chat_id === 'string' ? record.source_chat_id : null,
    group_prompt: typeof record.group_prompt === 'string' ? record.group_prompt : null,
  }
}
