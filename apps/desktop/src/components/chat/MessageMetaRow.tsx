import { AssistantReplyProcess } from '../assistant/AssistantReplyProcess'
import { ActivitySourceBadge } from './ActivitySourceBadge'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { AgentSentBadge } from './AgentSentBadge'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { useForwardedSource } from '../../hooks/useForwardedSource'
import { useChatStore } from '../../store/chatContext'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'

// @@@2017 — 一条消息气泡下方的**元指示行**:小号、非正文的注记(不是消息内容本身)。
// 各类注记都渲染成气泡列(flex column,见 MessageBubble 父容器)里各自独占一行的小字:
//   · Agent 代发 —— 对方只见 AI 发送;发送人可见具体 Agent 并跳回其对话。
//   · App 代发 —— #6835 App 用 gugu.send 以人的名义发的消息(via_app 非空)。发送人自己看到「由『X』App 代你发送」,
//     别人(悄悄话的收件人)看到「由『X』App 代 A 发送」:不然人会以为那句是 A 亲手打的。判据只有 via_app 一个,
//     看的人是不是发送人只决定文案;手机和桌面同一条。
//   · 定向兜底徽标 —— **只兜底**「to_user_ids 有 X、正文却缺 @X」的旧数据(#2010 发送时一致性校验前的历史
//     消息)。一致态(正文已 @)只高亮不挂徽标 = 单重显示;reply 被回复者由引用条表达、不进本徽标。
//     标签由 MessageBubble 经 buildMentionRender 算好传入(owner 终版 + product spec §3)。
//   · 转发指示 ——「forwarded」视觉。@@@5856 带上出处:「引自:某某线」。
//     spec(product spec)要的是「让人看得见发生了搬运、能当场喊停」——「发生过搬运」不够,
//     不知道从哪儿搬来的就判断不出该不该。出处读不到(读者看不见来源那条线)时退回只显「转发」:
//     ❌ 不渲染成「未知来源」,那和「你无权看见」在用户那里不是一回事。
// 从 MessageBubble(god file, #1897 冻结)抽出:该组件返回 Fragment,两 span 仍是父 flex 的直接子项。

export interface MessageMetaRowProps {
  /** 兜底徽标标签(路由有、正文缺 @token 的对象;displayName / 「全员」)。一致态为空 → 不挂。 */
  replyProcessMessageId?: string
  targetingLabels: readonly string[]
  activitySource?: { chatId: string; messageId: string }
  sentByAgent?: boolean
  agentSender?: MessageItem['agent_sender']
  /** 非空 = 这条是转发来的;它同时是「引自哪条线」的查询键。 */
  forwardedFromMessageId: string | null
  /** 非空 = 这条是 App 以人的名义发的,值是 App 的 id。 */
  viaApp: string | null
  /** App 代谁发的:null = 看的人自己就是发送人;否则是发送人的显示名(与气泡头同一个名字)。 */
  viaAppSender: string | null
}

export function MessageMetaRow({ targetingLabels, forwardedFromMessageId, viaApp, viaAppSender, sentByAgent, agentSender, activitySource, replyProcessMessageId }: MessageMetaRowProps) {
  const targetText = targetingLabels.join('、')
  if (!targetText && !forwardedFromMessageId && !viaApp && !sentByAgent && !activitySource && !replyProcessMessageId) return null

  return (
    <>
      {replyProcessMessageId && <AssistantReplyProcess messageId={replyProcessMessageId} />}
      {activitySource && <ActivitySourceBadge {...activitySource} />}
      {sentByAgent && <AgentSentBadge source={agentSender ?? null} />}
      {viaApp && <ViaAppBadge appId={viaApp} sender={viaAppSender} />}
      {targetText && (
        <span
          data-testid={AUTOMATION_TEST_IDS.messageTargetingBadge}
          data-message-targeting="true"
          style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--faint-fg)', padding: '0 2px', letterSpacing: '0.01em' }}
        >
          {`→ ${targetText}`}
        </span>
      )}
      {forwardedFromMessageId && <ForwardedBadge forwardedFromMessageId={forwardedFromMessageId} />}
    </>
  )
}

// App 的名字在它的 manifest 里,只有装着这个 App 的机器(扩展清单那份 store)叫得出;别的端只认得 id,就写 id。
const ViaAppBadge = observer(function ViaAppBadge({ appId, sender }: { appId: string; sender: string | null }) {
  const { t } = useTranslation('messaging')
  const app = installedExtensionsStore.appName(appId) ?? appId
  return (
    <span
      data-testid={AUTOMATION_TEST_IDS.messageViaAppBadge}
      data-via-app={appId}
      className="px-[2px] text-[length:var(--font-caption)] leading-[var(--lh-caption)] tracking-[0.01em] text-[var(--faint-fg)]"
    >
      {sender === null ? t('message.viaApp', { app }) : t('message.viaAppFor', { app, name: sender })}
    </span>
  )
})

// 只有转发来的消息才需要会话列表来叫出出处的名字 —— 所以只有它订阅 chats。
// 放在元指示行本体里时,每条气泡都订阅 chats,任何一条会话的预览变了全部气泡的这一行都重渲。
function ForwardedBadge({ forwardedFromMessageId }: { forwardedFromMessageId: string }) {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const source = useForwardedSource(forwardedFromMessageId)
  // 来源是私聊时 chats.name 是空的 —— 服务端只回它存的那个字段,「这条线叫什么」是渲染层的事。
  // ❌ 不在服务端 join identity 去拼名字:forwarded_source 是 SECURITY INVOKER,能读到这一行
  // 就说明读者本来就在那条线里 ⇒ 它一定在自己的会话列表里,本地就叫得出名字。
  // 名字仍然叫不出(线还没同步到本地)→ sourceName 为空 → 照旧退回只显「转发」。
  const sourceChat = source ? chats.find((chat) => chat.id === source.chatId) : undefined
  const sourceName = source?.name?.trim()
    || (sourceChat ? chatDisplayName(sourceChat, identitiesById[sourceChat.peer_user_id ?? '']?.display_name) : '')
  return (
    <span
      data-testid={AUTOMATION_TEST_IDS.messageForwardedBadge}
      style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--text-tertiary)', padding: '0 2px', letterSpacing: '0.01em' }}
    >
      {sourceName ? t('message.forwardedFrom', { line: sourceName }) : t('message.forwarded')}
    </span>
  )
}
