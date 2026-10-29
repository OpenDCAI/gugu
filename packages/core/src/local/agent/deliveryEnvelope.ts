import { storedMessageLink } from '../../shared/ui/guguLink'
import { encodeTypedId } from '../../shared/typedId.mjs'
import { findMentionSpans } from '../../shared/mentionToken.mjs'
import type { ChatKind, ListenMode } from '../../shared/types/chat'
import { describeReactions } from '../../shared/ui/reactionCatalog'

/**
 * 进入任何 agent prompt 的每一条消息，字节都从这里出来（#4280）。
 *
 * 在这之前壳有两个属主：core 的 `<gugu_delivery>`（chat / local-direct）与会话页自己拼的
 * `[gugu_session session-direct]` + `origin=<JSON>`。两个属主的直接后果是**格子会按渠道漂移** ——
 * 漂掉的那一格恰好是 `arrival`（回路提示），于是 agent→agent 的会话直发从来没被告知「你打印的
 * 到不了发信人那儿、要回就用 session_message」。owner 2026-08-26 定性：这不是少写一句话，是
 * 消息壳不统一。
 *
 * ⇒ 本模块的分层就是那条不变量：
 *   - `renderDeliveryEnvelope` 是**唯一** producer，它拥有形状与格子清单；新渠道进不来一个「少一格」的壳。
 *   - 每条渠道只有一个 adapter，负责把自己的现场事实翻译成同一份 facts（取值可以按渠道不同，
 *     格子在不在不归 adapter 管）。
 *
 * ❌ 别再在别处拼 `<gugu_delivery …>` 或另造第二种头部：那正是本票要修掉的东西。
 */

/**
 * 来路 = 回程。取值直接标记这条渠道要用的回程工具，agent 不必再做一次映射。
 *
 */
export type DeliveryRouteKind = GuguRoutedKind

/**
 * 经咕咕送达的渠道（#4562 收敛：local-direct 并入 session-direct）：它们都有一个咕咕发信人、一条稳定来源消息。
 * `extension`（#6387）：发信方是这台电脑上装的一个 tab 扩展，把用户在它界面里的交互转成消息 ——
 * 它**没有回程工具**：人正看着这条会话，agent 打印的就是回答。
 * `system`（#6593）：咕咕自己告诉这条会话的一件事（比如主人改了这个 agent 的名字）—— 不挂任何聊天，
 * 也**没有要回的人**。
 * `scheduled`（#7221）：这个 agent 自己排的「已安排」到点了，咕咕把它当初那句交代原样送回来 —— 是一件要做的事，
 * 不是通知；也没有发信人可回，要找人就照交代里写的去处发。
 * `forum`：论坛里一个帖子上的事(这个 agent 被指派到帖子上、楼主或主人后来的交代、悬赏结算):回程是 `forum_reply`,
 * 发在那个帖子里,❌ 进任何聊天。它在目录里(catalog_call),不原生列出:论坛的投递少,原生列出要每个会话都付它的字节(#7335)。
 */
export type GuguRoutedKind = 'chat' | 'session-direct' | 'extension' | 'system' | 'scheduled' | 'forum'

/** 每条渠道**真实存在**的回程工具名（#4191 原子工具面）；扩展、咕咕系统、到点的已安排那几条没有。 */
const RETURN_TOOL_BY_ROUTE: Record<Exclude<GuguRoutedKind, 'extension' | 'system' | 'scheduled' | 'forum'>, string> = {
  chat: 'message_send',
  'session-direct': 'session_message',
}

/**
 * 当面轮的来路提示。语义与上面三条**相反**：这一轮不是送来的，是人当面敲的；他正看着这条会话，
 * 你打印的东西就是回答，没有回程工具可用。
 *
 * 措辞逐字保留 #3577 实测过的那三句事实（来源 / 谁在读你的输出 / 它不来自咕咕会话）——那次实测证明
 * 只靠 L1/L2 的会话级纪律不够，必须在**这一轮**旁边说一次。换的只有载体：从裸文本换成本模块的信封。
 */
/**
 * A（owner 设计的两件套之一）：**贴着这一轮**的来路提示 —— 这条是经咕咕送达的，不是有人当面
 * 往这个会话里打字；要回就用本渠道的回程工具。B 是系统提示词里那条纪律
 * (`<gugu_transport>`: answer on the channel the turn arrived on)。
 *
 * 为什么必须**每一轮**都说一次，而不是只在 L1/L2 说：实测(2026-08-25, Haiku 4.5, 真机)
 * L1+L2 两层都完整送达、gugu 工具也在手上，agent 收到 `route="chat"` 的信封后仍然只在终端里
 * 作答。会话级的纪律离决策点太远；`route` 是机器属性，不构成人读的提醒。
 * ⇒ 这一句是本设计里唯一与「这一轮」同处一地的提示。
 *
 * 为什么它按渠道取值(#4280)：以前一个常量同时服务两条路，于是 chat 的信封里挂着一句
 * 「(local-direct deliveries: message_send_local)」——对一条 chat 投递那是噪音。收敛属主之后
 * 每条渠道只被告知自己那条回路；**这不是精简，是那句括号在统一之后失去了存在理由**。
 *
 * ⚠️ 措辞必须对**每一种会话形态**都为真：会话页上人可能正盯着面板，所以 ❌「没人在看」；
 * 恒真的是「你打印的到不了发信人那儿」。#3578 拆掉上一版纪律正是因为它在某些 surface 上为假。
 *
 * ⚠️ 它点了工具名，与「信封只带现场事实、不复述工具」的洁癖冲突 —— 那是 #3802 那一轮自己加的
 * 棘轮，owner 的 A+B 设计明确要求 A 带上「用什么工具回」。实测优先于洁癖。
 */
