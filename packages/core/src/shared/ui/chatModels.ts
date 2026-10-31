import type { ChatItem, ChatKind } from '../types/chat'

/**
 * @@@5856 「场所型」会话 = 群 + 话题。两者同形:都有自己的名字、自己的成员名单、自己的头像、
 * 自己的群规与响应档位;而 dm/ai 是「一条通向某个对端的线」,没有这些。
 *
 * 为什么要一个判据而不是逐处 `kind === 'group' || kind === 'topic'`:加 'topic' 之前产品里
 * 「群」与「场所」是同一个词,所以判断散落在 80 多处 —— 漏一处的表现不是报错,是「话题没有名字」
 * 「话题头栏没有成员按钮」这类静默缺陷,typecheck 一个都照不出来。
 *
 * ❌ 不要用它替换所有 `kind === 'group'`:有些地方问的确实是「是不是群」而不是「是不是场所」
 * (邀请链接、公开群发现、建群流程 —— 话题没有这些)。改每一处前先问这一句。
 */
export function isRoomChat(kind: ChatKind): boolean {
  return kind === 'group' || kind === 'topic'
}

/**
 * 未读里算到你头上的条数(owner 10-28):话题只算叫到你的 —— 点名你、@all、回复你说的;其余会话算全部未读。
 * agent 开的话题会把主人拉成成员,agent 之间的往来照旧是话题自己的未读(话题页签上的数),但不进项目行、不弹通知。
 * 没有 locator(没有未读 = 0;本机刚手动标未读、还没刷新 = 1,与服务端「手动标记算 1」一致)就照 unread_count。
 */
export function unreadForYou(chat: Pick<ChatItem, 'kind' | 'unread_count' | 'unread_locator'>): number {
  if (chat.kind !== 'topic' || !chat.unread_locator) return chat.unread_count
  // 不知道哪几条叫到你(旧后端、旧缓存)就照旧全算:多算一点,❌ 把点名你的那条算没。
  return chat.unread_locator.addressed_count ?? chat.unread_count
}

export function fallbackChatName(kind: ChatKind): string {
  if (kind === 'dm') return '聊天'
  if (kind === 'topic') return '话题'
  return '群聊'
}

/**
 * @@@5856 一条会话在界面上叫什么。**唯一判据**,会话列表 / 转发目标 / 话题面包屑都读它。
 *
 * 为什么要收口:加 'topic' 之前这句话在三个文件里各写了一份 `kind === 'group' ? name : peer`,
 * 于是加话题时三处各漏一次,表现全是「一行没有名字的空白」——而且转发框拿同一个值做搜索匹配,
 * 空名字等于**按名字永远搜不到**。判据散着就一定会分叉,所以不是各修各的,是只留一份。
 *
 * peerDisplayName 由调用方解析后传进来(渲染层才有 identity 映射),这样这个函数保持纯的、可单测,
 * 调用方也仍可以在解析失败时按自己的口径响一声(会话列表就走 resolveOrLoud)。
 *
 * ⚠️ **dm/ai 解析不出对端名字时返回空串,❌ 不许拿 fallbackChatName 冒充**(#1623 / #1624):
 * 「一个看起来正常的假名字」会把「对端解析失败」这个 bug 藏起来 —— #1623 就是一条 agent 私聊的对端
 * 解析不出来、界面安静地画成「聊天」,名字丢了而看上去一切正常。resolveOrLoud 那份契约说得很死:
 * 数据层解析失败要响,渲染层才可以优雅。
 * 场所的兜底名是另一回事:群名是用户输入(空名建群本来就落「群聊」),话题名由 create_topic 保证非空
 * (最差是「话题」)—— 那属于契约里明写的「user-input defaults」,不是解析失败。
 */
export function groupDisplayName(group: { name?: string | null; alias?: string | null }): string {
  return group.alias?.trim() || group.name?.trim() || fallbackChatName('group')
}

export function chatDisplayName(
  chat: Pick<ChatItem, 'kind' | 'name' | 'peer_alias' | 'alias'>,
  peerDisplayName: string | null | undefined,
): string {
  if (chat.kind === 'group') return groupDisplayName(chat)
  if (chat.kind === 'topic') return chat.name?.trim() || fallbackChatName(chat.kind)
  return chat.peer_alias?.trim() || peerDisplayName?.trim() || ''
}

