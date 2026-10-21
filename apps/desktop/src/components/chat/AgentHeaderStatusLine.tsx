import { useTranslation } from 'react-i18next'
import { Circle } from '@/lib/icons'
import { agentStatusColorVar } from '@gugu/core/shared/agentStatusPresentation'
import { localizedAgentHeaderStatus, type AgentHeaderStatus } from './chatPresentation'

/**
 * 单聊头栏「状态 · 位置 · 引擎」那一句。@@@6357 只表态不弹窗,近况统一走 working 栏的 MessagePreview。
 * agent 单聊里它不显示成字(AgentChatHero 只把它给读屏,状态由头像身体表达);其余形态仍画在头栏标题块里。
 */
export function AgentHeaderStatusLine({ peerId, presentation, location, engine, engineMissing }: AgentHeaderStatus) {
  const { t } = useTranslation('messaging')
  return (
    <span
      data-agent-status-surface="chat-header"
      data-agent-id={peerId}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--spacing-xs)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: (presentation ? agentStatusColorVar(presentation.tone) : null) ?? 'var(--muted-fg)', whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
    >
      {presentation ? <Circle size={6} fill="currentColor" strokeWidth={0} /> : null}
      {engineMissing ? (
        <span>
          {localizedAgentHeaderStatus(presentation?.label ?? null, location, null, t)}
          {' · '}
          {/* 引擎未知是「取不到元数据」的信息态而非错误态（web 端/无 runtime 时常态出现），
              红色会让用户以为出了故障；降为 muted，具体原因保留在 title。fail-loud 的
              console.error 仍在派生处（engineMissing），开发侧不失声。 */}
          <span style={{ color: 'var(--muted-fg)' }} title={t('chatArea.engineMissingTitle')}>{t('chatArea.engineMissing')}</span>
        </span>
      ) : (
        localizedAgentHeaderStatus(presentation?.label ?? null, location, engine, t)
      )}
    </span>
  )
}
