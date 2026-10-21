// @@@5856 「群里 agent 超过 5 个 → 全员转 passive」那条系统消息的渲染 —— product spec「成员与响应档位」。
//
// spec 原话:产品**直接**把这个群里的 agent 全员转为 passive,并在消息流里落一条**居中的系统消息**
// 说明发生了什么、改了哪几个,**就在那条消息上一键全撤**。
//   ❌ 不做成设置里的一行说明,❌ 也不做成一条「建议」——建议没人会点。做了再告知,比先问要不要做有用。
//
// 分工:改档、写系统消息(正文里已经点名改了哪几个)、写台账,全在数据库那一侧
// (gugu-supabase 的 supabase/migrations/20260918211700_agent_flood_auto_passive_5856.sql)。这里只做两件事:
//   ① 用系统消息本身的版式把 content 照原样摆出来(壳与 MessageBubble 的 content_type==='system' 一致);
//   ② 按 message_id 查台账,决定这条消息上挂「全部撤回」还是「已撤回」。
//
// fail-loud:台账读不到 / 撤回失败,都把错误显示在这条消息底下 —— ❌ 不静默吞,
// 否则用户点了一下什么都没发生,而档位其实没还原。
import { Button } from '../ui/Button'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { topicService, type AgentFloodAdjustment } from '../../lib/topics'
import { rendererLogger } from '@/lib/log'

// @@@ui-ruler 结构性 style 提到模块作用域(同 ChatListPanel 的 *_STYLE 常量):
// 既避免每次渲染重建对象,也让 JSX 里不再残留内联几何块这条债务痕迹。
const AGENT_FLOOD_NOTICE_STYLE: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: '6px 12px' }
const AGENT_FLOOD_BODY_STYLE: React.CSSProperties = {
  maxWidth: '70%',
  padding: '2px 13px',
  color: 'var(--faint-fg)',
  fontSize: 'var(--font-caption)',
  lineHeight: 1.35,
  textAlign: 'center',
}
// @@@5856 owner 2026-09-19:「我不要这种单独一个图标,你把这个按钮融进一段文字中,以强调色显示不行吗.
// 你这样搞得很突兀」。所以「全部撤回」不是底下另起一行的一颗按钮,而是这句话末尾的一段强调色文字 ——
// 仍然是真的按钮(键盘可达、有 disabled 态),只是把外形压成行内文字,见 tokens.css 的 .gg-agent-flood-undo。
const AGENT_FLOOD_UNDO_CLASS = 'gg-agent-flood-undo inline h-auto min-h-0 w-auto border-0 bg-transparent p-0 align-baseline'
const AGENT_FLOOD_UNDONE_STYLE: React.CSSProperties = { marginLeft: 4, color: 'var(--text-tertiary)' }
// 两条失败行(撤回失败 / 台账读不出)版式本来就一模一样 ⇒ 同一个常量。
const AGENT_FLOOD_ERROR_LINE_STYLE: React.CSSProperties = { marginTop: 4, color: 'var(--danger)' }

export type AgentFloodSystemNoticeProps = {
  /** 那条 content_type='system' 的消息 */
  messageId: string
  content: string
  /** 撤回成功后让上层刷新成员档位 */
  onUndone?: () => void
}

const floodLog = rendererLogger('chat/agent-flood')

export function AgentFloodSystemNotice({ messageId, content, onUndone }: AgentFloodSystemNoticeProps) {
  const { t } = useTranslation('messaging')
  const [adjustment, setAdjustment] = useState<AgentFloodAdjustment | null>(null)
  const [busy, setBusy] = useState(false)
  // 两种失败分开显示:台账读不出来 ≠ 撤回失败,混成一句话会把「还没点就说撤回失败」摆到用户脸上。
  const [loadError, setLoadError] = useState<string | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setAdjustment(null)
    setLoadError(null)
    setUndoError(null)
    void topicService.getAgentFloodAdjustment(messageId)
      .then((row) => { if (!cancelled) setAdjustment(row) })
      // 原因进日志、不进文案:用户拿内部失败描述做不了任何事(user-copy-leak 闸的判据)。
      .catch((err: unknown) => { floodLog.error({ error: err, messageId }, 'agent flood ledger read failed'); if (!cancelled) setLoadError('failed') })
    return () => { cancelled = true }
  }, [messageId])

  const undo = useCallback(async () => {
    if (!adjustment || busy) return
    setBusy(true)
    setUndoError(null)
    try {
      await topicService.undoAgentFloodAdjustment(adjustment.id)
      // RPC 返回即代表台账那行真的落了 undone_at(它在同一个事务里改的),所以这不是乐观更新;
      // 失败会从 await 抛出来,走下面的 catch,按钮保持原样。
      setAdjustment((prev) => (prev ? { ...prev, undone_at: new Date().toISOString() } : prev))
      onUndone?.()
    } catch (err) {
      floodLog.error({ error: err, messageId }, 'agent flood undo failed')
      setUndoError('failed')
    } finally {
      setBusy(false)
    }
  }, [adjustment, busy, messageId, onUndone])

  const undone = !!adjustment?.undone_at

  return (
    <div data-testid="agent-flood-notice" style={AGENT_FLOOD_NOTICE_STYLE}>
      {/* 系统消息版式与 MessageBubble 的 content_type==='system' 同一套:居中、裸文字、非药丸。 */}
      <div style={AGENT_FLOOD_BODY_STYLE}>
        {/* 动作接在句子里,❌ 不另起一行摆一个方框控件。 */}
        <span>{content}</span>
        {adjustment && !undone ? (
          <>
            {' '}
            <Button
              variant="ghost"
              size="sm"
              data-testid="agent-flood-undo"
              onClick={() => { void undo() }}
              disabled={busy}
              className={AGENT_FLOOD_UNDO_CLASS}
            >
              {busy ? t('group.agentFlood.undoing') : t('group.agentFlood.undoAll')}
            </Button>
          </>
        ) : null}
        {undone ? (
          <span data-testid="agent-flood-undone" style={AGENT_FLOOD_UNDONE_STYLE}>
            {t('group.agentFlood.undone')}
          </span>
        ) : null}
        {undoError ? (
          <div data-testid="agent-flood-error" style={AGENT_FLOOD_ERROR_LINE_STYLE}>
            {t('group.agentFlood.undoFailed')}
          </div>
        ) : null}
        {loadError ? (
          <div data-testid="agent-flood-load-error" style={AGENT_FLOOD_ERROR_LINE_STYLE}>
            {t('group.agentFlood.ledgerLoadFailed')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
