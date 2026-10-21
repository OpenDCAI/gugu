import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { listGroupInvitations, type GroupInvitation } from '../lib/groupInvitations'
import { rendererLogger } from '../lib/log'
import { contactsService } from '../lib/contacts'
import { contactGroupChatsOf, sharedGroupAgentsOf } from '../lib/contactGroupChats'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { useAuth } from './auth'
import { useChatStore } from './chatContext'
import { UI_EVENTS } from '../lib/uiEvents'
import { removeAgentFromChatList } from '../lib/optimisticAgentRemoval'
import { ContactsContext, type ContactsLoadStatus } from './contactsContext'
import type { ContactGroup, ContactUser, FriendRequest } from '@gugu/core/shared/types/contacts'
import { platform } from '../platform'
import { readRequiredDisplayIdentities } from '../lib/identityReadAdapter'
import { listManagedGroupJoinRequests, managedGroupChats, type ManagedGroupJoinRequest } from '../lib/groupJoinRequests'
import { joinRequestIdentityIds } from '../lib/groupAgentJoin'
import { friendRequestEntries } from '../lib/requestHistory'
import { planBirthLooks, type AgentLook } from '../components/agentAvatar/look'
import { recordContactsRender } from '../lib/perfCounters'

type ContactRelation = Pick<ContactUser, 'id' | 'alias' | 'agent_type' | 'project_path'>
type RevisionRefreshOptions = { throwOnError?: boolean }

