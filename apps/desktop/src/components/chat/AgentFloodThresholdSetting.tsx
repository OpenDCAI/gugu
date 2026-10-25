import { messageForUser } from '@/lib/userFacingError';
// @@@5856 「agent 超过几个就全员转被动」这条线的设置行 —— 群和话题**共用这一个**。
//
// owner 2026-09-19 的裁决:「之前说是 5 个转为 passive, 这个数字可以放在设置中,而不是硬编码。
// 这个 5 个的 passive 不止可以适用于一个群内,群内的 topic 应该也是生效的,
// 不过群内的 topic 可以设置一个自定义个不一样的数,或者遵循群主规则。」
//
// 形状上只有**一个**控件,没有「跟随 / 自定义」的第二个开关:空 = 继承(话题跟来源那条线、群跟产品默认),
// 填了 = 以这个数为准。占位符里显示的就是此刻实际生效的数,所以「跟随的是多少」不用另开一行去说。
//
// 实际生效的那个数由 **DB 计算列** agent_flood_threshold_effective 给出,❌ 这里不写 COALESCE、
// ❌ 也不写死 5:界面显示的数必须和触发器判的数是同一个,否则用户照着界面改,改出来的行为对不上。
// 取不到就整行不画 —— 空得看得出是空,好过编一个像真的默认值。
//
// 自己取值、自己落库:来源设置统一管理群与话题,每条线复用同一控件,
// ❌ 不各抄一份取值/存值/回填的代码。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'
import { useToast } from '../toastContext'
import { parseAgentFloodThresholdDraft } from './agentFloodThresholdModels'

const floodLog = rendererLogger('chat/agent-flood-threshold')

const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
  // 2026-09-22 design.md:行靠 padding 分隔、线只留在分区标题上 —— 这一行原来自带底线,在群管理里会和下一个分区标题叠成双线(#6418)。
  padding: '15px 0',
}
const TITLE_STYLE: CSSProperties = { fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)' }
const HINT_STYLE: CSSProperties = {
  fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.5,
}
const VALUE_STYLE: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', flexShrink: 0 }
const INPUT_STYLE: CSSProperties = {
  width: 64, textAlign: 'right', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)',
  padding: '4px 8px', fontSize: 'var(--font-body)', color: 'var(--text-primary)',
  background: 'var(--bg-elevated)', outline: 'none', fontFamily: 'inherit', flexShrink: 0,
}

export function AgentFloodThresholdSetting({
  chatId,
  editable,
  inherits,
  onSaved,
  revision = 0,
}: {
  chatId: string
  editable: boolean
  /** 这条线上面还有一条线可跟(话题有,群没有)——只影响那句说明的措辞。 */
  inherits: boolean
  onSaved?: () => void
  revision?: number
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const saving = useRef(false)
  const readSequence = useRef(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [value, setValue] = useState<number | null>(null)
  const [effective, setEffective] = useState<number | null>(null)
  // null means no local edit; an empty string is the explicit inheritance draft.
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sequence = ++readSequence.current
    setFailed('')
    chatService.getGroupChatSettings(chatId)
      .then((settings) => {
        if (cancelled || sequence !== readSequence.current) return
        setValue(settings.agent_flood_threshold)
        setEffective(settings.agent_flood_threshold_effective)
      })
      // ❌ 不静默:读不到就整行不画(effective 仍是 null),但失败本身要留在日志里。
      .catch((error: unknown) => {
        if (cancelled || sequence !== readSequence.current) return
        floodLog.error({ error, chatId }, 'agent flood threshold load failed')
        setFailed(messageForUser(error))
      })
    return () => { cancelled = true }
  }, [chatId, revision])

  const commit = useCallback(() => {
    if (!editable || saving.current) return
    const next = parseAgentFloodThresholdDraft(draft ?? (value === null ? '' : String(value)))
    // 收不下的输入就还原成上一个有效值 —— ❌ 不弹错、也 ❌ 不把半截输入存进去。
    if (next === undefined || next === value) { setDraft(null); return }
    readSequence.current += 1
    saving.current = true
    setBusy(true)
    chatService.updateGroupChatSettings(chatId, { agent_flood_threshold: next })
      .then((updated) => {
        // Reads begun before this acknowledgement must not replace the saved value.
        readSequence.current += 1
        setValue(updated.agent_flood_threshold)
        setDraft(null)
        // 生效值可能跟着变(填了自己的数之后就不再跟上面那条线走),回填权威的那一份。
        setEffective(updated.agent_flood_threshold_effective)
        onSaved?.()
      })
      .catch((error: unknown) => {
        floodLog.error({ error, chatId }, 'agent flood threshold save failed')
        setDraft(null)
        toast(t('group.settings.agentFloodSaveFailed'), 'error', messageForUser(error))
      })
      .finally(() => { saving.current = false; setBusy(false) })
  }, [chatId, draft, value, editable, onSaved, toast, t])

  if (failed) return <p role="alert">{failed}</p>
  if (effective === null) return null

  return (
    <div style={ROW_STYLE} data-testid="agent-flood-threshold-row" data-agent-flood-effective={effective}>
      <div>
        <div style={TITLE_STYLE}>{t('group.settings.agentFloodThreshold')}</div>
        <div style={HINT_STYLE}>
          {inherits
            ? t('group.settings.agentFloodThresholdInheritHint', { count: effective })
            : t('group.settings.agentFloodThresholdDefaultHint', { count: effective })}
        </div>
      </div>
      {editable ? (
        <input
          type="number"
          min={1}
          disabled={busy}
          inputMode="numeric"
          aria-label={t('group.settings.agentFloodThresholdAria')}
          data-testid="agent-flood-threshold-input"
          placeholder={String(effective)}
          value={draft ?? (value === null ? '' : String(value))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          style={INPUT_STYLE}
        />
      ) : (
        <span style={VALUE_STYLE}>{effective}</span>
      )}
    </div>
  )
}