export function arrivalHint(route: DeliveryRouteKind, mode: DeliveryMode | null = null): string {
  // #7199 咕咕自己交给这条会话去做的一件事(助理开通后的初始化):与通知相反,它**是**要做的事 —— 照做;
  // 没有人可回,结果按任务里写的去处发(与下面 #7221 的「到点」同一种回程)。
  if (route === 'system' && mode === 'task') {
    return "A task 咕咕 itself hands you, not a person's message: do what it says. What you print here reaches no one — send results with message_send to where the task says."
  }
  // #6593 咕咕自己发给这条会话的通知:不挂聊天,也就没有回程工具可写 —— 与下面 #6562 的通知同一句开头。
  if (route === 'system') return 'A 咕咕 system notice, not a request; there is no one to reply to.'
  // #7221 自己排的交代到点了:要做,但没有发信人可回 —— 结果按交代里写的去处发(多半是 message_send 回那条聊天)。
  if (route === 'scheduled') {
    return 'Your own schedule, due now and brought back by 咕咕: do what it says. What you print here reaches no one — send results with message_send to where the task says.'
  }
  // #6387 App 送来的不是「别人发给你的消息」:这台电脑上的一个 App 替这个人说的(人点的、后台页的钟、它的工具),
  // App 没有收件箱,所以回程就是当面打印。这句要对任何会话形态为真。
  // 集体记忆对账第 12 条:原先还有「附带」一档(mode 'context'),两个产出方(extension-agents / extension-send)早就只传
  // 一种语义,F16 定了没有 mode:'context' ⇒ 那一档和它的类型、投递卡上那一支一起删了。
  if (route === 'extension') return "Sent through 咕咕 by an App on this computer, on the person's behalf; the person reads what you print here."
  // 论坛:回程在目录里 —— 这一句把怎么调写全,不必先查。
  if (route === 'forum') {
    return 'Sent to you through 咕咕 from a forum post; what you print here does not reach it — reply with catalog_call { tool: "forum_reply", args: { post_id, text, reply_to? } } (forum_read the same way reads the whole post).'
  }
  // #6562 系统通知没有发信人可回:它告诉你一件事(比如有人给你的消息点了 reaction),不是请你做什么。
  // 与扩展「附带」那一档同一种写法:只陈述「不是请求」这件事实,不写义务;回程工具照写,要发言时不必再找路。
  if (mode === 'notice') {
    return `A 咕咕 system notice, not a request; anything you do post about it goes through ${RETURN_TOOL_BY_ROUTE[route]} — what you print here does not reach the chat.`
  }
  return `Sent to you through 咕咕; what you print here does not reach the sender — reply with ${RETURN_TOOL_BY_ROUTE[route]}.`
}

/** #6562 没有发送者的系统消息是通知:不是请求。 */
export type DeliveryMode = 'notice' | 'task'

/**
 * 一条投递进入 agent prompt 前的全部现场事实。
 *
 * 这是 producer 的**唯一**入参形状：id 已编码成 typed 形态、展示串已解析完毕。adapter 不能
 * 往这里塞行为脚本、工具清单、回复义务或收件人数量——那些不是本轮事实（device-command-runtime
 * spec:「信封是可见事实与能力索引，不是行为脚本」）。
 */
type CommonEnvelopeFacts = {
  /** 人读的发信方；`null` = 可展示内容只剩 `fromId` 本身，那一格已经把事实带到了。 */
  from: string | null
  /** 人读的送达时刻。 */
  at: string
  /** chat 路由的群号锚（服务端认它）；其余渠道缺席。 */
  chat?: string | null
  /** Canonical source reference; unlike public chat numbers it is directly navigable. */
  sourceLink?: string | null
  /** DM 还是群 —— 从公开群号锚推不出来，所以单独一格。 */
  chatKind?: ChatKind | null
  /** 悄悄话的收件人（typed id，空格分隔）：库里 `is_whisper` 那一行才有，只有发信人和这几位看得见（#6835）。 */
  whisperTo?: string | null
  /** App 以当前用户的名义送来的（`gugu.dispatch`）：那个 App 的 id。 */
  viaApp?: string | null
  /** 已安排到点（route `scheduled`，#7221）：是它自己排的哪一条 —— 那条的标题。人看的投递卡上也写它。 */
  schedule?: string | null
  /** 论坛(route `forum`):是哪个帖子(`post:<uuid>`),`forum_reply` / `forum_read` 认它。 */
  post?: string | null
  thread?: string | null
  listenMode?: ListenMode | null
  replyTo?: { messageId: string; fromId: string; from: string | null; preview: string } | null
  threadContext?: string | null
  /**
   * **这一条消息自己**的附加上下文（issue mention 等），不是会话级的东西。
   * 它必须待在信封里而不是拼在 `content` 前后：一旦拼进去，provider 落库时它就与用户自己的话
   * 并成同一条 user 消息，重放后谁也分不出哪段是人说的（#4456 的病灶就是这个）。
   */
  messageContext?: string | null
  /**
   * 群/话题此刻生效的群规(#3641 会话态必达)。`version` 每条都带(一格事实:agent 据此知道规矩在、是哪一版);
   * `text` 只在这段上下文还没收到过这一版时才给(原文,不砍字不翻译);`''` = 群规被清空了。
   */
  groupRules?: { version: string; text: string | null } | null
  /** #6562 系统通知是「不是请求」（见 `arrivalHint`）。 */
  mode?: DeliveryMode | null
  /** session-direct:发信方自己声明的发完以后去向(owner 10-17「相当于一种协议」),不是程序推出的状态。 */
  then?: SessionMessageThen | null
  /** session-direct:发信方说这条回的是哪条(`msg:<uuid>`,它收到的那条信封的 `msg`)。 */
  inReplyTo?: string | null
  content: string
}

export const SESSION_MESSAGE_THEN = ['continue', 'wait', 'stop'] as const
/** `in_reply_to` 只收一个消息 id:它在信封头里看起来像平台写的事实,❌ 让发信方借这一格写任意文字。 */
export const SESSION_MESSAGE_REPLY_TO = /^msg:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type SessionMessageThen = (typeof SESSION_MESSAGE_THEN)[number]