export function ContactsProvider({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const { user: authenticatedUser } = useAuth()
  const user = active ? authenticatedUser : null
  const { identitiesById, getImRepository, subscribeAccountRevision, refreshChats, chats, loadingChats, chatsLoadFailed, deleteChat, patchChat } = useChatStore('identitiesById', 'getImRepository', 'subscribeAccountRevision', 'refreshChats', 'chats', 'loadingChats', 'chatsLoadFailed', 'deleteChat', 'patchChat')
  // @@@1877 会话列表即时乐观移除走 chat store 既有 API(deleteChat/patchChat)——ref 存最新引用,避免把
  // 常变的 chats/随 activeChatId 变的 deleteChat 塞进 removeOwnedAgent 的 deps 造成 context 频繁重建。
  const chatListRemovalRef = useRef({ chats, deleteChat, patchChat })
  chatListRemovalRef.current = { chats, deleteChat, patchChat }
  const [contacts, setContacts] = useState<ContactRelation[]>([])
  const [groups, setGroups] = useState<ContactGroup[]>([])
  // 「我在哪些群」只有一份:会话投影(chat store 的 chats)。从前这里另拉一张整表(探针 + 全部成员 + 分块 chats + 共享 agent),
  // 每来一条消息(chat_changed)、每次已读(chat_members_changed)都重拉一遍。
  // 每来一条消息 chats 就换一份,而群这几项(名字、成员、角色、免打扰)多半没变:签名没变就沿用上一份,
  // 通讯录(常驻、藏着时也挂着)不跟着每条消息把几百行重画一遍。
  const derivedGroupChats = contactGroupChatsOf(chats)
  const groupChatsSignature = JSON.stringify(derivedGroupChats)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groupChats = useMemo(() => derivedGroupChats, [groupChatsSignature])
  // 群里别人的 agent(不是我的、也不在通讯录里):身份就在投影带回来的那份里。
  const sharedGroupAgents = useMemo(() => sharedGroupAgentsOf(groupChats, identitiesById, user?.id ?? null), [groupChats, identitiesById, user])
  const [receivedRequests, setReceivedRequests] = useState<FriendRequest[]>([])
  const [groupInvitations, setGroupInvitations] = useState<GroupInvitation[]>([])
  const [requestsStatus, setRequestsStatus] = useState<ContactsLoadStatus>('idle')
  const [requestsError, setRequestsError] = useState<string | null>(null)
  const requestsGenerationRef = useRef(0)
  // @@@6418 我管理的群收到的入群申请 —— 与好友申请同归「新的请求」。依赖群列表(要知道我管哪些群),
  // 所以单独一路加载,群列表一变就重读;错误单独记,❌ 连累好友申请那一路。
  const [groupJoinRequests, setGroupJoinRequests] = useState<ManagedGroupJoinRequest[]>([])
  const [groupJoinRequestsError, setGroupJoinRequestsError] = useState<string | null>(null)
  const groupJoinRequestsGenerationRef = useRef(0)
  const [sentRequests, setSentRequests] = useState<FriendRequest[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [loadingGroups, setLoadingGroups] = useState(false)
  // #2118 — contacts / groupChats 各自的加载三态(见 ContactsLoadStatus)。空态 CTA 只在 ready 且为空时出现。
  const [contactsStatus, setContactsStatus] = useState<ContactsLoadStatus>('idle')
  // #2118 投影读失败 = error(旧行照常画,空着不冒充「没有群」);冷启还没有一行 = loading。
  const groupChatsStatus: ContactsLoadStatus = !user ? 'idle' : chatsLoadFailed ? 'error' : loadingChats && groupChats.length === 0 ? 'loading' : 'ready'
  const [searchResults, setSearchResults] = useState<ContactRelation[]>([])
  const [isSearching, setIsSearching] = useState(false)
  // 联系人刷新可能由初始加载、revision bus 和显式 refresh 同时触发。只允许最新一代请求
  // 提交快照，避免创建 Agent 前发出的旧响应把新 Agent 从成员选择器里冲掉。
  const contactsLoadGenerationRef = useRef(0)

  // ── Load contacts ──────────────────────────────────────────────────────────
  const loadContacts = useCallback(async (options: RevisionRefreshOptions = {}) => {
    if (!user) return
    const generation = ++contactsLoadGenerationRef.current
    setLoadingContacts(true)
    // #2118 — 首次/无权威快照时进 loading(不闪假空);已 ready 的刷新保持 ready(不闪加载态)。
    setContactsStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'))
    try {
      const data = await contactsService.getContacts(user.id)
      if (generation !== contactsLoadGenerationRef.current) return
      const repository = await getImRepository()
      if (generation !== contactsLoadGenerationRef.current) return
      await repository.putIdentities(data)
      if (generation !== contactsLoadGenerationRef.current) return
      setContacts(data.map(({ id, alias, agent_type, project_path }) => ({ id, alias, agent_type, project_path })))
      setContactsStatus('ready')
    } catch (err) {
      // 代际只裁决「提交哪份快照」,绝不裁决「抛不抛」:revision listener 的 reject 是 durable operation
      // 唯一的保命信号(coordinator 只在全部 listener resolve 之后才删 pending 行)。被抢代的 strict 刷新
      // 若在这里静默 resolve,这条 revision 就会被判成消费成功、pending 行被删,失败的刷新永不重试。
      const isCurrentGeneration = generation === contactsLoadGenerationRef.current
      // #2187 — 登出边界/卸载导致的取消不是加载失败:安静收场,不误报 error 态。
      if (isLifecycleCancellation(err)) {
        if (options.throwOnError) throw err
        return
      }
      if (isCurrentGeneration) {
        console.error('[ContactsStore] loadContacts error', err)
        // #2118 fail-loud:任何加载失败都置 error(含 ready 后的 refresh 失败)——数据快照与「最近加载结果」分离,
        // 旧 contacts 列表保留(不清空、非空列表照常渲染),但空列表 + error 必须显失败/重试,绝不让空冒充「没有联系人」。
        setContactsStatus('error')
      }
      if (options.throwOnError) throw err
    } finally {
      if (generation === contactsLoadGenerationRef.current) setLoadingContacts(false)
    }
  }, [getImRepository, user])

  const loadGroups = useCallback(async (options: RevisionRefreshOptions = {}) => {
    if (!user) return
    setLoadingGroups(true)
    try {
      const data = await contactsService.getContactGroups(user.id)
      setGroups(data)
    } catch (err) {
      if (isLifecycleCancellation(err)) {
        if (options.throwOnError) throw err
        return
      }
      console.error('[ContactsStore] loadGroups error', err)
      if (options.throwOnError) throw err
    } finally {
      setLoadingGroups(false)
    }
  }, [user])

  // ── Load requests ──────────────────────────────────────────────────────────
  const loadRequests = useCallback(async (options: RevisionRefreshOptions = {}) => {
    if (!user) return
    const generation = ++requestsGenerationRef.current
    setRequestsStatus((previous) => previous === 'ready' ? 'ready' : 'loading')
    try {
      const [received, sent, invitations] = await Promise.all([
        contactsService.getReceivedRequests(user.id),
        contactsService.getSentRequests(user.id),
        listGroupInvitations(),
      ])
      if (generation !== requestsGenerationRef.current) return
      await (await getImRepository()).putIdentities(await readRequiredDisplayIdentities([...new Set([...received, ...sent].flatMap((request) => [request.sender_id, request.receiver_id]))]))
      if (generation !== requestsGenerationRef.current) return
      setReceivedRequests(received)
      setSentRequests(sent)
      setGroupInvitations(invitations)
      setRequestsStatus('ready')
      setRequestsError(null)
    } catch (err) {
      if (!isLifecycleCancellation(err) && generation === requestsGenerationRef.current) {
        rendererLogger('contacts/requests').error({ error: String(err) }, 'loading contact requests failed')
        setRequestsStatus('error')
        setRequestsError(err instanceof Error ? err.message : String(err))
      }
      if (options.throwOnError) throw err
    }
  }, [getImRepository, user])

  const groupChatsRef = useRef(groupChats)
  groupChatsRef.current = groupChats
  const loadGroupJoinRequests = useCallback(async (options: RevisionRefreshOptions = {}) => {
    if (!user) return
    const generation = ++groupJoinRequestsGenerationRef.current
    try {
      const rows = await listManagedGroupJoinRequests(managedGroupChats(groupChatsRef.current))
      if (generation !== groupJoinRequestsGenerationRef.current) return
      if (rows.length) await (await getImRepository()).putIdentities(await readRequiredDisplayIdentities(joinRequestIdentityIds(rows)))
      if (generation !== groupJoinRequestsGenerationRef.current) return
      setGroupJoinRequests(rows)
      setGroupJoinRequestsError(null)
    } catch (err) {
      if (!isLifecycleCancellation(err) && generation === groupJoinRequestsGenerationRef.current) {
        rendererLogger('contacts/group-join-requests').error({ error: String(err) }, 'loading group join requests failed')
        setGroupJoinRequestsError(err instanceof Error ? err.message : String(err))
      }
      if (options.throwOnError) throw err
    }
  }, [getImRepository, user])
  // 管理的群集合变了(新建群、被设为管理员、群解散)才重读;同一组群的其它字段变化不触发。
  const managedGroupKey = managedGroupChats(groupChats).map((group) => group.id).sort().join(',')
  useEffect(() => {
    if (user) void loadGroupJoinRequests()
  }, [user, managedGroupKey, loadGroupJoinRequests])
  const refreshAllRequests = useCallback(async () => {
    await Promise.all([loadRequests(), loadGroupJoinRequests()])
  }, [loadGroupJoinRequests, loadRequests])

  useEffect(() => {
    // 使用户切换或 shell 停用时仍在途的请求失效，避免旧账号的快照落入新账号状态。
    contactsLoadGenerationRef.current += 1
    requestsGenerationRef.current += 1
    groupJoinRequestsGenerationRef.current += 1
    if (user) {
      loadContacts()
      loadGroups()
      loadRequests()
    } else {
      setContacts([])
      setGroups([])
      setReceivedRequests([])
      setGroupInvitations([])
      setGroupJoinRequests([])
      setGroupJoinRequestsError(null)
      setRequestsStatus('idle')
      setRequestsError(null)
      setSentRequests([])
      // 上面刚把代际 +1,在途请求的 finally 已不会再清这个 flag —— 这里补清,否则登出/停用瞬间
      // 有请求在途就会永久留下 loadingContacts=true。
      setLoadingContacts(false)
      setContactsStatus('idle')
    }
  }, [user, loadContacts, loadGroups, loadRequests])

  // ── Durable account revision consumers ─────────────────────────────────────
  useEffect(() => {
    if (!user) return

    const strict = { throwOnError: true }
    // @@@chat-projection I7 — 会话列表只有一个属主(chat store 的投影)。本域从前在这几条
    // event 上**另跑一遍** `refreshChats()`,于是同一条通知有两条整表拉取路,派发还把它们串起来
    // (#5394 的 40 环有一段就是这么来的)。现在联系人域只刷**自己拥有**的那几个面,
    // 会话列表交给投影;`chats` 照旧从 chat store 的 context 读。
    // 入群申请也走这一条(gugu-supabase 给群主、管理员和发起人发 friend_requests_changed):同一个「新的请求」收件箱。
    const handleRequestChange = () => Promise.all([
      loadContacts(strict),
      loadRequests(strict),
      loadGroupJoinRequests(strict),
    ]).then(() => undefined)

    const refreshFriendshipSurfaces = () => Promise.all([
      loadContacts(strict),
      loadGroups(strict),
      loadRequests(strict),
    ]).then(() => undefined)

    // @@@owned-agents-realtime (#671) - reload the owned-agent list when an agent is created/changed,
    // including from another device. 那条新 agent 私聊由投影按键补齐,不再靠整表重拉。
    const refreshAgentSurfaces = () => loadContacts(strict)
    // #6091 会话页「重命名 Agent」改名落在主进程 / 宿主(不经过这里的 updateAgentProfile),通讯录缓存着
    // display_name —— 收到广播就按 agent_changed 同一条路重拉,❌ 挂着旧名等 realtime 兜底。
    const handleOwnedAgentRenamed = () => { void refreshAgentSurfaces() }
    window.addEventListener(UI_EVENTS.ownedAgentRenamed, handleOwnedAgentRenamed)
    const unsubscribes = [
      subscribeAccountRevision('friend_requests_changed', handleRequestChange),
      subscribeAccountRevision('group_invitations_changed', () => loadRequests(strict)),
      subscribeAccountRevision('friendship_changed', refreshFriendshipSurfaces),
      subscribeAccountRevision('agent_changed', () => {
        // #6396 另一台设备可能刚用掉一个号 ⇒ 本机会话页下一条会话起名前先跟上。
        platform.notifyOwnedAgentsChanged?.()
        return refreshAgentSurfaces()
      }),
    ]

    return () => {
      window.removeEventListener(UI_EVENTS.ownedAgentRenamed, handleOwnedAgentRenamed)
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [user, loadContacts, loadGroups, loadRequests, loadGroupJoinRequests, subscribeAccountRevision])

  // ── Actions ────────────────────────────────────────────────────────────────
  const searchUsers = useCallback(
    async (query: string) => {
      if (!user) return
      setIsSearching(true)
      try {
        const results = await contactsService.searchUsers(query, user.id)
        await (await getImRepository()).putIdentities(results)
        setSearchResults(results.map(({ id, alias, agent_type, project_path }) => ({ id, alias, agent_type, project_path })))
      } catch (err) {
        console.error('[ContactsStore] searchUsers error', err)
        setSearchResults([])
        throw err
      } finally {
        setIsSearching(false)
      }
    },
    [getImRepository, user],
  )

  const clearSearch = useCallback(() => {
    setSearchResults([])
  }, [])

  const sendRequest = useCallback(
    async (targetUserId: string, message?: string | null) => {
      if (!user) return
      await contactsService.sendRequest(user.id, targetUserId, message)
      await loadRequests()
    },
    [user, loadRequests],
  )

  const acceptRequest = useCallback(
    async (requestId: string) => {
      const result = await contactsService.acceptRequest(requestId)
      await Promise.all([
        loadContacts(),
        loadRequests(),
        // 接受好友请求只会**多**一段关系:它不携带任何「你失去了某条会话」的消息,不撤销当前选中 (#4314)。
        refreshChats({ acceptEmpty: true }),
      ])
      return result
    },
    [loadContacts, loadRequests, refreshChats],
  )

  const rejectRequest = useCallback(
    async (requestId: string) => {
      await contactsService.rejectRequest(requestId)
      await loadRequests()
    },
    [loadRequests],
  )

  const createGroup = useCallback(
    async (name: string) => {
      if (!user) return null
      const group = await contactsService.createContactGroup(user.id, name)
      setGroups((current) => [...current, group])
      return group.id
    },
    [user],
  )

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    await contactsService.renameContactGroup(groupId, name)
    setGroups((current) => current.map((group) => (
      group.id === groupId
        ? { ...group, name: name.trim(), updated_at: new Date().toISOString() }
        : group
    )))
  }, [])

  const deleteGroup = useCallback(async (groupId: string) => {
    await contactsService.deleteContactGroup(groupId)
    setGroups((current) => current.filter((group) => group.id !== groupId))
  }, [])

  const updateGroupMembers = useCallback(async (groupId: string, contactIds: string[]) => {
    await contactsService.updateContactGroupMembers(groupId, contactIds)
    setGroups((current) => current.map((group) => (
      group.id === groupId
        ? { ...group, contactIds: [...new Set(contactIds)], updated_at: new Date().toISOString() }
        : group
    )))
  }, [])

  const updateContactAlias = useCallback(
    async (contactId: string, alias: string) => {
      if (!user) return
      const nextAlias = alias.trim() || null
      await contactsService.updateContactAlias(user.id, contactId, alias)
      setContacts((current) => current.map((contact) => (
        contact.id === contactId ? { ...contact, alias: nextAlias } : contact
      )))
      await refreshChats()
    },
    [user, refreshChats],
  )

  const setAgentPublic = useCallback(async (agentId: string, agentPublic: boolean) => {
    const updated = await contactsService.setAgentPublic(agentId, agentPublic)
    await (await getImRepository()).putIdentities([updated])
  }, [getImRepository])

  const setAgentDesiredStatus = useCallback(async (agentId: string, desiredStatus: 'online' | 'offline') => {
    const updated = await contactsService.setAgentDesiredStatus(agentId, desiredStatus)
    await (await getImRepository()).putIdentities([updated])
  }, [getImRepository])

  const applyAgentProfileUpdate = useCallback(async (updated: ContactUser) => (await getImRepository()).putIdentities([updated]), [getImRepository])

  // #1228: update an owned agent's name + bio together (真接 bio — was dropped before).
  const updateAgentProfile = useCallback(async (agentId: string, fields: { name?: string; bio?: string; avatar?: string | null }) => {
    const updated = await contactsService.updateOwnedAgentProfile(agentId, {
      ...(fields.name !== undefined ? { display_name: fields.name } : {}),
      ...(fields.bio !== undefined ? { bio: fields.bio } : {}),
      ...(fields.avatar !== undefined ? { avatar: fields.avatar } : {}),
    })
    await applyAgentProfileUpdate(updated)
    // @@@share-card-rename 云端 identity.users.display_name 是所有显示面的真源。本机花名册仍同步运行时
    // 所需的 agent 元数据，但会话页分享/身份卡按 agentUserId 回读云端名字，不从这格渲染。
    // 只在名字真的改了时才动本机(改 bio / 头像不该碰花名册)。
    if (fields.name !== undefined) await platform.renameOwnedAgentLocalFootprint?.(agentId, updated.display_name)
    await refreshChats()
  }, [applyAgentProfileUpdate, refreshChats])

  // Every name entry uses the profile path, including its canonical identity and local roster publication.
  const renameAgent = useCallback(async (agentId: string, name: string) => {
    await updateAgentProfile(agentId, { name })
  }, [updateAgentProfile])

  const uploadAgentAvatar = useCallback(async (agentId: string, file: File, profile?: { name?: string; bio?: string }) => {
    const updated = await contactsService.uploadOwnedAgentAvatar(agentId, file, {
      ...(profile?.name !== undefined ? { display_name: profile.name } : {}),
      ...(profile?.bio !== undefined ? { bio: profile.bio } : {}),
    })
    await applyAgentProfileUpdate(updated)
    // 换头像这条路同样能带着新名字过来(资料页有待上传头像时走的就是它)——运行时元数据一视同仁。
    if (profile?.name !== undefined) await platform.renameOwnedAgentLocalFootprint?.(agentId, updated.display_name)
    await refreshChats()
  }, [applyAgentProfileUpdate, refreshChats])

  const setAgentLook = useCallback(async (agentId: string, look: AgentLook) => {
    await updateAgentProfile(agentId, { avatar: contactsService.agentLookAvatarUrl(look) })
  }, [updateAgentProfile])

  // @@@agent-look-birth 主人名下还没有形象的 agent(刚出生的,或形象上线前就有的)→ 定一个形象存进库:
  // 能保留它一直以来按 id 推出来的样子就保留,颜色被兄弟占了才换成没人用的(look.ts planBirthLooks)。
  // 写只在头像仍为空时生效(claimAgentLook):主人的几台设备同时在线也只有一台定得下来,其余等 agent_changed 带过来。
  // 一只 agent 在这一次登录里只试一次:失败就留着按 id 推的样子,❌ 反复重试刷库。
  const lookClaimsRef = useRef(new Set<string>())
  // 读通讯录(云端按主人现查的自家 agent 名单),❌ 身份缓存:缓存只增不删,删掉的 agent 会一直留在里面,
  // 既白发写请求,又占着颜色,让新 agent 和活着的兄弟撞色。刚开户的 agent 等通讯录刷新进来再定。
  const ownedAgents = useMemo(
    () => (user
      ? contacts.flatMap((relation) => {
          const identity = identitiesById[relation.id]
          return identity && identity.type === 'agent' && identity.owner_user_id === user.id ? [identity] : []
        })
      : []),
    [contacts, identitiesById, user],
  )
  const looklessOwnedAgents = ownedAgents
    .filter((agent) => agent.avatar == null && !lookClaimsRef.current.has(agent.id))
    .map((agent) => agent.id)
    .join(',')
  useEffect(() => {
    if (!looklessOwnedAgents || contactsStatus !== 'ready') return
    const plan = planBirthLooks(
      ownedAgents.map(({ id, avatar, created_at }) => ({ id, avatar, created_at })),
      Math.random,
    ).filter(({ id }) => !lookClaimsRef.current.has(id))
    for (const { id } of plan) lookClaimsRef.current.add(id)
    void (async () => {
      for (const { id, look } of plan) {
        try {
          const updated = await contactsService.claimAgentLook(id, look)
          if (updated) await applyAgentProfileUpdate(updated)
        } catch (err) {
          rendererLogger('contacts/agent-look').warn({ agentId: id, error: String(err) }, 'storing a newborn agent look failed')
        }
      }
    })()
    // ownedAgents 每次渲染都是新数组;真正决定要不要再定一轮的是「还有谁没形象」这串 id。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looklessOwnedAgents, contactsStatus, applyAgentProfileUpdate])

  /** 删掉一个联系人 / 自家 agent 之后(云端已确认):本地先拿掉它,再按权威数据重读。 */
  const dropContactAndReload = useCallback(
    async (contactId: string) => {
      setContacts((current) => current.filter((contact) => contact.id !== contactId))
      setGroups((current) => current.map((group) => ({
        ...group,
        contactIds: group.contactIds.filter((id) => id !== contactId),
      })))
      await Promise.all([
        loadContacts(),
        loadGroups(),
        loadRequests(),
        refreshChats({ acceptEmpty: true, preserveMissingActive: false }),
      ])
    },
    [loadContacts, loadGroups, loadRequests, refreshChats],
  )

  const removeContact = useCallback(
    async (contactId: string) => {
      await contactsService.removeContact(contactId)
      await dropContactAndReload(contactId)
    },
    [dropContactAndReload],
  )

  const removeOwnedAgent = useCallback(
    async (agentId: string) => {
      await contactsService.removeOwnedAgent(agentId)
      // @@@4526 删除有两半,云端与本机。上面那行只做了云端那半:它删掉 identity.users 的身份、归档 DM、
      // 清 chat 成员与云端 runtime state。本机那半——花名册记录、runtime session/activity、投递注册——
      // 在此之前**没有任何一条路**会碰它(唯一的清理驱动是会话页那边会话消失时的 reaper,方向相反)。
      // 于是删完之后花名册仍留着它,而会话页 provisioning 的幂等键正是花名册上那条 conversation 绑定:
      // 切到会话页再切回来,它按"这条会话还没供给过"重新开户,被删掉的联系人带着 Online 又回到列表里。
      //
      // ❌ 不 catch。本机足迹没释放干净还让下面的 toast 说「Agent deleted」,就是这张票的形状本身。
      await platform.releaseOwnedAgentLocalFootprint?.(agentId)
      // 删除已确认成功后:
      //  · 通讯录:立即移除；权威 getContacts 也不再枚举 tombstone；
      //  · 会话列表:直接走 chat store 既有 API 乐观移除(removeAgentFromChatList);
      //  · 已打开的群成员抽屉(ChatAreaPanel 组件态、外部够不到):广播事件由其自身监听即时收敛。
      // RPC 抛错则走不到这里 → 不会误移除(fail loud)。
      removeAgentFromChatList(agentId, chatListRemovalRef.current)
      window.dispatchEvent(new CustomEvent(UI_EVENTS.ownedAgentRemoved, { detail: { agentUserId: agentId } }))
      await dropContactAndReload(agentId)
    },
    [dropContactAndReload],
  )

  const getCommonGroupChats = useCallback(
    async (contactId: string) => {
      if (!user) return []
      return contactsService.getCommonGroupChats(user.id, contactId)
    },
    [user],
  )

  // 值只在它自己的输入变了时才换:从前每次渲染新建一份(连同按身份投影的几百个联系人),每个读通讯录的组件跟着重渲染。
  const value = useMemo(() => {
    recordContactsRender()
    const requireIdentity = (id: string) => { const identity = identitiesById[id]; if (!identity) throw new Error(`Missing committed identity ${id}`); return identity }
    const project = (rows: ContactRelation[]) => rows.map((relation) => ({ ...requireIdentity(relation.id), ...relation }))
    const withPeers = (rows: FriendRequest[]) => rows.map((request) => ({ ...request, sender: identitiesById[request.sender_id], receiver: identitiesById[request.receiver_id] }))
    return {
      contacts: project(contacts),
      sharedGroupAgents,
      groups,
      groupChats,
      friendRequests: friendRequestEntries(withPeers(receivedRequests), withPeers(sentRequests)),
      groupInvitations,
      groupJoinRequests,
      groupJoinRequestsError,
      pendingRequestCount: [...receivedRequests, ...groupInvitations, ...groupJoinRequests].filter((request) => request.status === 'pending').length,
      requestsStatus,
      requestsError,
      sentRequests: withPeers(sentRequests.filter((request) => request.status === 'pending')),
      loadingContacts,
      loadingGroups,
      contactsStatus,
      groupChatsStatus,
      searchResults: project(searchResults),
      isSearching,
      searchUsers,
      clearSearch,
      sendRequest,
      acceptRequest,
      rejectRequest,
      refreshContacts: loadContacts,
      refreshGroups: loadGroups,
      refreshRequests: refreshAllRequests,
      refreshGroupJoinRequests: loadGroupJoinRequests,
      createGroup,
      renameGroup,
      deleteGroup,
      updateGroupMembers,
      updateContactAlias,
      setAgentPublic,
      setAgentDesiredStatus,
      renameAgent,
      updateAgentProfile,
      uploadAgentAvatar,
      setAgentLook,
      removeOwnedAgent,
      removeContact,
      getCommonGroupChats,
    }
  }, [
    contacts, searchResults, identitiesById, sharedGroupAgents, groups, groupChats, receivedRequests, sentRequests,
    groupInvitations, groupJoinRequests, groupJoinRequestsError, requestsStatus, requestsError, loadingContacts,
    loadingGroups, contactsStatus, groupChatsStatus, isSearching, searchUsers, clearSearch, sendRequest, acceptRequest,
    rejectRequest, loadContacts, loadGroups, refreshAllRequests, loadGroupJoinRequests, createGroup, renameGroup,
    deleteGroup, updateGroupMembers, updateContactAlias, setAgentPublic, setAgentDesiredStatus, renameAgent,
    updateAgentProfile, uploadAgentAvatar, setAgentLook, removeOwnedAgent, removeContact, getCommonGroupChats,
  ])
  return <ContactsContext.Provider value={value}>{children}</ContactsContext.Provider>
}
