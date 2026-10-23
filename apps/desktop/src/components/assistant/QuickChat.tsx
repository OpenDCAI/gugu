import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { turnFailureReason } from '@gugu/core/shared/ui/systemNotice'
import { agentFailureText } from '../../lib/agentTurnFailure'
import { Avatar } from '../Avatar'
import { Markdown } from '../markdown/Markdown'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ArrowUp, SquareArrowOutUpRight, X } from '../../lib/icons'
import { LoadingIndicator } from '../../lib/loading/LoadingIndicator'
import { useReportChatOnScreen } from '../../lib/onScreenChat'
import { useChatStore } from '../../store/chatContext'
import { useChatConversation } from '../../store/useChatConversation'
import './quick-chat.css'

export type QuickChatAssistant = { id: string; display_name: string; avatar: string | null }

/** 小窗里最多画最近这几条(小窗只是看一眼、说一句;往前翻去主窗)。 */
const RECENT = 40

/**
 * #7199「快速聊天」小窗里那一块:顶上一条可拖的横栏(左关、中间它、右「打开咕咕」),
 * 中间是和它那条私聊最近的几条,底下一个输入框(Enter 发、Shift+Enter 换行)。草稿只在小窗里,❌ 混进主窗那条的草稿。
 * 按 chatId 订阅账户的聊天窗口,不改变主面的选中。
 * 还没有它 / 还在认 / 那条聊天没打开 / 一条都还没说过,各说各的。
 */
export function QuickChat({
  assistant,
  assistantState,
  chatId,
  chatFailed,
  retryChat,
  visible,
  shortcut,
  onClose,
  onOpenMain,
}: {
  assistant: QuickChatAssistant | null
  assistantState: 'found' | 'loading' | 'none' | 'unreadable'
  chatId: string | null
  chatFailed: boolean
  retryChat: () => void
  visible: boolean
  shortcut: string
  onClose: () => void
  onOpenMain: () => void
}) {
  const { t } = useTranslation('assistant')
  const name = assistant?.display_name ?? t('quickChat.assistant')
  return (
    <div className="qc" data-testid="quick-chat">
      <header className="qc-head">
        <IconButton size="sm" onClick={onClose} aria-label={t('quickChat.close')} title={t('quickChat.close')} data-testid="quick-chat-close">
          <X />
        </IconButton>
        <span className="qc-who">
          {assistant ? <Avatar name={assistant.display_name} avatarUrl={assistant.avatar} seed={assistant.id} size={24} isAgent harnessBadge={false} /> : null}
          <span>{name}</span>
        </span>
        <IconButton size="sm" onClick={onOpenMain} aria-label={t('quickChat.openApp')} title={t('quickChat.openApp')} data-testid="quick-chat-open-main">
          <SquareArrowOutUpRight />
        </IconButton>
      </header>
      {assistantState === 'none' ? (
        <QuickNote title={t('quickChat.noneTitle')} body={t('quickChat.none', { shortcut })} action={t('quickChat.setUp')} onAction={onOpenMain} testId="quick-chat-none" />
      ) : assistantState === 'unreadable' ? (
        <QuickNote title={t('quickChat.unreadableTitle')} body={t('quickChat.unreadable')} action={t('quickChat.openApp')} onAction={onOpenMain} testId="quick-chat-unreadable" />
      ) : chatFailed ? (
        <QuickNote title={t('quickChat.chatFailedTitle', { name })} body={t('quickChat.chatFailed')} action={t('machine.retry')} onAction={retryChat} testId="quick-chat-failed" />
      ) : assistantState === 'loading' || !chatId ? (
        <QuickNote loading body={t('quickChat.opening', { name })} />
      ) : (
        <QuickThread chatId={chatId} name={name} visible={visible} />
      )}
    </div>
  )
}

function QuickNote({ title, body, action, onAction, loading, testId }: { title?: string; body: string; action?: string; onAction?: () => void; loading?: boolean; testId?: string }) {
  return (
    <div className="qc-note" data-testid={testId}>
      {loading ? <LoadingIndicator size="inline" /> : null}
      {title ? <span className="qc-note-title">{title}</span> : null}
      <span>{body}</span>
      {action && onAction ? (
        <Button size="sm" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  )
}

/** 按自己的 chatId 订阅消息,并报告是否可见。 */
function QuickThread({ chatId, name, visible }: { chatId: string; name: string; visible: boolean }) {
  const { t } = useTranslation('assistant')
  useReportChatOnScreen(visible ? chatId : null)
  const { conversations, sendMessageToChat } = useChatStore('conversations', 'sendMessageToChat')
  const { messages, loadingMessages } = useChatConversation(chatId, conversations)
  const recent = messages.filter((message) => !message.thread_root_id && !message.retracted_at).slice(-RECENT)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [sendFailed, setSendFailed] = useState(false)

  // 每次摆出来都把光标放进输入框(小窗被叫出来就是要说一句)。
  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])
  // 新消息来了贴到底。
  const last = recent[recent.length - 1]?.id
  useLayoutEffect(() => {
    const box = list.current
    if (box) box.scrollTop = box.scrollHeight
  }, [last, visible])

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setSendFailed(false)
    try {
      await sendMessageToChat(chatId, text)
    } catch {
      setDraft(text)
      setSendFailed(true)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <>
      <div className="qc-list" ref={list} data-testid="quick-chat-messages">
        {loadingMessages && recent.length === 0 ? (
          <div className="qc-note">
            <LoadingIndicator size="inline" />
          </div>
        ) : recent.length === 0 ? (
          <div className="qc-note" data-testid="quick-chat-empty">
            <span className="qc-note-title">{t('quickChat.emptyTitle', { name })}</span>
            <span>{t('quickChat.empty')}</span>
          </div>
        ) : (
          recent.map((message) => <QuickMessage key={message.id} message={message} />)
        )}
      </div>
      <footer className="qc-compose">
        {sendFailed ? <span className="qc-error">{t('quickChat.sendFailed')}</span> : null}
        <div className="qc-box">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={t('chat.placeholder', { name })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="quick-chat-input"
          />
          <IconButton shape="pill" size="sm" className="qc-send" onClick={() => void send()} disabled={!draft.trim()} aria-label={t('quickChat.send')} data-testid="quick-chat-send">
            <ArrowUp />
          </IconButton>
        </div>
      </footer>
    </>
  )
}

function QuickMessage({ message }: { message: MessageItem }) {
  const { t } = useTranslation('assistant')
  if (message.content_type === 'system') {
    const reason = turnFailureReason(message)
    return <div className="qc-system">{reason ? agentFailureText(reason) : message.content}</div>
  }
  const body =
    message.content_type === 'text' ? (
      message.is_mine ? (
        <span className="qc-plain">{message.content}</span>
      ) : (
        <Markdown trust="chat" content={message.content ?? ''} />
      )
    ) : (
      <span className="qc-other">{t('quickChat.inApp')}</span>
    )
  return (
    <div className="qc-msg" data-mine={message.is_mine || undefined} data-sending={message.local_send_state ?? undefined} data-testid={`quick-chat-message-${message.id}`}>
      {body}
      {message.local_send_state === 'failed' ? <span className="qc-error">{t('quickChat.notSent')}</span> : null}
    </div>
  )
}