/**
 * 一条投递进入 agent prompt 前的全部现场事实。
 *
 * **格子在不在由 route 决定，且只允许「这条渠道结构上没有这个事实」这一个理由**（#4456）：
 * 经咕咕送达的三条渠道各有一个咕咕发信人和一条稳定来源消息 ⇒ `fromId` / `messageId` 必填；
 * 当面轮没有咕咕消息、没有 chat、没有咕咕发信人 ⇒ 那几格在类型上就不存在。
 * ❌ 不得因为拼装方便省略一个**真实存在**的事实 —— 那正是 #4280 之前 `arrival` 漏掉的方式。
 */
export type DeliveryEnvelopeFacts = CommonEnvelopeFacts & {
  route: GuguRoutedKind
  /** typed id：`user:<uuid>`（chat / roster 寻址的 session-direct）或 `session:<uuid>`（graph 寻址的 session-direct）。 */
  fromId: string
  /** typed 稳定来源消息 id（`msg:<uuid>`）。retry 幂等归 ledger/receipt/dedup，不归这一格。 */
  messageId: string
}

/**
 * 唯一 producer。
 *
 * #3802 —— 一格一个事实，属性而不是标签对（`<a>x</a>` 要付两遍名字）。删掉的都是重复或噪音：
 *   source_surface + return_route → 一个 `route`，取值直接指到要用的回程工具
 *   source_chat_id + chat_label → 一个 `chat`（群号优先）；`chat_kind` 留着，因为
 *   agent 无法从公开群号安全推出 DM/群
 *   recipient_scope → 从 route 推得出来；local_direct_chat_id="absent" → 专门声明「这个没有」
 *   peer_identity → 与 from_id 同值；空的 thread_root_id → 有才发
 * #4280 —— session-direct 的 `origin=<JSON>` 逐格并进来：`sender_session_id`→`from_id`、
 *   `message_id`→`msg`、`reply_route.tool`→`route` 取值 + `arrival`；`recipient_session_id`
 *   （信封就在收件人的 prompt 里）、`cardinality`/`peer_scope`（信封不规定发几条、发给谁）
 *   与 `suggested_peer_session_id`（= `from_id`）都是重复或行为脚本，删。
 *
 * ⚠️ `msg` 是 UUID 不是 seq：`reply_to_message_id` 走 `messages?id=eq.…` 查行，seq 传过去查不到，
 *    砍掉它等于砍掉「带因果回复」这个能力。
 */
export function renderDeliveryEnvelope(facts: DeliveryEnvelopeFacts): string {
  const attr = (name: string, value: string | null | undefined) =>
    value == null || value === '' ? null : `${name}="${escapeXmlAttribute(value)}"`
  const attrs = [
    attr('route', facts.route),
    attr('from', facts.from),
    attr('from_id', facts.fromId),
    attr('via_app', facts.viaApp),
    attr('schedule', facts.schedule),
    attr('post', facts.post),
    attr('chat', facts.chat),
    attr('chat_kind', facts.chatKind),
    attr('whisper_to', facts.whisperTo),
    attr('thread', facts.thread),
    attr('msg', facts.messageId),
    attr('source_link', facts.sourceLink),
    attr('at', facts.at),
    attr('listen_mode', facts.listenMode),
    attr('rules', facts.groupRules?.version),
    attr('mode', facts.mode),
    attr('then', facts.then),
    attr('in_reply_to', facts.inReplyTo),
  ].filter((entry): entry is string => entry !== null)
  const lines = [`<gugu_delivery ${attrs.join(' ')}>`]
  if (facts.replyTo) {
    const replyToFrom = facts.replyTo.from ? ` from="${escapeXmlAttribute(facts.replyTo.from)}"` : ''
    lines.push(
      `  <reply_to msg="${escapeXmlAttribute(facts.replyTo.messageId)}" from_id="${escapeXmlAttribute(facts.replyTo.fromId)}"${replyToFrom}><![CDATA[${toCdata(facts.replyTo.preview)}]]></reply_to>`,
    )
  }
  if (facts.groupRules && facts.groupRules.text !== null) {
    const version = escapeXmlAttribute(facts.groupRules.version)
    lines.push(
      facts.groupRules.text
        ? `  <group_rules version="${version}"><![CDATA[${toCdata(facts.groupRules.text)}]]></group_rules>`
        : `  <group_rules version="${version}" removed="true"/>`,
    )
  }
  if (facts.threadContext) {
    lines.push(`  <thread_context><![CDATA[${toCdata(facts.threadContext)}]]></thread_context>`)
  }
  if (facts.messageContext) {
    lines.push(`  <message_context><![CDATA[${toCdata(facts.messageContext)}]]></message_context>`)
  }
  // @@@arrival-last (#4667) - 回程提示排在正文之后、闭合标签之前的最后一格。
  // 它是这个壳里唯一一句写给读者的话,而它要影响的判断发生在读完正文之后。
  // ⚠️ 措辞未动(仍是同一个 `arrivalHint`):本次只改位置,单变量。
  // ⚠️ 批量外框 `renderDeliveryEnvelopes` 的 arrival 位置**不在本次改动内**(归 delivery-routing 治理)。
  lines.push(
    `<![CDATA[${toCdata(facts.content)}]]>`,
    `  <arrival>${escapeXmlText(arrivalHint(facts.route, facts.mode ?? null))}</arrival>`,
    '</gugu_delivery>',
  )
  return lines.join('\n')
}

/**
 * 合并段格式(方案 ④-1),单一属主在此 —— ❌ 不在 machine / drain / adapter 各写一份 merge。
 *
 * 一批投递并成**一个** provider 输入时,每条消息保留自己完整的 `<gugu_delivery>` 段
 * (route/from/from_id/chat/msg/at/arrival 一格不丢——per-message 归因是消息级义务判定的前提,#4475),
 * 外框只有 count 与一条 arrival 事实句(事实+能力索引,❌ 不写回复义务/次数/顺序——
 * 「信封不是行为脚本」红线不动)。单条不包外框:与单条投递逐字节相同。
 * 旧的 `mergeSessionDirectEnvelopes`(拼 CDATA 丢发件人归因,D2/D3 病灶)随耐久批一起退役。
 */
