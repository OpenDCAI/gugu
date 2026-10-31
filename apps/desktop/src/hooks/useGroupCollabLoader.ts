import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { chatService, GroupCollabEmptyError } from '../lib/chat'
import { withTimeout } from '../lib/withTimeout'
import {
  readGroupRoster,
  persistableGroupRoster,
  replaceGroupRoster,
  type AccountImRepository,
} from '../lib/imRepository'
import { i18n } from '@/i18n'
import { rendererLogger } from '../lib/log'
import { UI_EVENTS } from '../lib/uiEvents'
import { reconcileGroupCollabSnapshot } from '../lib/groupCollabSnapshot'

const groupCollabLog = rendererLogger('chat/group-collab')

export const EMPTY_GROUP_COLLAB: GroupCollabSnapshot = {
  scheduler: {
    chat_id: '',
    paused: false,
    queue_count: 0,
    blocked_count: 0,
    summary: null,
    updated_at: new Date(0).toISOString(),
  },
  humans: [],
  agents: [],
  tasks: [],
  outputs: [],
}

// Outer bound for one getGroupCollab read; the happy path is <500ms.
const GROUP_COLLAB_LOAD_TIMEOUT_MS = 9000

export interface UseGroupCollabLoaderParams {
  activeChatId: string | null | undefined
  /** @@@5856 群**和话题**都有自己的 chat_members —— 这里问的是「是不是场所型会话」,不是「是不是群」。 */
  isRoomChat: boolean
  /** @@@5856 群还是话题:名册 0 行在话题里是结论(还不是参与者),在群里只能是故障。 */
  chatKind?: string | null
  userId: string | null | undefined
  getImRepository: () => Promise<AccountImRepository>
  setGroupCollabSnapshot: Dispatch<SetStateAction<GroupCollabSnapshot>>
  // Account-scoped cached first frame; canonical reload owns the effective member set.
  groupRosterMemoryCacheRef: MutableRefObject<Map<string, GroupCollabSnapshot>>
}

export interface UseGroupCollabLoaderResult {
  error: 'not-participant' | 'failed' | null
  /** 权威加载群协作快照:先铺 cached roster(SWR)、再用 getGroupCollab 合并;读失败留着缓存的那份并报错。 */
  loadGroupCollab: () => Promise<void>
  /** 切会话时调:invalidate 在途加载、按 in-memory cache 重铺首帧。 */
  resetGroupCollabForChat: () => void
}

