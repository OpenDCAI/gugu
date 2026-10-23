// #4562 —— 本机直投唯一入口 `session_message` 的收敛点:寻址在这里解析,投递只有一条路。
//
// 收件人一律是一条会话。身份写法(`aid:` / `gugu:` / `user:`)只是那条会话的另一个名字:在解析阶段就换成它
// (本机名录;别的机器上的,问那台机器的会话列表),然后与 `session:` 走同一条投递 —— 编排层的 message 动作
// (信封、耐久 outbox、唤醒都只有一份)。本机没有的地址(owner 2026-09-30 拍板跨机器)交给它所在的机器,
// 那台机器跑同一个动作(cross-machine-sessions.ts)。
// 全部目标在任何副作用前解析(spec delivery-routing):名录墓碑 = 已删除、未映射 fail loud,任何地址错误都先于第一次注入。
// 一个地址有没有意义不只取决于名录,还取决于谁在发:发给调用者自己的地址没有合法含义,与未映射、
// 已删除同属地址错误。两种写法都在这里判:`session:` 按调用者自己的会话,身份写法按调用者的 Agent ID。
// 解析通过后逐收件人独立投递,返回 per-recipient 的 delivered/failed 与结构化错误。
//
// 本模块只做寻址解析、预检次序与结果合并;投递归编排层,❌ 不在这里长出第二套投递。

import type { SessionAttachmentRef, SessionFileInput } from '@gugu/core/cloud/sessionAttachments'
import { decodeIdentityAddress, decodeTypedId, encodeTypedId } from '@gugu/core/shared/typedId.mjs'

export type UnifiedRecipientResult = {
  /** Typed recipient address, exactly as the caller may reuse it. */
  to: string
  status: 'delivered' | 'failed'
  message_id?: string
  error?: { code: string; message: string }
}

/** What the sender says about this message besides its text — carried to the recipient's envelope as given (see the orchestration's message action). */
export type SessionMessageSaid = { attachments?: SessionAttachmentRef[]; then?: string; reply_to_message_id?: string; source_link?: string }

export type UnifiedSessionMessageDeps = {
  prepareFiles?: (files: SessionFileInput[], targets: Array<{ sessionId: string; deviceId?: string }>) => Promise<SessionAttachmentRef[]>
  /** The graph (`session:`) leg — resolves all its bare targets before injecting any. Absent when the caller has no session-page session (gugu-native bridge). */
  graphMessage: ((sessionIds: string[], text: string, said: SessionMessageSaid) => Promise<{ recipients: UnifiedRecipientResult[] }>) | null
  /**
   * Who is calling — a session cannot address itself, by either spelling (an identity resolves to its session first).
   * A runtime fork (side chat) runs its session actions as the session it was forked from, so `sessionId` is its source's.
   */
  caller: {
    sessionId: string
    runtimeFork: boolean
  }
  /** Read-only roster read: the session each of these Agent IDs is on this machine (absent = not mapped here), and which are tombstoned. */
  localSessionsOfAgents: (userIds: string[]) => Promise<{
    sessions: Map<string, string>
    deletedRecipients: { userId: string; name: string | null }[]
  }>
  /**
   * `gugu:<咕咕号>` → that local session's identity UUID, read from the same roster `session_peers` lists (#5048).
   * A number the roster does not carry is simply absent from the map; the handler names it and fails loud.
   */
  resolveLocalGuguNumbers: (numbers: number[]) => Promise<Map<number, string>>
  /** Which of these `session:` ids are sessions on this machine. Absent = every one is taken as local (the graph leg judges). */
  localSessionIds?: (sessionIds: string[]) => Promise<string[]>
  /**
   * The other machines of this account (owner 2026-09-30:agent 的 session_* 跨机器). Absent = this machine only,
   * exactly as before. Every lookup here is read-only; `deliver` is the only side effect and runs after every
   * address (and every machine's reachability) is settled.
   */
  remote?: {
    /** `session:` ids not on this machine → the machine each is on. `missingMessage` names what was searched when some are nowhere. */
    locateSessions: (sessionIds: string[]) => Promise<{ found: Map<string, string>; missingMessage: string | null }>
    /** Agent IDs / 咕咕号 not on this machine's roster → this account's agents in the cloud identity (others' agents are absent). */
    locateAgents: (input: { userIds: string[]; numbers: number[] }) => Promise<{
      byUserId: Map<string, string | null>
      numberToUserId: Map<number, string>
    }>
    thisDeviceId: () => Promise<string>
    /** Agent IDs on that machine → the session each is (that machine's session list); absent = not one of its sessions. */
    sessionsOfAgents: (deviceId: string, userIds: string[]) => Promise<Map<string, string>>
    /** Throws (offline, not this account's, …) naming the machine, before anything is sent anywhere. */
    assertReachable: (deviceIds: string[]) => Promise<void>
    deliver: (deviceId: string, input: { sessionIds: string[]; text: string; said: SessionMessageSaid }) => Promise<UnifiedRecipientResult[]>
  }
}