export function mergeDeliveryEnvelopes(envelopes: readonly string[]): string {
  if (envelopes.length <= 1) return envelopes[0] ?? ''
  const arrival =
    `${envelopes.length} deliveries arrived together; each block below is an independent message `
    + 'carrying its own route and return facts — none of them speaks for the others.'
  return [
    `<gugu_deliveries count="${envelopes.length}" arrival="${escapeXmlText(arrival).replaceAll('"', '&quot;')}">`,
    ...envelopes,
    '</gugu_deliveries>',
  ].join('\n')
}

/** 读出来的一条投递的现场事实:名字与 `DeliveryEnvelopeFacts` 一一对应,`null` = 这条信封没带这一格。 */
export type DeliveryReadFacts = {
  sourceLink?: string
  route: string
  from: string | null
  fromId: string | null
  chat: string | null
  chatKind: string | null
  whisperTo: string | null
  viaApp: string | null
  schedule: string | null
  post: string | null
  thread: string | null
  messageId: string | null
  at: string | null
  listenMode: string | null
  mode: string | null
  then: string | null
  inReplyTo: string | null
  replyTo: { messageId: string; fromId: string; from: string | null; preview: string } | null
  threadContext: string | null
  messageContext: string | null
}

/** 一条投递。`facts` 为 `null` 的只有 08-25 那种嵌套写法:它没有结构化事实。 */
export type DeliverySegment = { facts: DeliveryReadFacts | null; body: string }

/** `body` = 各段正文依次以空行相接;单条就是那一条的正文。 */
export type DeliveryReading = { body: string; segments: DeliverySegment[] }

/**
 * 读方,与 `renderDeliveryEnvelope` / `mergeDeliveryEnvelopes` 成对 —— ❌ 别处再写判据或解析器。
 *
 * 只认本模块写出来的那套语法(双引号属性、5 个实体、CDATA、上面那几种子元素与外框),不借 DOM,
 * 所以渲染层、主进程、记录源拿到的是同一个答案。首尾相接的几条信封(harness 把排着队的几条并成一条输入)
 * 按一批读。另认三种退役写法,只读:08-25 的嵌套 `<gugu_instruction>/<gugu_body>`、#4280 之前的会话直发
 * 两行头、外框之前的方括号批。认不出 = `null`,调用方把原文当普通文字。
 */
export function readDeliveryEnvelope(text: string): DeliveryReading | null {
  const source = text.trim()
  const segments = DELIVERY_ROOT.test(source)
    ? readXmlSegments(source)
    : source.startsWith('[') ? readRetiredSessionDirect(source) ?? readRetiredBatch(source) : null
  if (!segments) return null
  return { body: segments.map((segment) => segment.body).join('\n\n'), segments }
}

/**
 * Reconcile recovery against provider-owned user history, never optimistic host rows.
 * `receivedMessageIds` are ids already read off the provider's own record (#980: resumed without replay);
 * they count as received exactly like ids found in replayed inputs.
 */
export function recoverDeliveryEnvelopes(
  text: string,
  replayedUserInputs: readonly string[],
  historyUnknown = false,
  receivedMessageIds?: ReadonlySet<string>,
): string | null {
  let envelopes: XmlElement[] | null
  try {
    envelopes = envelopesOf(parseXml(text.trim()))
  } catch (error) {
    if (error !== NOT_ENVELOPE) throw error
    envelopes = null
  }
  if (!envelopes?.length || envelopes.some((envelope) => envelope.name !== 'gugu_delivery' || !readSegment(envelope))) {
    // Opaque or retired inputs must remain deliverable even when no safe per-envelope edit exists.
    return text
  }
  const seen = new Set([...(receivedMessageIds ?? []), ...replayedUserInputs.flatMap((input) =>
    readDeliveryEnvelope(input)?.segments.flatMap((segment) => segment.facts?.messageId ? [segment.facts.messageId] : []) ?? [])])
  const retained = envelopes.filter((envelope) => historyUnknown || !seen.has(envelope.attrs.get('msg') ?? ''))
  if (retained.length === 0) return null
  return mergeDeliveryEnvelopes(retained.map((envelope) => {
    if (!historyUnknown || envelope.attrs.get('possibly_received') === 'true') return envelope.source
    return envelope.source.slice(0, envelope.openingEnd - 1)
      + ' possibly_received="true">\n  <redelivery>This message may already have been received.</redelivery>'
      + envelope.source.slice(envelope.openingEnd)
  }))
}

/**
 * 这段文字是不是一条投递(而不是人打的字、harness 注入的上下文):以信封根标签开头的都算,读不读得出看
 * `readDeliveryEnvelope`;退役写法读得出才算。读方漏认一种形状时,那条照样不冒充人说的话,也不被当注入丢掉。
 */
export function isDeliveryEnvelope(text: string): boolean {
  const source = text.trim()
  return DELIVERY_ROOT.test(source) || readDeliveryEnvelope(source) !== null
}

const DELIVERY_ROOT = /^<gugu_deliver(?:y|ies)[\s>]/

type XmlElement = { name: string; attrs: Map<string, string>; children: XmlNode[]; source: string; openingEnd: number }
type XmlNode = XmlElement | { cdata: string } | { text: string }

const NOT_ENVELOPE = new Error('not a delivery envelope')
const XML_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]])
const XML_NAME = /[A-Za-z_][\w-]*/y
const XML_ATTR = /\s+([A-Za-z_][\w-]*)="([^"<]*)"/y
const XML_SPACE = /\s*/y
const XML_TEXT = /[^<]+/y
/** 外框会套外框(并过的一批又被并进下一批,真实记录里见过两层);这么深的只可能是构造出来的输入。 */
const MAX_DEPTH = 32

function readXmlSegments(source: string): DeliverySegment[] | null {
  let roots: XmlElement[]
  try {
    roots = parseXml(source)
  } catch (error) {
    if (error === NOT_ENVELOPE) return null
    throw error
  }
  const envelopes = envelopesOf(roots)
  if (!envelopes) return null
  const segments: DeliverySegment[] = []
  for (const envelope of envelopes) {
    const segment = envelope.name === 'gugu_delivery' ? readSegment(envelope) : null
    if (!segment) return null
    segments.push(segment)
  }
  return segments
}

