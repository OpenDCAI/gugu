// @@@task-shell-port (#5012) — 会话页对「壳」的口。
//
// 会话页依赖两个不同的对象:
//   · 宿主(一台机器:文件 / git / 终端 / agent 进程)→ `rpc.*`(rpc.ts),类型化代理,一处注册。
//   · 壳(一个账号:登录态 / 通讯录 / 分享 / 寻址)→ 这里的 `SessionShellPort`。
// 桌面版两者恰好是同一个进程(electron/main.ts),所以从前没人区分,壳的活写成了裸字符串
// `invoke('sessionpage:…')`——逃出类型系统的正是这几条,网页版把宿主与壳物理拆开后全部无人应答。
//
// 规则:通道名只在本文件出现一次;会话页与壳的源码里 ❌ 裸 `invoke('…')` 字面量
// (scripts/check-session-shell-port.mjs 守着,判语法形状不判清单)。桌面版 main 的 handler 与网页版壳
// 的应答表都引这份常量,漏一条是编译期 / lint 期的事,不是上线后的 `No handler registered`。

export const SESSION_SHELL_CHANNELS = {
  /** 这条会话绑定的是哪个咕咕 agent(null = 还没有身份 → 分享入口置灰)。 */
  agentCard: 'sessionpage:agent-card',
  /** 本机绑定索引上**全部**「会话 → agent id」并加入 canonical display_name,一次读完(侧栏身份卡用,#6092)。 */
  agentNames: 'sessionpage:agent-names',
  /** 改这条会话的 agent 名(云端 display_name + 本机花名册一起,#6091);返回改后的那一行。 */
  renameAgent: 'sessionpage:rename-agent',
  /** 请壳打开它已有的分享名片(SharePosterDialog);没身份时由壳说明原因。 */
  shareAgent: 'sessionpage:share-agent',
  /** 请壳打开它已有的问题反馈(侧栏那一个);报障只有这一处,会话页不另建通路。 */
  openFeedback: 'sessionpage:open-feedback',
  /** 首轮走路由时要的「这条会话的地址」:{chatId, agentUserId}。 */
  ensureAgentAddress: 'sessionpage:ensure-agent-address',
  /** 会话页资产没载入 = 应用级顶级错误,交给壳 fail loud。 */
  fatalBoot: 'sessionpage:fatal-boot',
  sessionPeers: 'sessionpage:session-peers',
} as const

export type SessionShellChannel = (typeof SESSION_SHELL_CHANNELS)[keyof typeof SESSION_SHELL_CHANNELS]

export const SESSION_PRIVATE_AGENT_ERROR = 'SESSION_PRIVATE_EXTERNAL_AGENT'

const SHELL_CHANNEL_SET: ReadonlySet<string> = new Set(Object.values(SESSION_SHELL_CHANNELS))

export function isSessionShellChannel(channel: string): channel is SessionShellChannel {
  return SHELL_CHANNEL_SET.has(channel)
}

export interface SessionShellAgentCard {
  agentUserId: string
  /** 该 agent 的显示名(= 寻址名,如 `Codex 8`)。 */
  displayName: string
}

/**
 * 一条会话在通讯录里的身份:名字 + agent id。
 *
 * 与 `agentCard` 是**同一个事实的批量形态**,不是第二份数据:两者都按本机绑定找到 agent id,再读
 * `identity.users.display_name` (`resolveSessionpageAgentCard` 的注释里写的那条「按钮上显示什么、名片上分享的就是什么」)。
 * 之所以要批量口:侧栏是一屏十几行、指针一路划过去的场面,按会话逐条查等于把整份花名册读十几遍。
 *
 * agentUserId 在这里只用于**展示与复制**(侧栏身份卡那四行之一,#6092);寻址仍走 ensureAgentAddress ——
 * 那一口带着 provisioning 与归属仲裁,这一口没有。
 */
export interface SessionShellAgentName {
  conversationId: string
  /** 该 agent 的显示名(= 寻址名,如 `Codex 8`)。 */
  displayName: string
  agentUserId: string
  /** Derived host intent: this name is durable locally and still awaiting identity publication. */
  pendingManual?: true
}