// 把 ChatAreaPanel 的群协作加载子系统(SWR 首帧 + 权威加载)整体抽出。
// 读失败不再三层重试(从前那一层层是为了让已作废的 e2e console 守卫不红,#2012 / #4847):这一次没刷新到就
// 照实报错、界面留着缓存的名册,下一条成员 / 修订事件(ChatAreaPanel 订着)再读。
// ChatAreaPanel 是冻结 god 文件 → 抽 hook 既抵消行数增长,又把这块内聚逻辑从巨组件里解出来。
export function useGroupCollabLoader(params: UseGroupCollabLoaderParams): UseGroupCollabLoaderResult {
  const {
    activeChatId,
    isRoomChat,
    chatKind,
    userId,
    getImRepository,
    setGroupCollabSnapshot,
    groupRosterMemoryCacheRef,
  } = params

  const groupCollabLoadSeqRef = useRef(0)
  const [failure, setFailure] = useState<{ chatId: string; reason: Exclude<UseGroupCollabLoaderResult['error'], null> } | null>(null)
  // The provider owns the repository; this hook only clears its account-specific view projection.
  useEffect(() => () => {
    groupRosterMemoryCacheRef.current.clear()
  }, [userId, groupRosterMemoryCacheRef])

  const loadGroupCollab = useCallback(async () => {
    const seq = ++groupCollabLoadSeqRef.current
    if (!activeChatId || !isRoomChat) {
      setGroupCollabSnapshot(EMPTY_GROUP_COLLAB)
      setFailure(null)
      return
    }
    // Repository corruption is not a cloud transient: report it and do not fetch/retry around it.
    let repository: AccountImRepository
    try {
      repository = await getImRepository()
      if (seq === groupCollabLoadSeqRef.current) {
        const cachedRoster = readGroupRoster(repository, activeChatId)
        if (cachedRoster && !groupRosterMemoryCacheRef.current.has(activeChatId)) {
          groupRosterMemoryCacheRef.current.set(activeChatId, cachedRoster)
          setGroupCollabSnapshot(cachedRoster)
        }
      }
    } catch (err) {
      groupCollabLog.error({ error: err }, 'IM repository load failed')
      if (seq === groupCollabLoadSeqRef.current) setFailure({ chatId: activeChatId, reason: 'failed' })
      return
    }
    try {
      const { snapshot, identities } = await withTimeout(
        chatService.getGroupCollab(activeChatId),
        GROUP_COLLAB_LOAD_TIMEOUT_MS,
        i18n.t('group.collab.loadTimeout', { ns: 'messaging' }),
      )
      if (seq !== groupCollabLoadSeqRef.current) return
      setFailure(null)
      groupRosterMemoryCacheRef.current.set(activeChatId, snapshot)
      // 身份先落库、名册后发布:名册一发布,@ 名册就按 identitiesById 判「有没有名字」(mention.ts),身份晚几帧到
      // = 这几帧里新成员 @ 不到。本地写失败只记日志、名册照发 —— 内存里的快照不依赖本地库(#5610)。
      // 写完不再复查 seq:这份权威名册已经过了上面那道守卫,后来的加载自己会发布更新的一份(merge 是 reconcile),
      // 而在这里丢掉它会让「后一次加载失败」时停在更旧的快照上。
      await replaceGroupRoster(repository, activeChatId, persistableGroupRoster(activeChatId, snapshot, identities), identities)
        .catch((err) => console.error('[ChatAreaPanel] write group roster repository failed', err))
      // Effective membership comes from the backend projection, including removals; preserve survivor order.
      setGroupCollabSnapshot((prev) => reconcileGroupCollabSnapshot(prev, snapshot))
    } catch (err) {
      if (seq !== groupCollabLoadSeqRef.current) return
      // @@@5856 找茵第九轮:「看得见但还不是参与者」是结论,不是故障 —— 不报错。
      // (成员面板那一路已经把它画成「在里面说一句就进来了」。)
      if (err instanceof GroupCollabEmptyError && chatKind === 'topic') {
        setFailure({ chatId: activeChatId, reason: 'not-participant' })
        groupCollabLog.info({ chatId: activeChatId }, 'group collab empty roster (visible but not a participant)')
        return
      }
      groupCollabLog.error({ chatId: activeChatId, error: err }, 'group collab load failed; keeping the cached roster')
      setFailure({ chatId: activeChatId, reason: 'failed' })
    }
  }, [activeChatId, isRoomChat, chatKind, getImRepository, setGroupCollabSnapshot, groupRosterMemoryCacheRef])

  const resetGroupCollabForChat = useCallback(() => {
    // @@@group-collab-swr (#949←#N3/1d93d7a) - invalidate any in-flight load for the PREVIOUS chat before
    // re-seeding: without this bump a late getGroupCollab return from chat A (captured seq still == current)
    // would pass loadGroupCollab's seq guard and reconcile A's members into chat B's freshly-seeded snapshot.
    // Bumping seq makes that stale load early-return.
    groupCollabLoadSeqRef.current += 1
    setFailure(null)
    // @@@local-sync (#948) - seed first-frame from the in-memory roster cache so avatars/members don't flash empty before getGroupCollab resolves; authoritative load replaces it.
    const cachedRoster = activeChatId && isRoomChat ? groupRosterMemoryCacheRef.current.get(activeChatId) : null
    setGroupCollabSnapshot(cachedRoster ?? EMPTY_GROUP_COLLAB)
  }, [activeChatId, isRoomChat, groupRosterMemoryCacheRef, setGroupCollabSnapshot])

  useEffect(() => {
    const invalidate = (event: Event) => {
      if (!activeChatId || !isRoomChat) return
      const id = (event as CustomEvent<{ id: string | null }>).detail.id
      const cached = groupRosterMemoryCacheRef.current.get(activeChatId)
      if (id !== null && ![...(cached?.humans ?? []), ...(cached?.agents ?? [])].some(member => member.id === id)) return
      groupRosterMemoryCacheRef.current.delete(activeChatId)
      void loadGroupCollab()
    }
    window.addEventListener(UI_EVENTS.identityInvalidated, invalidate)
    return () => window.removeEventListener(UI_EVENTS.identityInvalidated, invalidate)
  }, [activeChatId, isRoomChat, groupRosterMemoryCacheRef, loadGroupCollab])

  return { loadGroupCollab, resetGroupCollabForChat, error: failure && failure.chatId === activeChatId ? failure.reason : null }
}
