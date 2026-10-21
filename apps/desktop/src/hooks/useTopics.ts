// @@@5856 一条线上长出来的话题清单 —— product spec。
//
// 只有一个数据源:topicService.listTopicsOfChat。锚点卡(挂在来源消息底下)和顶栏话题面板
// 共用这一份,❌ 不许各拉各的 —— 两份就会出现「锚点卡说 3 条、面板说 2 条」。
//
// 可见继承来源、参与靠说话:这个 hook 只负责把服务端算好的 is_participant 端上来,
// ❌ 不在客户端二次判断谁看得见谁被通知(那归 RLS 与数据库触发器,客户端再判一遍就是第二个属主)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { topicService } from '../lib/topics'
import { rendererLogger } from '../lib/log'
import { useAuth } from '../store/auth'

const topicsLog = rendererLogger('chat/topics')

const EMPTY_TOPICS: TopicSummary[] = []
// 按「账号:线」记住上一次拉到的清单:切回看过的线时,锚点卡与消息同一帧出现 —— 否则每次打开都晚一拍、
// 卡片冒出来把上方的消息往上顶(#6519 首帧预览把这一拍露了出来)。照旧每次重拉对账,缓存只当首帧的先验;
// 键带用户 id,换账号不串;拉取失败就删掉这一格(fail loud 不变)。
const lastTopics = new Map<string, TopicSummary[]>()

export interface UseTopicsOfChatResult {
  topics: TopicSummary[]
  /** 锚点卡按来源消息分组:一条来源消息可能长出多条话题,所以值是数组而非单条。 */
  bySourceMessageId: Map<string, TopicSummary[]>
  loading: boolean
  error: string | null
  /** 开完一条话题后调它,让来源消息底下的锚点卡当场长出来。 */
  reload: () => void
}

/**
 * 单层不嵌套的守卫做成一个纯函数,而不是藏在 hook 里 —— hook 只拿得到一个 id,判断不出
 * 这条会话是不是话题本身。调用点 `useTopicsOfChat(topicsSourceChatId(activeChat))` 即可:
 * 话题上不再开话题(product spec「必须有来源」),所以话题会话直接给 null、不发请求。
 */
export function topicsSourceChatId(chat: Pick<ChatItem, 'id' | 'kind'> | null | undefined): string | null {
  if (!chat) return null
  if (chat.kind === 'topic') return null
  return chat.id
}

// @@@3922 这一族的形状:hook 收一个主体参数,但状态只能在**副作用**里追上它,而副作用落在绘制之后
// ⇒ 切换那一帧,上一条线的话题会被消费方盖上「当前这条线」的身份,锚点卡挂到别人的消息底下。
// 解法是把读数和它描述的主体存在一起(subject-scoped),主体不符时当场交出「还不知道」——
// 在渲染期收口,而不是在副作用里补一刀。
type TopicsState = {
  /** 这份读数是关于哪条线的。与当前入参不符 ⇒ 它不是「当前线的答案」,一律当没有。 */
  forChatId: string | null
  topics: TopicSummary[]
  loading: boolean
  error: string | null
}

const IDLE: TopicsState = { forChatId: null, topics: EMPTY_TOPICS, loading: false, error: null }

/**
 * @param subscribeChatChanged 订阅 chat_changed。别人在这条线上开了话题时,服务端会给来源线的
 *   每个成员发一条 chat_changed(迁移 20260918223500),这里听到就重拉 —— 否则对端要重开这条线
 *   才看得见新话题,而老的 thread 面板本来是有这条实时的(#1588),换成话题不能反而丢掉。
 */
export function useTopicsOfChat(
  sourceChatId: string | null,
  subscribeChatChanged?: (listener: (chatIds: readonly string[]) => void) => () => void,
): UseTopicsOfChatResult {
  const [state, setState] = useState<TopicsState>(IDLE)
  const [reloadToken, setReloadToken] = useState(0)
  const userId = useAuth().user?.id ?? null
  const cacheKey = userId && sourceChatId ? `${userId}:${sourceChatId}` : null
  // 竞态守卫:切会话/重载各自 +1。晚到的旧响应 seq 对不上就整个丢弃 ——
  // 没有它,A 线的慢响应会落进已经切到 B 线的状态里,锚点卡挂到别人的消息底下(#5856 同形状于 #949)。
  const loadSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++loadSeqRef.current
    if (!sourceChatId) {
      setState(IDLE)
      return
    }
    setState((current) => ({
      forChatId: sourceChatId,
      topics: current.forChatId === sourceChatId ? current.topics : (cacheKey && lastTopics.get(cacheKey)) || EMPTY_TOPICS,
      loading: true,
      error: null,
    }))
    let cancelled = false
    void (async () => {
      try {
        const rows = await topicService.listTopicsOfChat(sourceChatId)
        if (cancelled || seq !== loadSeqRef.current) return
        if (cacheKey) lastTopics.set(cacheKey, rows)
        setState({ forChatId: sourceChatId, topics: rows, loading: false, error: null })
      } catch (err) {
        if (cancelled || seq !== loadSeqRef.current) return
        // fail loud:话题列不出来就说列不出来,❌ 不许静默当成「这条线上没有话题」——
        // 那会让来源消息底下的锚点卡凭空消失,用户以为话题被删了。
        topicsLog.error({ error: err, sourceChatId }, 'list topics of chat failed')
        if (cacheKey) lastTopics.delete(cacheKey)
        setState({ forChatId: sourceChatId, topics: EMPTY_TOPICS, loading: false, error: (err as Error)?.message ?? String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sourceChatId, reloadToken, cacheKey])

  // 渲染期收口:state 描述的不是当前这条线 ⇒ 当前这条线「还不知道」。切线的那一帧就不会
  // 把上一条线的话题端出去(副作用要到绘制之后才跑,靠它清空永远慢一帧)。
  const scoped: TopicsState = state.forChatId === sourceChatId
    ? state
    : { forChatId: sourceChatId, topics: (cacheKey && lastTopics.get(cacheKey)) || EMPTY_TOPICS, loading: sourceChatId !== null, error: null }

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    if (!sourceChatId || !subscribeChatChanged) return
    return subscribeChatChanged((chatIds) => {
      // 只认「我正看的这条线」的事件 —— 别的线上开话题与这份清单无关,重拉就是白跑一次往返。
      if (chatIds.includes(sourceChatId)) reload()
    })
  }, [sourceChatId, subscribeChatChanged, reload])

  const bySourceMessageId = useMemo(() => {
    const index = new Map<string, TopicSummary[]>()
    for (const topic of scoped.topics) {
      const bucket = index.get(topic.source_message_id)
      if (bucket) bucket.push(topic)
      else index.set(topic.source_message_id, [topic])
    }
    return index
  }, [scoped.topics])

  return { topics: scoped.topics, bySourceMessageId, loading: scoped.loading, error: scoped.error, reload }
}