/**
 * 名册(session_peers)的一行:一条有咕咕身份的会话。@ 弹层、拖进输入框都读它;`gugu_number` 没公开过就是 null。
 * 线上就是宿主 `resolveSessionpageSessionPeers` 那一行的形状(多出来的格照带,这里只认要用的几格)。
 */
export interface SessionShellPeer {
  sessionId: string
  identity: { users: { id: string; display_name: string; gugu_number: number | null; name_serial?: number | null; session_archived_at?: string | null } }
  engine: string
}

/**
 * 侧栏「这一行是谁」那张表 = 名册(session_peers)的投影:会话 id、agent id、名字三格都取自那一行。宿主(本机名册)
 * 与渲染层(会话目录里别的机器)共用这一份,❌ 各拼一次名字(两条路曾对重复绑定各定一条规矩)。
 */
export function agentNamesFromPeers(peers: readonly Pick<SessionShellPeer, 'sessionId' | 'identity'>[]): SessionShellAgentName[] {
  return peers.map((peer) => ({
    conversationId: peer.sessionId,
    displayName: peer.identity.users.display_name,
    agentUserId: peer.identity.users.id,
  }))
}

export interface SessionShellRenameAgentInput {
  sessionId: string
  name: string
}

export interface SessionShellAgentAddressInput {
  projectId: string
  sessionId: string
}

export interface SessionShellAgentAddress {
  chatId: string
  agentUserId: string
}

export interface SessionShellPort {
  agentCard(sessionId: string): Promise<SessionShellAgentCard | null>
  /** 已绑定身份的会话才在列;没有身份的会话不出现(❌ 不回一个空名字占位)。 */
  agentNames(): Promise<SessionShellAgentName[]>
  /** 改会话的 agent 名。没身份 / 不归当前账号 / 云端拒绝 → 抛,由调用方就地呈现。 */
  renameAgent(input: SessionShellRenameAgentInput): Promise<SessionShellAgentName>
  /**
   * true = 壳已接手打开分享;false = 壳已向用户说明为何不能分享。
   * `card`:#6264 会话在别的机器上时,名片由那台机器答,壳只负责画(缺席 = 壳自己按会话查)。
   */
  shareAgent(sessionId: string, card?: SessionShellAgentCard | null): Promise<boolean>
  /** true = 壳已打开问题反馈。 */
  openFeedback(): Promise<boolean>
  ensureAgentAddress(input: SessionShellAgentAddressInput): Promise<SessionShellAgentAddress>
  fatalBoot(message: string): Promise<void>
  /** 这台机器上有咕咕身份的会话(名册那一份);别的机器上的从会话目录读,❌ 经这一口逐台去问。 */
  sessionPeers(sessionId?: string): Promise<SessionShellPeer[]>
}

export type SessionShellInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

/**
 * 「这个形态的壳不提供这条能力」—— 一个**已知状态**,调用方按状态处理(入口置灰、走别的路),
 * ❌ 与「查询故障」混为一谈。跨传输后原型会丢,所以按 name 判,不按 instanceof。
 */
export class SessionShellUnsupportedError extends Error {
  override readonly name = 'SessionShellUnsupportedError'
  constructor(readonly channel: SessionShellChannel) {
    super(`session shell does not answer ${channel} in this form`)
  }
}

export function isSessionShellUnsupported(error: unknown): error is SessionShellUnsupportedError {
  return error instanceof Error && error.name === 'SessionShellUnsupportedError'
}

function requireAddress(value: unknown): SessionShellAgentAddress {
  const address = value as Partial<SessionShellAgentAddress> | null | undefined
  if (!address?.chatId || !address.agentUserId) {
    throw new Error('Session-page router did not return an exact agent address')
  }
  return { chatId: address.chatId, agentUserId: address.agentUserId }
}

/** 跨传输回来的是裸 JSON:少一格、多一格、名字是空串,都按「这条不在列」处理,❌ 不让它变成一个没名字的行。 */
function agentNameOrNull(row: unknown): SessionShellAgentName | null {
  const entry = row as Record<string, unknown> | null | undefined
  const sessionId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : ''
  const displayName = typeof entry?.displayName === 'string' ? entry.displayName.trim() : ''
  const agentUserId = typeof entry?.agentUserId === 'string' ? entry.agentUserId.trim() : ''
  return sessionId && displayName && agentUserId ? { conversationId: sessionId, displayName, agentUserId,
    ...(entry?.pendingManual === true ? { pendingManual: true as const } : {}) } : null
}