export async function handleUnifiedSessionMessage(
  record: Record<string, unknown>,
  deps: UnifiedSessionMessageDeps,
): Promise<{ route: 'session-direct'; recipients: UnifiedRecipientResult[] }> {
  const rawTo = record.to
  if (!Array.isArray(rawTo) || !rawTo.length || !rawTo.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw new Error(
      'session_message requires to: a non-empty array of typed addresses — "session:<id>" for a session of yours on any of your machines, "aid:<Agent ID>" or "gugu:<number>" for one of your agents from session_peers ("user:<uuid>" is the older spelling of aid:)',
    )
  }
  const text = typeof record.text === 'string' ? record.text : ''
  if (!text.trim()) throw new Error('message text is required')
  // 取值由收件那台机器的编排层判(远端调用者不经过本机 schema),这里只原样带过去。
  const said: SessionMessageSaid = {
    ...(record.source_link !== undefined ? { source_link: record.source_link as string } : {}),
    ...(record.then !== undefined ? { then: record.then as string } : {}),
    ...(record.reply_to_message_id !== undefined ? { reply_to_message_id: record.reply_to_message_id as string } : {}),
  }
  // 每个地址连同调用者的原始写法:地址错误要原样回显(弱模型靠字面对上自己刚写的参数)。
  const sessions: { entry: string; id: string }[] = []
  const identities: { entry: string; userId: string | null; number: number | null }[] = []
  for (const entry of rawTo as string[]) {
    if (entry.startsWith('session:')) sessions.push({ entry, id: decodeTypedId('session', entry, 'to') })
    else if (entry.startsWith('aid:') || entry.startsWith('user:') || entry.startsWith('gugu:')) {
      // 身份地址的语法只在 typedId.mjs 一处(#5048):user: 当场是 uuid,gugu: 记下号,投递前换成 uuid。
      const address = decodeIdentityAddress(entry, 'to')
      identities.push(address.kind === 'user'
        ? { entry, userId: address.id, number: null }
        : { entry, userId: null, number: address.number })
    } else {
      throw new Error(
        `session_message: ${JSON.stringify(entry)} is not a typed address — pass "session:<id>" (a typed session id), "aid:<Agent ID>" (from session_peers or a session’s share card; "user:<uuid>" is the older spelling) or "gugu:<number>" (a 咕咕号 from session_peers); bare ids are rejected`,
      )
    }
  }
  const sessionIds = [...new Set(sessions.map((item) => item.id))]
  const guguNumbers = [...new Set(identities.flatMap((item) => (item.number === null ? [] : [item.number])))]
  /** 别的机器上的收件人(会话 id),按机器分组。 */
  const remote = new Map<string, string[]>()
  /** 身份写法换成的会话:结果里照旧按 Agent ID 回报(调用方认得自己写的那个)。 */
  const named = new Map<string, string>()
  /** 本机名录:Agent ID → 它那条会话。 */
  const localOf = new Map<string, string>()
  if (guguNumbers.length) {
    // 号 → uuid 先用 session_peers 同一份本机名录;本机没有的号再查这个账号的 agent(云端身份)。都没有就与
    // 「未映射的 user:」同一种失败,在任何一条腿注入之前响。
    const resolved = await deps.resolveLocalGuguNumbers(guguNumbers)
    let missing = guguNumbers.filter((number) => !resolved.has(number))
    if (missing.length && deps.remote) {
      const found = await deps.remote.locateAgents({ userIds: [], numbers: missing })
      for (const number of missing) {
        const userId = found.numberToUserId.get(number)
        if (userId) resolved.set(number, userId)
      }
      missing = missing.filter((number) => !resolved.has(number))
    }
    if (missing.length) {
      throw new Error(
        `session_message: ${missing.map((number) => `gugu:${number}`).join(', ')} is not the 咕咕号 of a session of yours on ${deps.remote ? 'any of your machines' : 'this machine'} — `
        + 'session_peers lists each addressable session with its gugu_number. For chat members use message_send (chat_id); '
        + 'a session of yours is also addressable as session:<id>',
      )
    }
    for (const item of identities) if (item.number !== null) item.userId = resolved.get(item.number)!
  }
  const userIds = [...new Set(identities.map((item) => item.userId!))]
  // `session:`:本机库里有的就在本机;没有的去别的机器找。
  let localSessionIds = sessionIds
  if (sessionIds.length && deps.localSessionIds && deps.remote) {
    const here = await deps.localSessionIds(sessionIds)
    localSessionIds = sessionIds.filter((id) => here.includes(id))
    const elsewhere = sessionIds.filter((id) => !here.includes(id))
    if (elsewhere.length) {
      const located = await deps.remote.locateSessions(elsewhere)
      if (located.missingMessage) throw new Error(`session_message: ${located.missingMessage}`)
      for (const id of elsewhere) remote.set(located.found.get(id)!, [...(remote.get(located.found.get(id)!) ?? []), id])
    }
  }
  // 身份写法:换成它那条会话。本机名录有的就是本机的会话;没有的查这个账号的 agent(云端身份的 device_id),
  // 再问那台机器它是哪条会话。
  if (userIds.length) {
    const { sessions: mapped, deletedRecipients } = await deps.localSessionsOfAgents(userIds)
    for (const [userId, sessionId] of mapped) localOf.set(userId, sessionId)
    if (deletedRecipients.length) {
      const shown = deletedRecipients.map((entry) => `user:${entry.userId}${entry.name ? ` ("${entry.name}")` : ''}`).join(', ')
      throw new Error(`recipient ${shown} has been deleted — this agent no longer exists and cannot receive messages`)
    }
    for (const [userId, sessionId] of mapped) {
      if (!localSessionIds.includes(sessionId)) localSessionIds = [...localSessionIds, sessionId]
      if (!sessionIds.includes(sessionId)) named.set(sessionId, userId)
    }
    let missing = userIds.filter((id) => !mapped.has(id))
    if (missing.length && deps.remote) {
      const [found, thisDeviceId] = await Promise.all([
        deps.remote.locateAgents({ userIds: missing, numbers: [] }),
        deps.remote.thisDeviceId(),
      ])
      const notMine = missing.filter((id) => !found.byUserId.has(id))
      if (notMine.length) {
        throw new Error(
          `session_message: ${notMine.map((id) => `user:${id}`).join(', ')} is not one of your agents — session_message reaches only `
          + 'your own sessions; someone else’s agent is reached with message_send in a chat you share',
        )
      }
      const byDevice = new Map<string, string[]>()
      for (const id of missing) {
        const deviceId = found.byUserId.get(id)
        if (deviceId && deviceId !== thisDeviceId) byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), id])
      }
      // 问那台机器(离线、不在名下在问之前就响,一条都不投)。
      const resolved = new Set<string>()
      for (const [deviceId, ids] of byDevice) {
        for (const [userId, sessionId] of await deps.remote.sessionsOfAgents(deviceId, ids)) {
          resolved.add(userId)
          remote.set(deviceId, [...new Set([...(remote.get(deviceId) ?? []), sessionId])])
          if (!sessionIds.includes(sessionId)) named.set(sessionId, userId)
        }
      }
      missing = missing.filter((id) => !resolved.has(id))
    }
    if (missing.length) {
      throw new Error(
        `session_message: ${missing.map((id) => `user:${id}`).join(', ')} is not a session of yours on ${deps.remote ? 'any of your machines' : 'this machine'} — `
        + 'session_peers lists each addressable session with its Agent ID. For chat members use message_send (chat_id); '
        + 'a session of yours is also addressable as session:<id>',
      )
    }
  }
  // 自指:两种写法此刻都已是会话。整单拒绝,一条都不注入 —— 滤掉自己再投给其余人会让调用者以为全部送达。
  const self = deps.caller.sessionId
  const own = [
    ...sessions.filter((item) => item.id === self).map((item) => JSON.stringify(item.entry)),
    ...identities.filter((item) => localOf.get(item.userId!) === self)
      .map((item) => (item.number === null ? JSON.stringify(item.entry) : `${JSON.stringify(item.entry)} (Agent ID ${item.userId})`)),
  ]
  if (own.length) {
    throw new Error(
      `session_message: ${own.join(', ')} ${own.length > 1 ? 'address' : 'addresses'} this session itself — a session cannot message itself; nothing was sent. `
      + (deps.caller.runtimeFork
        ? 'This side chat runs as the session it was forked from, so that address is itself, and a side chat cannot send '
          + 'messages on that session’s behalf — give your answer to the user here'
        : 'If you were asked to tell another agent something, address that agent instead: session_peers lists local '
          + 'sessions with their Agent IDs; for members of a chat use message_send with chat_id'),
    )
  }
  if (localSessionIds.length && !deps.graphMessage) {
    throw new Error('session_message needs a session-page caller')
  }
  // 别的机器能不能接:离线、不在名下都在任何注入之前响(一条都不投)。
  if (remote.size) await deps.remote!.assertReachable([...remote.keys()])

  if (record.files !== undefined) {
    if (!Array.isArray(record.files) || record.files.length < 1 || record.files.length > 8
      || record.files.some(file => !file || typeof file !== 'object' || typeof file.file_path !== 'string' || !file.file_path.trim())) throw new Error('files requires 1 to 8 local file descriptors')
    if (!deps.prepareFiles) throw new Error('Session file handoff is unavailable for this host')
    said.attachments = await deps.prepareFiles(record.files as SessionFileInput[], [
      ...localSessionIds.map(sessionId => ({ sessionId })),
      ...[...remote].flatMap(([deviceId, ids]) => ids.map(sessionId => ({ sessionId, deviceId }))),
    ])
  }
  const recipients: UnifiedRecipientResult[] = []
  const anyDelivered = () => recipients.some((entry) => entry.status === 'delivered')
  if (localSessionIds.length) recipients.push(...(await deps.graphMessage!(localSessionIds, text, said)).recipients)
  for (const [deviceId, ids] of remote) {
    try {
      recipients.push(...await deps.remote!.deliver(deviceId, { sessionIds: ids, text, said }))
    } catch (error) {
      // 已经有人收到之后,这个调用不许再抛(否则前面那几条连同 message_id 一起丢掉):那台机器上的收件人逐个记失败。
      if (!anyDelivered()) throw error
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'SESSION_REMOTE_ERROR'
      recipients.push(...ids.map((id) => ({ to: encodeTypedId('session', id), status: 'failed' as const, error: { code, message } })))
    }
  }
  // 身份写法换来的会话,结果照旧按 Agent ID 回报。
  for (const entry of recipients) {
    const userId = named.get(decodeTypedId('session', entry.to, 'to'))
    if (userId) entry.to = encodeTypedId('user', userId)
  }
  return { route: 'session-direct', recipients }
}
