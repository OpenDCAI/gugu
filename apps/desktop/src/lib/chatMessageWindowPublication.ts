import type { MessageItem } from '@gugu/core/shared/types/chat'
import { readDisplayIdentities } from './identityReadAdapter'
import { imSelectors, replaceMessageWindow, type AccountImRepository } from './imRepository'
import { installIdentityDirectoryBridge, publishIdentityDirectory, type IdentityDirectorySnapshot } from './identityDirectoryBridge'
import { rendererLogger } from './log'

const log = rendererLogger('chat/message-window')
const directoryLog = rendererLogger('chat/identity-directory')

// #6306 会话页投递卡读本地身份缓存的窗口:本模块只由咕咕壳 bundle 引入(store/chat.tsx),加载即装桥 ——
// 早于会话页 bundle 执行,会话页首次订阅就挂得住。契约见 identityDirectoryBridge.ts。
installIdentityDirectoryBridge()

/**
 * 问过 identity 表、这一次没有这一行的发送者 id,按账号(repository)记、带过期:窗口每次追加消息都会重落,
 * 不该每次都为同一个注销账号再发一次读;但「没读到」也可能是刚建的行短暂读不到(chatListIdentityCompleteness),
 * 所以只是缓一段时间,不是永久拉黑。
 */
const ABSENT_RETRY_MS = 5 * 60_000
const absentUntil = new WeakMap<AccountImRepository, Map<string, number>>()
/** 正在读的 id:同一个 id 在第一次读回来之前不再发第二次(投递卡每次重读都会来问)。 */
const inFlight = new WeakMap<AccountImRepository, Set<string>>()

/**
 * 消息窗口落本地库,并把窗口里**还没有身份**的发送者(含被回复者)身份一并提交。
 *
 * 会话列表投影只为**当前成员**索要身份;退群 / 被移出的成员没有成员行,投影闭包再不会为他索要 ——
 * 于是在任何没提交过他身份的设备上,他的历史消息永远空名字、资料卡点不开(#5610 §2.3)。
 * 消息窗口是这些 id 的唯一引用方,所以由它在写入时补齐身份。
 *
 * 身份读失败会让这次持久化以错误结束(调用方已记日志):窗口本身先落库,身份在其后一笔,不互相拖累。
 */
export async function publishMessageWindow(
  repository: AccountImRepository,
  chatId: string,
  messages: MessageItem[],
  hasMoreOlder = false,
): Promise<void> {
  await replaceMessageWindow(repository, chatId, messages, hasMoreOlder)
  const ids: string[] = []
  for (const message of messages) {
    for (const id of [message.sender_user_id, message.reply_to_sender_user_id]) if (id) ids.push(id)
  }
  await ensureIdentities(repository, ids, { chatId })
}

/**
 * 把「还没有身份」的 id 读进本地库 —— 本地身份缓存(IM repository)唯一的按需补取口。消息窗口与会话页投递卡
 * (经 identityDirectoryBridge,#6306)共用它,于是共用同一张「问过、库里没有」的缓期表,不会为同一个 id 各读各的。
 */
export async function ensureIdentities(
  repository: AccountImRepository,
  ids: readonly string[],
  context: Record<string, unknown>,
): Promise<void> {
  const committed = new Set(repository.snapshot().identity.map((row) => row.id))
  let absent = absentUntil.get(repository)
  if (!absent) absentUntil.set(repository, absent = new Map())
  let reading = inFlight.get(repository)
  if (!reading) inFlight.set(repository, reading = new Set())
  const now = Date.now()
  const wanted = new Set<string>()
  for (const id of ids) {
    if (!committed.has(id) && !reading.has(id) && (absent.get(id) ?? 0) <= now) wanted.add(id)
  }
  if (wanted.size === 0) return
  const asked = [...wanted]
  for (const id of asked) reading.add(id)
  try {
    const identities = await readDisplayIdentities(asked)
    for (const identity of identities) wanted.delete(identity.id)
    for (const id of wanted) {
      absent.set(id, now + ABSENT_RETRY_MS)
      log.error({ ...context, userId: id }, '[resolve-fail #1624] message sender has no identity row')
    }
    if (identities.length > 0) await repository.putIdentities(identities)
  } finally {
    for (const id of asked) reading.delete(id)
  }
}

/**
 * 本地身份缓存的订阅(#6306):聊天页的 state 与会话页的身份目录读的是同一份 identitiesById,缺的 id 交回 ensureIdentities。
 */
export function subscribeIdentities(
  repository: AccountImRepository,
  onIdentities: (identities: IdentityDirectorySnapshot) => void,
): () => void {
  return repository.subscribe(imSelectors.identitiesById, (identities) => {
    onIdentities(identities)
    publishIdentityDirectory(identities, (ids) => {
      void ensureIdentities(repository, ids, { source: 'session-page delivery card' })
        .catch((error) => directoryLog.error({ error, ids }, 'ensure identities for session page failed'))
    })
  })
}

/** 账号作用域结束:关本地库,会话页的身份目录随之清空(目录的寿命 = 这份缓存的寿命)。 */
export function closeImRepository(repository: AccountImRepository): void {
  repository.close()
  publishIdentityDirectory(null, null)
}