/** 外框拆开(套着的外框一并拆),按原顺序排成一列信封。 */
function envelopesOf(elements: XmlElement[]): XmlElement[] | null {
  const envelopes: XmlElement[] = []
  for (const element of elements) {
    if (element.name !== 'gugu_deliveries') {
      envelopes.push(element)
      continue
    }
    const inner = element.children.filter(isElement)
    if (inner.length === 0 || hasContentOutsideElements(element)) return null
    const flattened = envelopesOf(inner)
    if (!flattened) return null
    envelopes.push(...flattened)
  }
  return envelopes
}

function readSegment(envelope: XmlElement): DeliverySegment | null {
  const legacyBody = childElement(envelope, 'gugu_body')
  if (legacyBody && childElement(envelope, 'gugu_instruction')) return { facts: null, body: textOf(legacyBody) }
  const cdata = envelope.children.filter((node): node is { cdata: string } => 'cdata' in node)
  if (cdata.length === 0 || envelope.children.some((node) => 'text' in node && node.text.trim())) return null
  const attr = (name: string) => envelope.attrs.get(name) || null
  const reply = childElement(envelope, 'reply_to')
  const replyMsg = reply?.attrs.get('msg')
  const replyFromId = reply?.attrs.get('from_id')
  return {
    body: cdata.map((node) => node.cdata).join(''),
    facts: {
      route: attr('route') ?? 'chat',
      from: attr('from'),
      fromId: attr('from_id'),
      chat: attr('chat'),
      chatKind: attr('chat_kind'),
      whisperTo: attr('whisper_to'),
      viaApp: attr('via_app'),
      schedule: attr('schedule'),
      post: attr('post'),
      thread: attr('thread'),
      messageId: attr('msg'),
      ...(attr('source_link') ? { sourceLink: attr('source_link')! } : {}),
      at: attr('at'),
      listenMode: attr('listen_mode'),
      mode: attr('mode'),
      then: attr('then'),
      inReplyTo: attr('in_reply_to'),
      replyTo: reply && replyMsg && replyFromId
        ? { messageId: replyMsg, fromId: replyFromId, from: reply.attrs.get('from') || null, preview: textOf(reply) }
        : null,
      threadContext: textOf(childElement(envelope, 'thread_context')) || null,
      messageContext: textOf(childElement(envelope, 'message_context')) || null,
    },
  }
}

/** 一串首尾相接(中间只有空白)的元素;语法外的任何东西都抛 `NOT_ENVELOPE`。 */
function parseXml(source: string): XmlElement[] {
  let at = 0
  const reject = (): never => {
    throw NOT_ENVELOPE
  }
  const eat = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = at
    const match = pattern.exec(source)
    if (match) at = pattern.lastIndex
    return match
  }
  const expect = (literal: string) => {
    if (!source.startsWith(literal, at)) reject()
    at += literal.length
  }
  const element = (depth: number): XmlElement => {
    if (depth > MAX_DEPTH) reject()
    const start = at
    expect('<')
    const name = eat(XML_NAME)?.[0] ?? reject()
    const attrs = new Map<string, string>()
    for (let attr = eat(XML_ATTR); attr; attr = eat(XML_ATTR)) attrs.set(attr[1]!, decodeXmlText(attr[2]!))
    eat(XML_SPACE)
    if (source.startsWith('/>', at)) {
      at += 2
      return { name, attrs, children: [], source: source.slice(start, at), openingEnd: at - start }
    }
    expect('>')
    const openingEnd = at - start
    const children: XmlNode[] = []
    while (!source.startsWith('</', at)) {
      if (source.startsWith('<![CDATA[', at)) {
        const end = source.indexOf(']]>', at)
        if (end < 0) reject()
        children.push({ cdata: source.slice(at + '<![CDATA['.length, end) })
        at = end + ']]>'.length
      } else if (source.startsWith('<', at)) {
        children.push(element(depth + 1))
      } else {
        children.push({ text: decodeXmlText(eat(XML_TEXT)?.[0] ?? reject()) })
      }
    }
    expect(`</${name}`)
    eat(XML_SPACE)
    expect('>')
    return { name, attrs, children, source: source.slice(start, at), openingEnd }
  }
  const roots: XmlElement[] = []
  do {
    roots.push(element(1))
    eat(XML_SPACE)
  } while (at < source.length)
  return roots
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:(\w+);)?/g, (_, name: string | undefined) => (name && XML_ENTITIES.get(name)) ?? reject())
  function reject(): never {
    throw NOT_ENVELOPE
  }
}

function isElement(node: XmlNode): node is XmlElement {
  return 'name' in node
}

function childElement(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((node): node is XmlElement => isElement(node) && node.name === name)
}

function hasContentOutsideElements(parent: XmlElement): boolean {
  return parent.children.some((node) => 'cdata' in node || ('text' in node && node.text.trim() !== ''))
}

function textOf(element: XmlElement | undefined): string {
  if (!element) return ''
  return element.children.map((node) => ('cdata' in node ? node.cdata : 'text' in node ? node.text : textOf(node))).join('')
}

function retiredSessionDirectFacts(fields: { from: string | null; fromId: string; messageId: string; at: string | null }): DeliveryReadFacts {
  return {
    route: 'session-direct',
    ...fields,
    chat: null,
    chatKind: null,
    whisperTo: null,
    viaApp: null,
    schedule: null,
    post: null,
    thread: null,
    listenMode: null,
    mode: null,
    then: null,
    inReplyTo: null,
    replyTo: null,
    threadContext: null,
    messageContext: null,
  }
}

const RETIRED_SESSION_DIRECT_HEAD = '[gugu_session session-direct]\norigin='

