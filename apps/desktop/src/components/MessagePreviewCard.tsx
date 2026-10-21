// @@@6357 working 栏悬浮卡 MessagePreview:版式照 assistant-ui SharedConversation,浮层档 tokens,
// 承载信息的字只用 --text-primary / --text-secondary(tertiary 过不了 AA)。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessagePreviewEntry } from '@gugu/session-core/session-record/message-preview'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../store/chatContext'
import { chatDb } from '../lib/supabase'
import { Avatar } from './Avatar'
import { formatRelativeTime } from '../lib/relativeTime'
import { useAgentMessagePreview } from '../hooks/useAgentMessagePreview'
import type { RunningToken } from './RunningTokenBar'

const STYLE = `
.mp-card{width:340px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;overflow:hidden;white-space:normal;background:var(--popover);border-radius:var(--radius-surface);box-shadow:var(--shadow-lift);color:var(--text-primary)}
.mp-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--font-caption);letter-spacing:-0.01em;color:var(--text-secondary)}
.mp-hd{display:flex;align-items:center;gap:10px;padding:14px 16px 12px}
.mp-hd-col{display:flex;flex-direction:column;min-width:0;flex:1}
.mp-name{font-size:var(--font-body);font-weight:500}
.mp-name,.mp-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-turns{border-top:1px solid var(--border-color);display:flex;flex-direction:column;gap:10px;padding:14px 16px}
.mp-text{font-size:var(--font-body);line-height:1.625;color:var(--text-secondary);overflow-wrap:anywhere}
.mp-note{font-size:var(--font-caption);color:var(--text-secondary)}
.mp-now{display:flex;align-items:center;gap:6px;font-size:var(--font-caption)}
.mp-prompt{margin-left:auto;max-width:85%;border-radius:16px;padding:8px 12px;background:color-mix(in srgb,var(--text-primary) 6%,transparent)}
.mp-prompt-who{display:block;font-size:var(--font-caption);color:var(--text-secondary)}
.mp-prompt-body{font-size:var(--font-body);line-height:1.625;color:var(--text-primary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}
.mp-prompt[data-preview-prompt=elsewhere] .mp-prompt-body{color:var(--text-secondary)}
`

type PromptMessage = Pick<MessageItem, 'id' | 'sender_user_id' | 'content' | 'retracted_at'>

/**
 * prompt 正文按 id 以我自己的身份取(走 RLS);缓存跟卡片走,撤回/换号后不残留。
 * undefined = 还在取;null = 我读不到(别的 chat、不是给我的悄悄话)。
 */
function usePromptMessages(
  ids: readonly string[],
  loaded: readonly MessageItem[],
): (id: string) => PromptMessage | null | undefined {
  const [cache, setCache] = useState<ReadonlyMap<string, PromptMessage | null>>(() => new Map())
  const byId = new Map<string, PromptMessage>(loaded.map((message) => [message.id, message]))
  const missing = ids.filter((id) => !byId.has(id) && !cache.has(id))
  const missingKey = missing.join(',')
  useEffect(() => {
    if (!missingKey) return
    let active = true
    const wanted = missingKey.split(',')
    void chatDb
      .from('messages')
      .select('id, sender_user_id, content, retracted_at')
      .in('id', wanted)
      .then(({ data, error }) => {
        if (error || !active) return
        const rows = (data ?? []) as PromptMessage[]
        setCache((current) => {
          const next = new Map(current)
          for (const id of wanted) next.set(id, rows.find((row) => row.id === id) ?? null)
          return next
        })
      })
    return () => {
      active = false
    }
  }, [missingKey])
  return (id) => byId.get(id) ?? cache.get(id)
}

type Block =
  /** message 为 null = 看卡的人读不到这条输入,画占位。 */
  | { kind: 'prompt'; id: string; message: PromptMessage | null }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; id: string; parts: { state: string; count: number }[] }

/** 条目 → 版块:prompt 读得到画正文、读不到或没有 id 画占位,还在取的先不画;连续工具并成一行、按类别合计。 */
const promptIdOf = (messageId: string) => messageId.replace(/^msg:/, '')