function createOptimisticChat(
  chatId: string,
  kind: ChatKind,
  name: string,
  peerUserId: string | null = null,
): ChatItem {
  return {
    id: chatId,
    kind,
    status: 'active',
    ...(peerUserId ? { peer_user_id: peerUserId } : {}),
    name,
    created_at: new Date().toISOString(),
    last_message_at: null,
    last_message_preview: null,
    unread_count: 0,
    pinned_message_id: null,
    last_read_seq: 0,
    is_marked_unread: false,
    read_state_version: 0,
    next_message_seq: 1,
  }
}

export function createOptimisticAgentChat(chatId: string, agentUserId: string | null = null): ChatItem {
  return createOptimisticChat(chatId, 'ai', '', agentUserId)
}

export function createOptimisticDmChat(chatId: string, peerUserId: string): ChatItem {
  return createOptimisticChat(chatId, 'dm', '', peerUserId)
}

export function createOptimisticGroupChat(chatId: string, name: string): ChatItem {
  return createOptimisticChat(chatId, 'group', name)
}

// @@@2264 — canonical last-activity 投影:会话列表排序消费的唯一信号。无消息的会话按创建时刻排序——
// 新建即在「此刻」置顶,然后像普通活动一样随时间老化;绝不用「永远最新」哨兵(#1953 的 null→Infinity
// 在 #2208 移除建号问候语后变成永久霸榜:空会话钉死列表顶端,别的会话来新消息也排不到它前面)。
// 首条消息落库后 last_message_at ≥ created_at,排序键单调前移,无列表跳动。
export function chatActivityAt(chat: Pick<ChatItem, 'last_message_at' | 'created_at'>): string {
  return chat.last_message_at ?? chat.created_at
}

/**
 * @@@empty-dm-not-listed — 单聊(dm/ai)要有过消息才在会话列表占一行。
 *
 * 为什么:一条私聊 chat 行的存在只意味着「这个对端可寻址」,不意味着「有一段对话」。
 * 列表要回答的是「我有哪些正在进行的对话」,不是「我有哪些可寻址的对端」;后者是通讯录的职责。
 *
 * 与 `@@@no-auto-dm`(会话页不再自动开私聊)是**两道闸,不是一道**:那道管「建不建」,治的是新增;
 * 这道管「列不列」,治的是①存量已经建出来的那批空壳、②用户从通讯录点开却没说话的私聊 ——
 * 这两类它挡不住。❌ 别因为源头收紧了就把这道撤掉。
 *
 * ❌ 不是删 chat 行,也不是不建:chat 行照建照留,agent 的 `gugu_message` 仍有 chat_id 可投递,首条消息
 * 一落库这一行就自己浮出来。这里只管「列不列」。
 *
 * 群不受此约束 —— 建群是一次明确的用户动作,建完即是一个存在的场所。
 * @@@5856 话题同理:开话题也是一次明确的用户动作(右键某条消息 →「开话题」),开完即存在,
 * 不等第一条消息。数据层同源 —— set_inbox_publication_on_membership_insert 对 group 与 topic
 * 一样在入列那一刻就发布收件箱。
 */
export function isChatListed(
  chat: Pick<ChatItem, 'id' | 'kind' | 'last_message_at' | 'unread_count' | 'is_marked_unread' | 'is_pinned'>,
  context: { activeChatId?: string | null; hasDraft?: boolean } = {},
): boolean {
  if (chat.kind === 'group' || chat.kind === 'topic') return true
  if (chat.last_message_at) return true
  // 以下都是「用户自己在这条空会话上留了痕」——抹掉它等于把用户的动作吞掉。
  if (chat.is_pinned) return true
  if (chat.is_marked_unread || chat.unread_count > 0) return true
  if (context.hasDraft) return true
  // 正开着的会话不许从脚下消失(从通讯录点进来的空私聊就是这一条)。
  return chat.id === context.activeChatId
}

/**
 * @@@5856 话题的「沉降」—— product spec「没有开关,只有沉降」。
 *
 * ❌ 没有「关闭 / 完成」按钮:凡是靠人主动维护的状态位,最后都是脏的(同类产品里手动关闭是管理员
 * 工具,日常没人走)。一段时间无活动就自己沉到列表的「更早」,**任何人发一句自己浮回来**。
 *
 * 判据只读 last_message_at ⇒ 不落任何状态位、不需要定时任务、浮回来是免费的。
 * 7 天取自 owner 拍板时指定的参照物(Discord 论坛帖默认 7 天自动归档,发帖即解除归档)。
 *
 * 沉降只影响**列表位置**:可见性、成员、搜索、以及话题里 agent 的死活都不受影响。
 */