/** #4280 之前的会话直发两行头。旧版本也用同一种头存过生命周期事实(`kind: 'lifecycle'`),那不是投递。 */
function readRetiredSessionDirect(source: string): DeliverySegment[] | null {
  if (!source.startsWith(RETIRED_SESSION_DIRECT_HEAD)) return null
  const originEnd = source.indexOf('\n', RETIRED_SESSION_DIRECT_HEAD.length)
  if (originEnd < 0) return null
  let origin: unknown
  try {
    origin = JSON.parse(source.slice(RETIRED_SESSION_DIRECT_HEAD.length, originEnd))
  } catch {
    return null
  }
  if (origin === null || typeof origin !== 'object') return null
  const { source: channel, kind, sender_session_id: fromId, message_id: messageId } = origin as Record<string, unknown>
  if (channel !== 'session-direct' || kind !== 'message') return null
  if (typeof fromId !== 'string' || !fromId || typeof messageId !== 'string' || !messageId) return null
  return [{ facts: retiredSessionDirectFacts({ from: null, fromId, messageId, at: null }), body: source.slice(originEnd + 1) }]
}

/** 外框之前的会话直发批:每条一个 `[route=… from_id=… msg=… at=…]` 头,接着它的正文。 */
function readRetiredBatch(source: string): DeliverySegment[] | null {
  const segments: DeliverySegment[] = []
  let next = 0
  for (const match of source.matchAll(/\[([^\]\n]+)\]([\s\S]*?)(?=\n\[|$)/g)) {
    // 段与段首尾相接:中间漏过的任何文字都说明这不是那种批。
    if (match.index !== next) return null
    next = match.index + match[0].length + 1
    const attrs = new Map(
      [...match[1]!.matchAll(/([\w-]+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, name, value]) => [name!, value!.replace(/^"|"$/g, '')]),
    )
    const fromId = attrs.get('from_id')
    const messageId = attrs.get('msg')
    const at = attrs.get('at')
    if (attrs.get('route') !== 'session-direct' || !fromId || !messageId || !at) return null
    segments.push({ facts: retiredSessionDirectFacts({ from: attrs.get('from') ?? null, fromId, messageId, at }), body: match[2]!.trim() })
  }
  return segments.length >= 2 ? segments : null
}

export interface AgentDeliveryEnvelopeInput {
  guguUserId: string
  chatId: string | null
  messageId: string
  senderUserId: string | null
  /** Only a system message may have no user sender. */
  contentType?: string | null
  content: string
  replyTo: { messageId: string; senderUserId: string; content: string } | null
  threadRootId: string | null
  /** `is_whisper` 行的收件人（裸 user id）；不是悄悄话 = null。 */
  whisperTo?: readonly string[] | null
  /** App 代发（`gugu.dispatch`）的 App id；不是 = null。 */
  viaApp?: string | null
}

export type AgentDeliveryToolNames = {
  message: string
}

// @@@envelope-names (#952 回港 #4282) - sender gugu_number + display name resolved together for the envelope.
// isAgent is retained for identity display and runtime routing context; the facts-only envelope does not branch on it.
// #4255 —— guguNumber 可为 null:本机 agent 常态是咕咕号未分配。map 的成员资格回答「身份行存在」,
// 号只是展示锚点;把没号的行滤掉会让存在性判断(main.ts 的 local-direct sender 闸)对真实身份说谎。
export type GuguIdentity = { guguNumber: number | null; displayName: string | null; isAgent?: boolean }

/**
 * Resolve structured mentions beside the body, without rewriting the user's words.
 * Only unique names present in the body get an address binding. Identity rows do not
 * establish locality, transport, or task membership, so none of those facts are inferred.
 */
export function buildAgentMentionContext(
  content: string,
  recipientIds: readonly string[] | null | undefined,
  identities: ReadonlyMap<string, GuguIdentity>,
  readerUserId: string,
): string | undefined {
  if (!content || !recipientIds?.length) return undefined
  const byName = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const recipientId of recipientIds) {
    if (recipientId === '*') continue
    const name = identities.get(recipientId)?.displayName?.trim()
    if (!name) continue
    const prior = byName.get(name)
    if (prior && prior !== recipientId) ambiguous.add(name)
    else if (!ambiguous.has(name)) byName.set(name, recipientId)
  }
  const candidates = [...byName.entries()]
    .filter(([name]) => !ambiguous.has(name))
    .sort(([left], [right]) => [...right].length - [...left].length)
  if (!candidates.length) return undefined
  const mentionedNames = new Set(findMentionSpans(content, candidates.map(([name]) => name)).map((span) => span.name))
  const facts: string[] = []
  for (const [name, recipientId] of candidates) {
    if (!mentionedNames.has(name)) continue
    const identity = identities.get(recipientId)
    const address = encodeTypedId('user', recipientId)
    const kind = recipientId === readerUserId || identity?.isAgent ? 'agent' : 'human'
    const self = recipientId === readerUserId ? ', you' : ''
    facts.push(`${JSON.stringify(`@${name}`)} = ${address} (${kind}${self})`)
  }
  return facts.length ? facts.join('\n') : undefined
}

// @@@chat-name-envelope (#952 回港 #4675) - name+kind drive the human-readable chat label in the envelope.
export interface ChatEnvelopeInfo {
  publicId: number | null
  name: string | null
  kind: ChatKind | null
}

/**
 * 咕咕身份 adapter（chat / roster 寻址的 session-direct）：发信方是一个 `identity.users` 行。
 *
 * @@@gugu-id-envelope - the envelope shows the sender by 咕咕号 when one is assigned; a sender without
 * a 咕咕号 (本机 agent 常态, #4255) is shown by display name with the typed id as the anchor instead.
 *
 * @@@arrival-fact (#3684) - turn-origin is a per-turn FACT, and this adapter sits on the producer side,
 * i.e. before localSessionDelivery flattens everything into opaque envelope bytes. A turn a person typed
 * straight into the session never reaches this function at all, so its absence is what marks that case —
 * there is no producer on that path to state anything. `route` carries it in one attribute.
 */