function toBlocks(entries: readonly MessagePreviewEntry[], lookup: (id: string) => PromptMessage | null | undefined): Block[] {
  const blocks: Block[] = []
  for (const entry of entries) {
    if (entry.kind === 'prompt') {
      const message = entry.messageId ? lookup(promptIdOf(entry.messageId)) : null
      if (message === undefined) continue
      const readable = message && message.content && !message.retracted_at ? message : null
      blocks.push({ kind: 'prompt', id: entry.id, message: readable })
    } else if (entry.kind === 'tool') {
      const last = blocks[blocks.length - 1]
      const same = last?.kind === 'tools' ? last.parts.find((part) => part.state === entry.state) : undefined
      if (same) same.count += entry.count
      else if (last?.kind === 'tools') last.parts.push({ state: entry.state, count: entry.count })
      else blocks.push({ kind: 'tools', id: entry.id, parts: [{ state: entry.state, count: entry.count }] })
    } else {
      blocks.push({ kind: 'text', id: entry.id, text: entry.truncated ? `…${entry.text}` : entry.text })
    }
  }
  return blocks
}

function BlockView({ block, senderName }: { block: Block; senderName: (id: string | null) => string }) {
  const { t } = useTranslation('agents')
  if (block.kind === 'prompt') {
    if (!block.message) {
      return (
        <div className="mp-prompt" data-preview-entry="prompt" data-preview-prompt="elsewhere">
          <div className="mp-prompt-body">{t('runtime.messagePreview.promptElsewhere')}</div>
        </div>
      )
    }
    return (
      <div className="mp-prompt" data-preview-entry="prompt">
        <span className="mp-prompt-who">{senderName(block.message.sender_user_id)}</span>
        <div className="mp-prompt-body">{block.message.content}</div>
      </div>
    )
  }
  if (block.kind === 'text') {
    return (
      <div className="mp-text" data-preview-entry="text">
        {block.text}
      </div>
    )
  }
  return (
    <div className="mp-mono" data-preview-entry="tool">
      {block.parts
        .map((part) => t('runtime.messagePreview.toolCount', { state: t(`runtime.stateWord.${part.state}`), count: part.count }))
        .join(' · ')}
    </div>
  )
}

export function MessagePreviewCard({
  chatId,
  token,
  displayName,
  open,
}: {
  chatId: string
  token: RunningToken
  displayName: string
  /** 开着才订阅。 */
  open: boolean
}) {
  const { t } = useTranslation('agents')
  const state = useAgentMessagePreview(chatId, token.id, open)
  const preview = state.status === 'live' ? state.preview : null
  const { messages, threadMessages, identitiesById } = useChatStore()
  const promptIds = (preview?.entries ?? []).flatMap((entry) =>
    entry.kind === 'prompt' && entry.messageId ? [promptIdOf(entry.messageId)] : [],
  )
  const lookupPrompt = usePromptMessages(promptIds, [...messages, ...threadMessages])
  const blocks = preview ? toBlocks(preview.entries, lookupPrompt) : []
  const senderName = (id: string | null) => (id ? identitiesById[id]?.display_name ?? '' : '')
  const rel = formatRelativeTime(token.lastActiveAt) ?? t('runtime.justNow')
  const meta = [
    t(`runtime.stateWord.${token.stateKey}`),
    token.toolCount > 0 ? `${token.toolCount} ${t('runtime.toolCallUnit')}` : null,
    rel,
  ]
    .filter(Boolean)
    .join(' · ')

  let note: string | null = null
  if (state.status === 'connecting' || state.status === 'idle') note = t('runtime.messagePreview.connecting')
  else if (state.status === 'unavailable') note = t('runtime.messagePreview.unavailable')
  else if (preview && preview.entries.length === 0 && !preview.running) note = t('runtime.messagePreview.empty')

  let now: { key: string; label: string } | null = null
  if (preview?.running) now = { key: preview.now ?? 'writing', label: t(`runtime.stateWord.${preview.now ?? 'running'}`) }
  else if (preview && preview.entries.length > 0) now = { key: 'done', label: t('runtime.messagePreview.done') }

  return (
    <div
      className="mp-card"
      data-slot="message-preview"
      data-preview-status={state.status}
      data-preview-error={state.status === 'unavailable' ? state.error : undefined}
      data-preview-rev={preview ? String(preview.rev) : undefined}
    >
      <style>{STYLE}</style>
      <div className="mp-hd">
        <Avatar name={displayName} avatarUrl={token.avatarUrl} seed={token.avatarSeed} size="xs" isAgent />
        <div className="mp-hd-col">
          <span className="mp-name">{displayName}</span>
          <span className="mp-mono mp-meta">{meta}</span>
        </div>
      </div>

      <div className="mp-turns" data-slot="message-preview-turns">
        {blocks.map((block) => <BlockView key={block.id} block={block} senderName={senderName} />)}
        {now ? (
          <div className="mp-now" data-preview-now={now.key}>
            <span className={preview?.running ? 'rtb-state' : 'mp-note'}>{now.label}</span>
          </div>
        ) : null}
        {note ? <div className="mp-note">{note}</div> : null}
      </div>
    </div>
  )
}