export const TOPIC_SINK_AFTER_DAYS = 7

export function isSunkTopic(
  chat: Pick<ChatItem, 'kind' | 'last_message_at' | 'created_at' | 'unread_count' | 'is_marked_unread' | 'is_pinned'>,
  now: number = Date.now(),
): boolean {
  if (chat.kind !== 'topic') return false
  // 用户自己留过痕的不沉:置顶、标未读、有未读 —— 沉降不许吞掉用户的动作,也不许藏起没读的东西。
  if (chat.is_pinned || chat.is_marked_unread || chat.unread_count > 0) return false
  const last = new Date(chatActivityAt(chat)).getTime()
  if (!Number.isFinite(last)) return false
  return now - last >= TOPIC_SINK_AFTER_DAYS * 24 * 60 * 60 * 1000
}

// 解析比较(非字典序):服务端时间戳带 +00:00 后缀、客户端 toISOString 带 Z,字符串序会错判。
export function compareChatsByActivityDesc(
  a: Pick<ChatItem, 'last_message_at' | 'created_at'>,
  b: Pick<ChatItem, 'last_message_at' | 'created_at'>,
): number {
  return new Date(chatActivityAt(b)).getTime() - new Date(chatActivityAt(a)).getTime()
}

export function upsertChatRow(chats: ChatItem[], chat: ChatItem): ChatItem[] {
  const exists = chats.some((item) => item.id === chat.id)
  return exists
    ? chats.map((item) => (item.id === chat.id ? { ...item, ...chat } : item))
    : [chat, ...chats]
}

export function mergeFetchedChatsPreservingActiveLocal(
  fetchedChats: ChatItem[],
  currentChats: ChatItem[],
  activeChatId: string | null,
  options: { preserveMissingActive?: boolean } = {},
): ChatItem[] {
  const preserveMissingActive = options.preserveMissingActive ?? true
  // @@@1618 — 不要让 getChats 偶发的瞬态 null 对端字段覆盖已解析的值。并发创建 agent 时,新 DM 的 chat_members
  // 行尚未提交 → getChats 的成员解析(otherUserIdMap 等)滞后返回 peer_user_id=null,会把乐观/已解析的 peer 抹掉
  // → 「direct chat profile missing peer_user_id」warn 刷屏 + 抽屉对端资料瞬态缺失(#1618)。dm/ai 的对端不可变:
  // fetched 缺 peer_user_id 而本地已有时,保留本地已解析的 peer_* / avatar(成员提交后下轮 getChats 自然带上)。
  const localById = new Map(currentChats.map((chat) => [chat.id, chat]))
  const merged = fetchedChats.map((fetched) => {
    const local = localById.get(fetched.id)
    let next = fetched
    if ((fetched.kind === 'dm' || fetched.kind === 'ai') && !fetched.peer_user_id && local?.peer_user_id) {
      next = {
        ...next,
        peer_user_id: local.peer_user_id,
      }
    }

    // Read state is one versioned member-row tuple. A request started before mark_read/mark_unread commits
    // may arrive later; preserve the locally newer tuple for active and inactive rows alike. Never merge
    // unread_count independently from the cursor/manual bit that produced it.
    const fetchedReadStateVersion = fetched.read_state_version ?? 0
    const localReadStateVersion = local?.read_state_version ?? 0
    if (local && localReadStateVersion > fetchedReadStateVersion) {
      next = {
        ...next,
        last_read_seq: local.last_read_seq,
        is_marked_unread: local.is_marked_unread ?? false,
        read_state_version: localReadStateVersion,
        unread_count: local.unread_count,
        unread_locator: local.unread_locator,
      }
    } else if (fetched.id === activeChatId && local && fetched.last_read_seq < local.last_read_seq) {
      // Compatibility for cached rows written before read_state_version existed.
      next = {
        ...next,
        last_read_seq: local.last_read_seq,
        is_marked_unread: local.is_marked_unread ?? false,
        read_state_version: localReadStateVersion,
        unread_count: local.unread_count,
        unread_locator: local.unread_locator,
      }
    }
    return next
  })
  const activeLocalChat = activeChatId
    ? currentChats.find((chat) => chat.id === activeChatId)
    : null
  return preserveMissingActive && activeLocalChat && !merged.some((chat) => chat.id === activeLocalChat.id)
    ? [activeLocalChat, ...merged]
    : merged
}