function agentNames(value: unknown): SessionShellAgentName[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const name = agentNameOrNull(row)
    return name ? [name] : []
  })
}

/** 改名的回执少一格就是没改成:❌ 把一个残缺回执当成功往界面上写。 */
function requireAgentName(value: unknown): SessionShellAgentName {
  const name = agentNameOrNull(value)
  if (!name) throw new Error('Session-page shell did not return the renamed agent')
  return name
}

function cardOrNull(value: unknown): SessionShellAgentCard | null {
  const card = value as Partial<SessionShellAgentCard> | null | undefined
  if (!card?.agentUserId) return null
  return { agentUserId: card.agentUserId, displayName: card.displayName ?? '' }
}

/** 会话页侧:把一条 `invoke` 包成类型化的壳口。这是全仓唯一一处用壳通道名发起调用的地方。 */
export function createSessionShellPort(invoke: SessionShellInvoke): SessionShellPort {
  return {
    agentCard: async (sessionId) =>
      cardOrNull(await invoke(SESSION_SHELL_CHANNELS.agentCard, sessionId)),
    agentNames: async () => agentNames(await invoke(SESSION_SHELL_CHANNELS.agentNames)),
    renameAgent: async (input) => requireAgentName(await invoke(SESSION_SHELL_CHANNELS.renameAgent, input)),
    shareAgent: async (sessionId, card) =>
      (await invoke(SESSION_SHELL_CHANNELS.shareAgent, sessionId, ...(card === undefined ? [] : [card]))) === true,
    openFeedback: async () => (await invoke(SESSION_SHELL_CHANNELS.openFeedback)) === true,
    ensureAgentAddress: async (input) =>
      requireAddress(await invoke(SESSION_SHELL_CHANNELS.ensureAgentAddress, input)),
  fatalBoot: async (message) => {
      await invoke(SESSION_SHELL_CHANNELS.fatalBoot, message)
    },
    // 只答本机(同一个构建的主进程);那边对不一致的名册已经响亮地抛错,❌ 这里再定一条悄悄丢行的规矩。
    sessionPeers: async (...args) => (await invoke(SESSION_SHELL_CHANNELS.sessionPeers, ...args)) as SessionShellPeer[],
  }
}

/** 壳侧的应答表:缺项 = 这个形态明确不提供(调用方收到 SessionShellUnsupportedError)。 */
export type SessionShellAnswers = Partial<SessionShellPort>

const ANSWER_BY_CHANNEL: Record<SessionShellChannel, keyof SessionShellPort> = {
  [SESSION_SHELL_CHANNELS.agentCard]: 'agentCard',
  [SESSION_SHELL_CHANNELS.agentNames]: 'agentNames',
  [SESSION_SHELL_CHANNELS.renameAgent]: 'renameAgent',
  [SESSION_SHELL_CHANNELS.shareAgent]: 'shareAgent',
  [SESSION_SHELL_CHANNELS.openFeedback]: 'openFeedback',
  [SESSION_SHELL_CHANNELS.ensureAgentAddress]: 'ensureAgentAddress',
  [SESSION_SHELL_CHANNELS.fatalBoot]: 'fatalBoot',
  [SESSION_SHELL_CHANNELS.sessionPeers]: 'sessionPeers',
}

/**
 * 壳侧:给一条 `invoke` 加上壳通道的分流 —— 壳通道由 `answers` 当场应答,其余原样交给宿主。
 * 壳通道**永远不**送往宿主:宿主是另一方,它回的 `No handler registered` 只会把「壳没做」伪装成
 * 「宿主坏了」。壳没给应答的通道 → SessionShellUnsupportedError。
 */
export function answerSessionShellChannels(hostInvoke: SessionShellInvoke, answers: SessionShellAnswers): SessionShellInvoke {
  return async (channel, ...args) => {
    if (!isSessionShellChannel(channel)) return hostInvoke(channel, ...args)
    const method = ANSWER_BY_CHANNEL[channel]
    const answer = answers[method] as ((...input: unknown[]) => Promise<unknown>) | undefined
    if (!answer) throw new SessionShellUnsupportedError(channel)
    return answer(...args)
  }
}