export function buildAgentDeliveryEnvelope(
  input: AgentDeliveryEnvelopeInput,
  guguIds: Map<string, GuguIdentity>,
  chatInfo: ChatEnvelopeInfo,
  timestamp: string,
  delivery: { kind: 'session-direct' } | null = null,
  toolNames: AgentDeliveryToolNames = {
    message: 'message_send',
  },
  context: {
    listenMode?: ListenMode
    threadContext?: string | null
    messageContext?: string
    groupRules?: { version: string; text: string | null } | null
  } = {},
): string {
  const messageTool = toolNames.message.trim()
  if (!messageTool) throw new Error('delivery tool names must be non-empty')
  const isSessionDirect = delivery?.kind === 'session-direct'
  const systemSender = input.senderUserId === null && input.contentType === 'system' && !isSessionDirect
  if (input.senderUserId === null && !systemSender) {
    throw new Error('only a system chat message may omit its sender identity')
  }
  const chatId = isSessionDirect ? null : input.chatId?.trim() || null
  if (!isSessionDirect && !chatId) throw new Error('chat delivery envelope requires a real chat id')
  // The provider-visible names remain validated at the transport boundary, but tool capability and
  // delivery instructions now live in the session system prompt instead of repeating in every message.
  void messageTool
  // @@@readable-anchors (#633) - prefer human-readable, copy-paste-able anchors: chat 群号(public_id).
  const chatAnchor = chatInfo.publicId != null ? String(chatInfo.publicId) : chatId ?? 'absent'
  return renderDeliveryEnvelope({
    route: isSessionDirect ? 'session-direct' : 'chat',
    // @@@envelope-names (#952 回港 #4282) - lead with the human name; keep 咕咕号/群号 as copy-paste CLI anchors.
    from: systemSender ? '咕咕系统' : identityShown(guguIds, input.senderUserId!),
    // A system event has no addressable identity.users row. Never fabricate user:null.
    fromId: systemSender ? 'system:gugu' : encodeTypedId('user', input.senderUserId!),
    messageId: encodeTypedId('msg', input.messageId),
    at: timestamp,
    chat: isSessionDirect ? null : chatAnchor,
    sourceLink: chatId ? storedMessageLink(chatId, input.messageId) : null,
    chatKind: isSessionDirect ? null : chatInfo.kind,
    // 会话直发那条本地合成行的 is_whisper 是传输细节，不是人说的悄悄话。
    whisperTo: isSessionDirect || !input.whisperTo?.length ? null : input.whisperTo.map((id) => encodeTypedId('user', id)).join(' '),
    viaApp: isSessionDirect ? null : input.viaApp ?? null,
    thread: isSessionDirect ? null : input.threadRootId,
    listenMode: context.listenMode ?? null,
    replyTo: input.replyTo
      ? {
          messageId: encodeTypedId('msg', input.replyTo.messageId),
          fromId: encodeTypedId('user', input.replyTo.senderUserId),
          from: identityShown(guguIds, input.replyTo.senderUserId),
          preview: replyPreview(input.replyTo.content),
        }
      : null,
    threadContext: context.threadContext ?? null,
    // #6562 通知里只有表情(库不存名字),名字从 picker 用的同一份目录补进这一条的附加上下文。
    messageContext: [context.messageContext, systemSender ? describeReactions(input.content) : undefined]
      .filter(Boolean).join('\n') || undefined,
    groupRules: isSessionDirect ? null : context.groupRules ?? null,
    mode: systemSender ? 'notice' : null,
    content: input.content,
  })
}

/**
 * 会话直发的展示名上限。名字来自 `session_spawn` 的 `title`（spec session-graph:「命名即寻址名」），
 * 由 agent 自由填写，而宿主只对 `conversations.title` 那一列截长、`agentDisplayName` 是原样存的 ——
 * 所以这一格必须自己兜住长度。截断只影响展示；机器可用的地址在 `from_id` 一格里，完整无损。
 *
 * ⚠️ 按**码点**截，不按 UTF-16 code unit：`slice` 会把代理对劈成半个，那半个字符原样进属性，
 * 渲染器的 `DOMParser` 直接判 parsererror，于是整条 `<gugu_delivery …>` 在转录里退成一坨裸 XML。
 * (#4280 评审④)
 */
const SENDER_LABEL_MAX = 60

/**
 * 会话直发 adapter（session-direct）：发信方是同项目里另一条**活着的 session**，不是咕咕身份行。
 *
 * 它与 chat/local-direct 共用上面那个 producer，所以 `arrival` 这一格不可能再漏掉（#4280）。
 * ❌ 不为直投合成或借用假的 chat id：session-direct 不解析也不创建云端 `chat_id`。
 */
/**
 * 当面轮不经过此 adapter，直接使用用户原文。
 *
 * 为什么它也要有信封（#4456）：这条渠道从前是**靠缺席**被认出来的——没有信封就当是当面输入——
 * 而 device-command-runtime 的合同明写「❌ 不得靠信封缺席去反推当面输入」。#3577 之后当面轮确实
 * 补了一句声明，但它是在 renderer 里拼的**裸文本**，与用户自己的话一起进 prompt：provider 落库时
 * 两者并成同一条 user 消息，重放出来就是「用户说过的话」里混着一段机器文字（实测 owner 机器
 * 1987 条 userMessage 里 20 条如此）。⇒ 壳重新有了两个属主，正是 #4280 收敛掉的那个形状。
 *
 * 这里把它接回同一个 producer：当面轮从此与三条投递渠道同形、可折叠、可辨认，而它**结构上没有**的
 * 那三格（咕咕发信人 / 稳定来源消息 / chat）在类型上就不存在，不靠约定省略。
 */
export function buildSessionDirectEnvelope(input: {
  senderSessionId: string
  senderTitle: string | null
  messageId: string
  content: string
  at: string
  then?: SessionMessageThen
  /** typed `msg:<uuid>`. */
  inReplyTo?: string
}): string {
  const title = input.senderTitle?.trim() ?? ''
  return renderDeliveryEnvelope({
    route: 'session-direct',
    from: title ? [...title].slice(0, SENDER_LABEL_MAX).join('') : null,
    fromId: encodeTypedId('session', input.senderSessionId),
    messageId: encodeTypedId('msg', input.messageId),
    at: input.at,
    then: input.then,
    inReplyTo: input.inReplyTo,
    content: input.content,
  })
}

/**
 * 扩展 adapter（#6387）：发信方是一个装在这台电脑上的 tab 扩展。`from` 是它给人看的名字,
 * `from_id` 是它的扩展 id —— 扩展名可以撞,id 不会。
 */
export function buildExtensionEnvelope(input: {
  extensionId: string
  extensionName: string
  messageId: string
  content: string
  at: string
}): string {
  const name = input.extensionName.trim()
  return renderDeliveryEnvelope({
    route: 'extension',
    from: name ? [...name].slice(0, SENDER_LABEL_MAX).join('') : null,
    fromId: encodeTypedId('extension', input.extensionId),
    messageId: encodeTypedId('msg', input.messageId),
    at: input.at,
    content: input.content,
  })
}

/**
 * 咕咕系统 adapter（#6593）：咕咕自己要告诉这条会话的一件事。发信方就是咕咕，与聊天里的系统消息同一个
 * 名字与锚（`咕咕系统` / `system:gugu`）；它不来自任何聊天，所以没有 chat 那几格。
 */
export function buildSystemNoticeEnvelope(input: { messageId: string; content: string; at: string }): string {
  return renderDeliveryEnvelope({
    route: 'system',
    from: '咕咕系统',
    fromId: 'system:gugu',
    messageId: encodeTypedId('msg', input.messageId),
    at: input.at,
    content: input.content,
  })
}

/**
 * 系统任务 adapter（#7199）：咕咕自己交给这条会话去做的一件事（助理开通后的初始化）。发信方是咕咕（与系统通知同一个名字
 * 与锚），不挂聊天、没有人可回；与通知不同，它**是**要做的事 ⇒ `mode="task"`，arrival 写「照做」，❌ 沿用通知那句「不是请求」。
 * `context` 放这件事要用到的现场事实（比如和主人的私聊 id），放在信封那一格，❌ 拼进正文。
 */
export function buildSystemTaskEnvelope(input: { messageId: string; content: string; context?: string; at: string }): string {
  return renderDeliveryEnvelope({
    route: 'system',
    from: '咕咕系统',
    fromId: 'system:gugu',
    messageId: encodeTypedId('msg', input.messageId),
    at: input.at,
    mode: 'task',
    ...(input.context ? { messageContext: input.context } : {}),
    content: input.content,
  })
}

/**
 * 已安排 adapter（#7221）：这个 agent 自己排的那条到点了。发信方是咕咕（与系统通知同一个名字与锚）；
 * 正文是它当初写下的交代，原样；`schedule` 是那一条的标题；`context` 是「原定几点、重不重复、要取消用哪个 id」，
 * 放在信封那一格，❌ 拼进正文。
 */
export function buildScheduledEnvelope(input: { messageId: string; content: string; title: string; context: string; at: string }): string {
  return renderDeliveryEnvelope({
    route: 'scheduled',
    from: '咕咕系统',
    fromId: 'system:gugu',
    schedule: input.title,
    messageId: encodeTypedId('msg', input.messageId),
    at: input.at,
    messageContext: input.context,
    content: input.content,
  })
}

/**
 * 论坛 adapter:帖子上该交给这个 agent 的一件事(forum_pull_agent_inbox 的一行)。`msg` 是这件事的稳定 id(帖子 + 帖内序号
 * 算出来的 uuid,重投时不变);`context` 是帖子与悬赏的现状,放在信封那一格,❌ 拼进正文。结算由到期触发时没有发信人:同系统通知。
 */
export function buildForumEnvelope(input: {
  eventId: string
  postId: string
  from: string | null
  fromId: string | null
  at: string
  context: string
  content: string
}): string {
  return renderDeliveryEnvelope({
    route: 'forum',
    from: input.fromId ? input.from : '咕咕系统',
    fromId: input.fromId ?? 'system:gugu',
    post: encodeTypedId('post', input.postId),
    messageId: encodeTypedId('msg', input.eventId),
    at: input.at,
    messageContext: input.context,
    content: input.content,
  })
}

// @@@envelope-names (#952/#4255) - the single renderer for how a user is SHOWN: "Name (咕咕号 N)",
// "Name (user:<id>)", or bare "咕咕号 N". Anchor 用 typed id 时不冒充「咕咕号」;返回 null 表示
// 「可展示内容只剩 typed id 本身」—— 那个事实信封已在 from_id 一格里携带(#3802 一格一个事实)。
export function identityShown(guguIds: Map<string, GuguIdentity>, userId: string): string | null {
  const identity = guguIds.get(userId)
  const name = identity?.displayName ?? null
  const anchor = identity?.guguNumber != null ? `咕咕号 ${identity.guguNumber}` : encodeTypedId('user', userId)
  if (name) return `${name} (${anchor})`
  return identity?.guguNumber != null ? anchor : null
}

// @@@reply-preview - the deliver notification is the agent's only window into the replied-to message.
function replyPreview(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
}

// @@@deliver-timestamp - format the current time in a human-readable, timezone-aware
// format that gives the agent temporal context. e.g. "2026-06-14 13:15 北京时间 (UTC+8)".
// ⚠️ 日期与时刻必须取**同一套**时区分量:旧版拿 UTC 日历日(`toISOString`)配本地时刻、再挂本地时区标签,
// 每天都有一段时间两者不同日 —— UTC+8 的 26 号 01:30 会被写成「2026-08-25 01:30 北京时间」。
// 信封是事实载体,一格自相矛盾的时间比没有这一格更糟。(#4280 评审③)
export function formatDeliveryTimestamp(iso: string): string {
  const now = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const hhmm = now.toTimeString().slice(0, 5)
  const tzOffset = -now.getTimezoneOffset() / 60
  const tzLabel = tzOffset === 8 ? '北京时间' : `UTC${tzOffset >= 0 ? '+' : ''}${tzOffset}`
  return `${date} ${hhmm} ${tzLabel}`
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function toCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>')
}
